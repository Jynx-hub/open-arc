// Firestore cache reader: builds a tiny synthetic LevelDB (one table, one log) at test time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCloudModel, readCloudModel, readDocs, snappyDecompress } from '../src/firestore.js';
import { toBoostUserCss } from '../src/cloudFormats.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'arc-export.js');
const ARC_FIXTURE = path.join(HERE, 'fixtures', 'arc');

// --- protobuf / LevelDB writers (test-only) ---------------------------------------------------

const varint = (n) => {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};
const field = (n, bytes) => Buffer.concat([varint(n * 8 + 2), varint(bytes.length), bytes]);
const str = (s) => field(17, Buffer.from(s));
const bool = (b) => Buffer.concat([varint(1 * 8), varint(b ? 1 : 0)]);
const dbl = (x) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(x);
  return Buffer.concat([varint(3 * 8 + 1), b]);
};
const map = (obj) => field(6, Buffer.concat(Object.entries(obj).map(([k, v]) => field(1, Buffer.concat([field(1, Buffer.from(k)), field(2, v)])))));
const doc = (name, fields) =>
  // Wrapped like a cached remote document: the scanner has to find the Document inside.
  field(2, Buffer.concat([field(1, Buffer.from(`projects/p/databases/(default)/documents/${name}`)), ...Object.entries(fields).map(([k, v]) => field(2, Buffer.concat([field(1, Buffer.from(k)), field(2, v)])))]));

const internalKey = (key, seq, put = true) => {
  const trailer = Buffer.alloc(8);
  trailer.writeBigUInt64LE((BigInt(seq) << 8n) | (put ? 1n : 0n));
  return Buffer.concat([Buffer.from(key), trailer]);
};

/** A literal-only Snappy stream: valid and enough to exercise the decompressor. */
const snappyLiteral = (data) => {
  const out = [varint(data.length)];
  for (let i = 0; i < data.length; i += 60) {
    const chunk = data.subarray(i, i + 60);
    out.push(Buffer.from([(chunk.length - 1) << 2]), chunk);
  }
  return Buffer.concat(out);
};

function writeTable(file, entries) {
  const body = Buffer.concat(
    entries.map(([k, v]) => Buffer.concat([varint(0), varint(k.length), varint(v.length), k, v])),
  );
  const restarts = Buffer.alloc(8);
  restarts.writeUInt32LE(0, 0);
  restarts.writeUInt32LE(1, 4);
  const compressed = snappyLiteral(Buffer.concat([body, restarts]));
  const data = Buffer.concat([compressed, Buffer.from([1]), Buffer.alloc(4)]);
  const handle = Buffer.concat([varint(0), varint(compressed.length)]);
  const lastKey = entries[entries.length - 1][0];
  const indexBody = Buffer.concat([varint(0), varint(lastKey.length), varint(handle.length), lastKey, handle, restarts]);
  const indexOff = data.length;
  const index = Buffer.concat([indexBody, Buffer.from([0]), Buffer.alloc(4)]);
  const meta = Buffer.concat([Buffer.alloc(4), Buffer.from([0]), Buffer.alloc(4)]); // empty block, 0 restarts... plus count
  const metaOff = indexOff + index.length;
  const handles = Buffer.concat([varint(metaOff), varint(4), varint(indexOff), varint(indexBody.length)]);
  const footer = Buffer.concat([handles, Buffer.alloc(40 - handles.length), Buffer.from('57fb808b247547db', 'hex')]);
  fs.writeFileSync(file, Buffer.concat([data, index, meta, footer]));
}

