// @ts-check
// Reading Arc's on-disk files. See spec/formats/README.md for the conventions decoded here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_ARC_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Arc');

/**
 * The only files arc-export ever opens. Account secrets (StorableAuthState,
 * StorableFirebaseEncryptionKey) and everything else are never read.
 */
export const ALLOWED_FILES = Object.freeze({
  sidebar: 'StorableSidebar.json',
  archive: 'StorableArchiveItems.json',
  linkRouting: 'StorableLinkRouting.json',
});

/** Seconds between the Unix epoch and Apple's reference date (2001-01-01T00:00:00Z). */
const APPLE_EPOCH_OFFSET = 978307200;

/** @param {number | null | undefined} t Apple-epoch seconds */
export function appleTimeToDate(t) {
  return typeof t === 'number' ? new Date((t + APPLE_EPOCH_OFFSET) * 1000) : null;
}

/**
 * Pair up a keyed array `[k1, v1, k2, v2, …]`.
 * @template K, V
 * @param {unknown} arr
 * @returns {Array<[K, V]>}
 */
export function pairs(arr) {
  if (!Array.isArray(arr)) return [];
  /** @type {Array<[K, V]>} */
  const out = [];
  for (let i = 0; i + 1 < arr.length; i += 2) out.push([arr[i], arr[i + 1]]);
  return out;
}

/**
 * Case name of a single-key enum object: `{"pinned": {}}` → `"pinned"`.
 * Plain strings (older encodings) are returned as-is.
 * @param {unknown} value
 */
export function enumCase(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return Object.keys(value)[0] ?? null;
  return null;
}

/**
 * Payload of an enum case: `{"space": {"_0": "id"}}` → `"id"`.
 * @param {unknown} value
 */
export function enumPayload(value) {
  const name = enumCase(value);
  if (!name || typeof value !== 'object' || value === null) return undefined;
  const inner = /** @type {Record<string, any>} */ (value)[name];
  return inner && typeof inner === 'object' && '_0' in inner ? inner._0 : inner;
}

/**
 * @param {string} arcDir
 * @param {keyof typeof ALLOWED_FILES} which
 * @returns {any | null} parsed JSON, or null when the file does not exist
 */
export function readArcFile(arcDir, which) {
  const file = path.join(arcDir, ALLOWED_FILES[which]);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
