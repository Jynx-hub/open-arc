// Site permission policy. A few harmless permissions are always granted, a known set asks the user
// (and can be remembered per origin), and everything else is refused.
import type { PermissionDecision } from './model';

export type SavedPermissions = Record<string, Record<string, PermissionDecision>>;

/**
 * Granted without asking: harmless, or already gated by a user action (a file picker for `fileSystem`,
 * fullscreen for `keyboardLock`). Chromium doesn't prompt for these either.
 */
export const AUTO_ALLOW = new Set([
  'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock', 'fileSystem', 'mediaKeySystem',
  'screen-wake-lock', 'persistent-storage', 'background-sync', 'background-fetch', 'periodic-background-sync',
]);

/** The keys we ask about (and save), with what the prompt says the site wants to do. */
export const PROMPTED: Record<string, string> = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  'clipboard-read': 'see what you copy',
  'idle-detection': 'know when you’re away',
  'display-capture': 'see your screen',
  openExternal: 'open another app',
};

/**
 * Electron's permission name (plus, for `media`, the requested types) → the keys we decide and save.
 * Camera and microphone are separate keys, so allowing one doesn't allow the other.
 */
export function permissionKeys(permission: string, mediaTypes?: string[]): string[] {
  switch (permission) {
    case 'media': {
      const keys = (mediaTypes ?? []).map((t) => (t === 'video' ? 'camera' : t === 'audio' ? 'microphone' : '')).filter(Boolean);
      return keys.length ? [...new Set(keys)] : ['camera', 'microphone'];
    }
    case 'geolocation-approximate': return ['geolocation'];
    case 'midiSysex': return ['midi'];
    default: return [permission];
  }
}

/** What to do with a request, given the saved answers. Several keys (camera + microphone) need all to be allowed. */
export function decide(saved: SavedPermissions, origin: string, keys: string[]): 'allow' | 'deny' | 'ask' {
  if (!keys.length) return 'deny';
  if (keys.every((k) => AUTO_ALLOW.has(k))) return 'allow';
  if (keys.some((k) => !AUTO_ALLOW.has(k) && !(k in PROMPTED))) return 'deny';
  const site = saved[origin] ?? {};
  const asked = keys.filter((k) => !AUTO_ALLOW.has(k));
  if (asked.some((k) => site[k] === 'deny')) return 'deny';
  if (asked.every((k) => site[k] === 'allow')) return 'allow';
  return 'ask';
}

/** The origin a permission belongs to. Opaque origins (`about:blank`, `data:`) get none and are refused. */
export function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o && o !== 'null' ? o : null;
  } catch {
    return null;
  }
}

export function describePermission(key: string): string {
  return PROMPTED[key] ?? key;
}
