// @ts-check
// Reads Boosts and Easels from Arc's Firestore offline cache. See spec/formats/cloud-cache.md.
// The cache is a LevelDB database; values are protobufs that embed google.firestore.v1.Document messages.
// Zero dependencies: a minimal LevelDB table/log reader, a Snappy decompressor and a protobuf scanner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The only documents ever decoded. `users`, `sync`, `preferences` and Easel `memberships` hold
 * account data and other people's names, so their fields are never read.
 * Top-level collection → allowed subcollections.
 */
const ALLOWED = /** @type {const} */ ({ boosts: [], easels: ['objects'] });

export const DEFAULT_FIRESTORE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'firestore', 'Arc');

/**
 * @typedef {{ path: string[], fields: Record<string, any> }} CloudDoc
 * @typedef {{ hue: number, saturation: number, secondaryHueOffset: number, invertLightness: boolean, appearance: string | null }} ColorScheme
 * @typedef {{ id: string, host: string, enabled: boolean, name: string, createdAt: Date | null, modifiedAt: Date | null,
 *   features: string[], colorScheme: ColorScheme | null, zaps: any[], settings: Record<string, any> }} Boost
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ id: string, rect: Rect, z: number, kind: string, text?: string, style?: Record<string, any> }} EaselObject
 * @typedef {{ id: string, title: string, palette: string | null, shareStatus: string | null, modifiedAt: Date | null, objects: EaselObject[] }} Easel
 * @typedef {{ boosts: Boost[], easels: Easel[] }} CloudModel
 */

// ---------------------------------------------------------------------------------------------
// Varints, Snappy, LevelDB

/** @returns {[number, number]} value, next offset. Exact up to 2^53. */
function varint(b, i) {
  let r = 0;
  let mul = 1;
  for (;;) {
    const c = b[i++];
    if (c === undefined) throw new RangeError('truncated varint');
    r += (c & 0x7f) * mul;
    if (c < 0x80) return [r, i];
    mul *= 128;
  }
}

/** @returns {[bigint, number]} */
function varint64(b, i) {
  let r = 0n;
  let shift = 0n;
  for (;;) {
    const c = b[i++];
    if (c === undefined) throw new RangeError('truncated varint');
    r |= BigInt(c & 0x7f) << shift;
    if (c < 0x80) return [r, i];
    shift += 7n;
  }
}

/** Raw Snappy block decompression (the format LevelDB uses for compressed blocks). */
export function snappyDecompress(buf) {
  let [len, i] = varint(buf, 0);
  const out = Buffer.alloc(len);
  let o = 0;
  while (i < buf.length) {
    const tag = buf[i++];
    const type = tag & 3;
    if (type === 0) {
      let l = tag >> 2;
      if (l >= 60) {
        const n = l - 59;
        l = 0;
        for (let k = 0; k < n; k++) l += buf[i++] * 2 ** (8 * k);
      }
      l += 1;
      buf.copy(out, o, i, i + l);
      i += l;
      o += l;
      continue;
    }
    let l;
    let off;
    if (type === 1) {
      l = ((tag >> 2) & 7) + 4;
      off = ((tag >> 5) << 8) | buf[i++];
    } else if (type === 2) {
      l = (tag >> 2) + 1;
      off = buf.readUInt16LE(i);
      i += 2;
    } else {
      l = (tag >> 2) + 1;
      off = buf.readUInt32LE(i);
      i += 4;
    }
    if (off === 0 || off > o) throw new RangeError('bad snappy offset');
    for (let k = 0; k < l; k++, o++) out[o] = out[o - off];
  }
  if (o !== len) throw new RangeError('snappy length mismatch');
  return out;
}

/**
 * Entries of a LevelDB table (.ldb/.sst).
 * @returns {Generator<{ key: Buffer, seq: number, put: boolean, value: Buffer }>}
 */