function writeLog(file, seq, ops) {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(seq), 0);
  head.writeUInt32LE(ops.length, 8);
  const batch = Buffer.concat([
    head,
    ...ops.map(([k, v]) => (v ? Buffer.concat([Buffer.from([1]), varint(k.length), Buffer.from(k), varint(v.length), v]) : Buffer.concat([Buffer.from([0]), varint(k.length), Buffer.from(k)]))),
  ]);
  // Split into FIRST + LAST fragments so multi-fragment records are covered.
  const half = Math.floor(batch.length / 2);
  const frag = (type, payload) => {
    const h = Buffer.alloc(7);
    h.writeUInt16LE(payload.length, 4);
    h[6] = type;
    return Buffer.concat([h, payload]);
  };
  fs.writeFileSync(file, Buffer.concat([frag(2, batch.subarray(0, half)), frag(4, batch.subarray(half))]));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-fixture-'));
  const dir = path.join(root, 'proj', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const boostData = JSON.stringify({ colorScheme: { colorWheelDriven: { _0: { primaryHueDegrees: 200, primarySaturation: 0.5, secondaryHueOffset: 45, invertLightness: false, baseAppearance: { dark: {} } } } }, zaps: [] });
  const boost = (active) => doc('boosts/B1', { hostPattern: str('docs.example.com'), isActive: str(String(active)), title: str(''), data: str(boostData), featuresUsed: field(9, field(1, str('colorScheme'))) });
  writeTable(path.join(dir, '000005.ldb'), [
    [internalKey('remote_document/boosts/B1', 5), boost(true)],
    [internalKey('remote_document/boosts/B2', 6), doc('boosts/B2', { hostPattern: str('gone.example.com'), isActive: str('true') })],
    [internalKey('remote_document/users/U1', 7), doc('users/U1', { displayName: str('secret-name') })],
  ]);
  writeLog(path.join(dir, '000009.log'), 10, [
    ['remote_document/easels/E1', doc('easels/E1', { title: str('Plan'), palette: str('default') })],
    ['remote_document/easels/E1/objects/O2', doc('easels/E1/objects/O2', { position: map({ rect: map({ x: dbl(5), y: dbl(6), width: dbl(100), height: dbl(20) }), zIndex: dbl(2) }), content: map({ text: map({ string: str('second') }) }) })],
    ['remote_document/easels/E1/objects/O1', doc('easels/E1/objects/O1', { position: map({ rect: map({ x: dbl(1), y: dbl(2), width: dbl(50), height: dbl(10) }), zIndex: dbl(1) }), content: map({ text: map({ string: str('first') }) }), addedInfo: map({ participant: map({ name: str('secret-name') }) }) })],
    ['remote_document/easels/E1/memberships/U1', doc('easels/E1/memberships/U1', { userID: str('secret-name') })],
    ['remote_document/boosts/B1', boost(false)],
    ['remote_document/boosts/B2', null],
    // An unsynced local edit: ignored.
    ['mutation/1', doc('boosts/B3', { hostPattern: str('pending.example.com'), isActive: str('true') })],
  ]);
  return root;
}

// --- tests ---------------------------------------------------------------------------------

test('snappy: literals and back-references', () => {
  assert.equal(snappyDecompress(Buffer.from([9, 8, 0x61, 0x62, 0x63, 9, 3])).toString(), 'abcabcabc');
});

test('reads boosts and easels; newest write wins and deletions apply', () => {
  const root = fixture();
  const model = readCloudModel(root);
  assert.equal(model.boosts.length, 1);
  const [b] = model.boosts;
  assert.equal(b.host, 'docs.example.com');
  assert.equal(b.enabled, false);
  assert.deepEqual(b.features, ['colorScheme']);
  assert.deepEqual(b.colorScheme, { hue: 200, saturation: 0.5, secondaryHueOffset: 45, invertLightness: false, appearance: 'dark' });
  assert.equal(model.easels.length, 1);
  assert.deepEqual(model.easels[0].objects.map((o) => [o.text, o.rect.width, o.z]), [['first', 50, 1], ['second', 100, 2]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('never reads users, memberships or who added an object', () => {
  const root = fixture();
  const docs = readDocs(path.join(root, 'proj', 'main'));
  assert.ok(docs.every((d) => d.path[0] !== 'users' && d.path[2] !== 'memberships'));
  assert.ok(!JSON.stringify(buildCloudModel(docs)).includes('secret-name'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('leaves the source directory untouched', () => {
  const root = fixture();
  const dir = path.join(root, 'proj', 'main');
  fs.writeFileSync(path.join(dir, 'LOCK'), '');
  const before = fs.readdirSync(dir).sort();
  readCloudModel(root);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  fs.rmSync(root, { recursive: true, force: true });
});

test('boost userstyle carries the recolor and stays scoped to its host', () => {
  const root = fixture();
  const [boost] = readCloudModel(root).boosts;
  const css = toBoostUserCss(boost);
  assert.match(css, /@-moz-document domain\("docs\.example\.com"\)/);
  assert.match(css, /hsl\(200 50% 50%\), hsl\(245 50% 50%\)/);
  assert.match(css, /turned off in Arc/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('cli writes boosts and easels folders', () => {
  const root = fixture();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-export-'));
  execFileSync(process.execPath, [CLI, '--arc-dir', ARC_FIXTURE, '--firestore-dir', root, '--format', 'boosts,easels', '--out', out], { stdio: 'pipe' });
  assert.deepEqual(fs.readdirSync(path.join(out, 'arc-boosts')), ['docs.example.com.user.css']);
  assert.deepEqual(fs.readdirSync(path.join(out, 'arc-easels')).sort(), ['Plan.json', 'Plan.svg']);
  const svg = fs.readFileSync(path.join(out, 'arc-easels', 'Plan.svg'), 'utf8');
  assert.match(svg, /first[\s\S]*second/);
  for (const dir of ['arc-boosts', 'arc-easels'])
    for (const f of fs.readdirSync(path.join(out, dir))) assert.doesNotMatch(fs.readFileSync(path.join(out, dir, f), 'utf8'), /secret-name/);
  fs.rmSync(out, { recursive: true });
  fs.rmSync(root, { recursive: true, force: true });
});