function* tableEntries(data) {
  const footer = data.subarray(data.length - 48);
  let [, i] = varint(footer, 0);
  [, i] = varint(footer, i);
  const [indexOff, j] = varint(footer, i);
  const [indexSize] = varint(footer, j);

  const block = (off, size) => {
    const raw = data.subarray(off, off + size);
    return data[off + size] === 1 ? snappyDecompress(raw) : raw;
  };
  function* entries(blk) {
    const restarts = blk.readUInt32LE(blk.length - 4);
    const end = blk.length - 4 - 4 * restarts;
    let k = 0;
    let key = Buffer.alloc(0);
    while (k < end) {
      let shared, own, vlen;
      [shared, k] = varint(blk, k);
      [own, k] = varint(blk, k);
      [vlen, k] = varint(blk, k);
      key = Buffer.concat([key.subarray(0, shared), blk.subarray(k, k + own)]);
      k += own;
      yield { key, value: blk.subarray(k, k + vlen) };
      k += vlen;
    }
  }
  for (const { value: handle } of entries(block(indexOff, indexSize))) {
    const [off, n] = varint(handle, 0);
    const [size] = varint(handle, n);
    for (const { key, value } of entries(block(off, size))) {
      // Internal key = user key + 8-byte trailer (sequence << 8 | type), little-endian.
      const low = key.readUInt32LE(key.length - 8);
      const high = key.readUInt32LE(key.length - 4);
      yield { key: key.subarray(0, key.length - 8), seq: Math.floor((high * 2 ** 32 + low) / 256), put: (low & 0xff) === 1, value };
    }
  }
}

/**
 * Entries of a LevelDB write-ahead log (.log): 32 KiB blocks of fragmented records, each a write batch.
 * @returns {Generator<{ key: Buffer, seq: number, put: boolean, value: Buffer }>}
 */
function* logEntries(data) {
  /** @type {Buffer[]} */
  const records = [];
  /** @type {Buffer[]} */
  let parts = [];
  let i = 0;
  while (i + 7 <= data.length) {
    const left = 32768 - (i % 32768);
    if (left < 7) {
      i += left;
      continue;
    }
    const len = data.readUInt16LE(i + 4);
    const type = data[i + 6];
    const payload = data.subarray(i + 7, i + 7 + len);
    i += 7 + len;
    if (type === 0) break; // preallocated, unwritten space
    if (type === 1) records.push(payload); // FULL
    else if (type === 2) parts = [payload]; // FIRST
    else if (type === 3) parts.push(payload); // MIDDLE
    else if (type === 4) records.push(Buffer.concat([...parts, payload])); // LAST
  }
  for (const rec of records) {
    let seq = Number(rec.readBigUInt64LE(0));
    let k = 12;
    while (k < rec.length) {
      const tag = rec[k++];
      let klen;
      [klen, k] = varint(rec, k);
      const key = rec.subarray(k, k + klen);
      k += klen;
      if (tag === 1) {
        let vlen;
        [vlen, k] = varint(rec, k);
        yield { key, seq, put: true, value: rec.subarray(k, k + vlen) };
        k += vlen;
      } else {
        yield { key, seq, put: false, value: Buffer.alloc(0) };
      }
      seq += 1;
    }
  }
}

/** Live values of a LevelDB directory: for each key the newest entry wins, and deletions remove it. */
function liveValues(dir) {
  /** @type {Map<string, { seq: number, put: boolean, value: Buffer }>} */
  const latest = new Map();
  for (const name of fs.readdirSync(dir)) {
    const ext = path.extname(name);
    if (ext !== '.ldb' && ext !== '.sst' && ext !== '.log') continue;
    const data = fs.readFileSync(path.join(dir, name));
    try {
      for (const e of ext === '.log' ? logEntries(data) : tableEntries(data)) {
        const key = e.key.toString('latin1');
        const prev = latest.get(key);
        if (!prev || e.seq >= prev.seq) latest.set(key, e);
      }
    } catch {
      // A damaged or half-written file: skip it rather than fail the whole export.
    }
  }
  return [...latest].filter(([, e]) => e.put).sort(([, a], [, b]) => a.seq - b.seq).map(([key, e]) => ({ key, ...e }));
}

// ---------------------------------------------------------------------------------------------
// Protobuf → Firestore documents

/** @returns {{ n: number, t: number, v: any }[]} Throws if `b` isn't a well-formed message. */
function fields(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    let k;
    [k, i] = varint(b, i);
    const n = Math.floor(k / 8);
    const t = k % 8;
    if (n === 0) throw new RangeError('field 0');
    let v;
    if (t === 0) [v, i] = varint64(b, i);
    else if (t === 1) (v = b.subarray(i, i + 8)), (i += 8);
    else if (t === 2) {
      let l;
      [l, i] = varint(b, i);
      v = b.subarray(i, i + l);
      i += l;
    } else if (t === 5) (v = b.subarray(i, i + 4)), (i += 4);
    else throw new RangeError('wire type');
    if (i > b.length) throw new RangeError('truncated');
    out.push({ n, t, v });
  }
  return out;
}

/** google.firestore.v1.Value → plain JS. */
function value(b) {
  for (const { n, v } of fields(b)) {
    switch (n) {
      case 11: return null;
      case 1: return v !== 0n;
      case 2: return Number(BigInt.asIntN(64, v));
      case 3: return v.readDoubleLE(0);
      case 10: {
        const ts = fields(v);
        const s = Number(BigInt.asIntN(64, ts.find((f) => f.n === 1)?.v ?? 0n));
        const ns = Number(ts.find((f) => f.n === 2)?.v ?? 0n);
        return new Date(s * 1000 + Math.floor(ns / 1e6));
      }
      case 17: return v.toString('utf8');
      case 18: return { bytes: v.length };
      case 5: return { reference: v.toString('utf8') };
      case 9: return fields(v).filter((f) => f.n === 1).map((f) => value(f.v));
      case 6: return mapValue(v);
    }
  }
  return null;
}

function mapValue(b) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const { n, v } of fields(b)) {
    if (n !== 1) continue;
    const entry = fields(v);
    const key = entry.find((f) => f.n === 1)?.v;
    const val = entry.find((f) => f.n === 2)?.v;
    if (key) out[key.toString('utf8')] = val ? value(val) : null;
  }
  return out;
}

/** The document path relative to `/documents/`, if it is one we may read. */
function allowedPath(name) {
  const at = name.indexOf('/documents/');
  if (!name.startsWith('projects/') || at < 0) return null;
  const segs = name.slice(at + '/documents/'.length).split('/');
  const subs = /** @type {readonly string[] | undefined} */ (ALLOWED[/** @type {keyof typeof ALLOWED} */ (segs[0])]);
  if (!subs) return null;
  if (segs.length === 2) return segs;
  if (segs.length === 4 && subs.includes(segs[2])) return segs;
  return null;
}

/** Finds embedded Document messages (name = field 1, fields = field 2) anywhere inside `b`. */
function scanDocs(b, out, depth = 0) {
  if (depth > 6) return;
  let fs_;
  try {
    fs_ = fields(b);
  } catch {
    return;
  }
  const first = fs_[0];
  if (first && first.n === 1 && first.t === 2 && first.v.includes('/documents/')) {
    const segs = allowedPath(first.v.toString('utf8'));
    if (!segs) return;
    /** @type {Record<string, any>} */
    const doc = {};
    try {
      for (const { n, t, v } of fs_.slice(1)) {
        if (n !== 2 || t !== 2) continue;
        const entry = fields(v);
        const key = entry.find((f) => f.n === 1)?.v;
        const val = entry.find((f) => f.n === 2)?.v;
        if (key) doc[key.toString('utf8')] = val ? value(val) : null;
      }
    } catch {
      return;
    }
    out.push({ path: segs, fields: doc });
    return;
  }
  for (const { t, v } of fs_) if (t === 2 && v.length > 8) scanDocs(v, out, depth + 1);
}

/**
 * Allowed documents in a Firestore LevelDB directory (`…/<project>/main`). Only the SDK's cached server
 * copies (`remote_document` keys) are read, each whole: a deleted document is stored there without a
 * Document message, so it drops out. Unsynced local edits (the mutation queue) are deliberately ignored.
 * @returns {CloudDoc[]}
 */
export function readDocs(leveldbDir) {
  /** @type {Map<string, CloudDoc>} */
  const docs = new Map();
  for (const { key, value } of liveValues(leveldbDir)) {
    if (!key.includes('remote_document')) continue;
    /** @type {CloudDoc[]} */
    const found = [];
    scanDocs(value, found);
    for (const d of found) docs.set(d.path.join('/'), d);
  }
  return [...docs.values()].filter((d) => Object.keys(d.fields).length > 0);
}

/** `…/firestore/Arc/<project>/main` directories under `root`. */
export function findCaches(root = DEFAULT_FIRESTORE_DIR) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((p) => path.join(root, p, 'main'))
    .filter((p) => fs.existsSync(p));
}

/**
 * Copies each cache to a temp dir (Arc holds the live one's LOCK), reads it, and removes the copy.
 * @returns {CloudDoc[]}
 */
export function readCloudDocs(root = DEFAULT_FIRESTORE_DIR) {
  const out = [];
  for (const dir of findCaches(root)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-export-fs-'));
    try {
      fs.cpSync(dir, tmp, { recursive: true });
      fs.rmSync(path.join(tmp, 'LOCK'), { force: true });
      out.push(...readDocs(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Documents → model

const isoDate = (s) => (typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? new Date(s) : s instanceof Date ? s : null);

/** @returns {ColorScheme | null} */
function colorScheme(settings) {
  const wheel = settings?.colorScheme?.colorWheelDriven?._0;
  if (!wheel || typeof wheel.primaryHueDegrees !== 'number') return null;
  const base = wheel.baseAppearance && typeof wheel.baseAppearance === 'object' ? Object.keys(wheel.baseAppearance)[0] ?? null : null;
  return {
    hue: wheel.primaryHueDegrees,
    saturation: typeof wheel.primarySaturation === 'number' ? wheel.primarySaturation : 1,
    secondaryHueOffset: typeof wheel.secondaryHueOffset === 'number' ? wheel.secondaryHueOffset : 0,
    invertLightness: wheel.invertLightness === true,
    appearance: base,
  };
}

/** @param {CloudDoc[]} docs @returns {CloudModel} */
export function buildCloudModel(docs) {
  /** @type {Boost[]} */
  const boosts = [];
  /** @type {Map<string, Easel>} */
  const easels = new Map();
  /** @type {Map<string, EaselObject[]>} */
  const objects = new Map();

  for (const { path: p, fields: f } of docs) {
    if (p[0] === 'boosts' && p.length === 2 && typeof f.hostPattern === 'string') {
      /** @type {Record<string, any>} */
      let settings = {};
      try {
        settings = typeof f.data === 'string' ? JSON.parse(f.data) : {};
      } catch {}
      boosts.push({
        id: p[1],
        host: f.hostPattern,
        enabled: f.isActive === true || f.isActive === 'true',
        name: typeof f.title === 'string' ? f.title : '',
        createdAt: isoDate(f.createdDate),
        modifiedAt: isoDate(f.lastModified),
        features: Array.isArray(f.featuresUsed) ? f.featuresUsed.filter((x) => typeof x === 'string') : [],
        colorScheme: colorScheme(settings),
        zaps: Array.isArray(settings.zaps) ? settings.zaps : [],
        settings,
      });
    } else if (p[0] === 'easels' && p.length === 2) {
      easels.set(p[1], {
        id: p[1],
        title: typeof f.title === 'string' ? f.title : '',
        palette: typeof f.palette === 'string' ? f.palette : null,
        shareStatus: typeof f.shareStatus === 'string' ? f.shareStatus : null,
        modifiedAt: isoDate(f.lastModified),
        objects: [],
      });
    } else if (p[0] === 'easels' && p[2] === 'objects') {
      const r = f.position?.rect ?? {};
      const num = (x) => (typeof x === 'number' ? x : 0);
      const contentCase = f.content && typeof f.content === 'object' ? Object.keys(f.content)[0] ?? 'unknown' : 'unknown';
      /** @type {EaselObject} */
      const obj = { id: p[3], rect: { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) }, z: num(f.position?.zIndex), kind: contentCase };
      if (contentCase === 'text') {
        obj.text = typeof f.content.text?.string === 'string' ? f.content.text.string : '';
        obj.style = f.content.text?.style ?? {};
      }
      // `addedInfo` (who added the object) is deliberately left out.
      objects.set(p[1], [...(objects.get(p[1]) ?? []), obj]);
    }
  }
  for (const [id, objs] of objects) {
    const easel = easels.get(id);
    if (easel) easel.objects = objs.sort((a, b) => a.z - b.z);
  }
  boosts.sort((a, b) => a.host.localeCompare(b.host));
  return { boosts, easels: [...easels.values()] };
}

/** @returns {CloudModel} */
export function readCloudModel(root = DEFAULT_FIRESTORE_DIR) {
  return buildCloudModel(readCloudDocs(root));
}
