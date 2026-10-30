// Profile → Electron session. Each Profile has its own persistent cookies, storage and cache.
import { session, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import type { State } from '../shared/model';
import { rootOf } from '../shared/tree';

/**
 * Test runs stay out of the user's way: windows are invisible and never take focus, the app stays out of
 * the Dock, and a fullscreen page fills its window without taking the whole screen.
 */
export const QUIET = process.env.OPEN_ARC_QUIET === '1';

export interface SessionOptions {
  /** A Profile id, or the partition name of a private session. */
  profileId: string;
  /** Private (incognito) sessions keep nothing: no saved permission answers, no download list on disk. */
  private: boolean;
}

const configured = new Set<string>();
let setup: ((ses: Session, opts: SessionOptions) => void) | null = null;

/** Per-session wiring that needs the app's services (downloads, permissions). Set once, before any window opens. */
export function setSessionSetup(fn: (ses: Session, opts: SessionOptions) => void) {
  setup = fn;
}

/** The wiring every session gets, Profile or private. */
function configureSession(ses: Session, opts: SessionOptions) {
  // Some sites refuse unfamiliar browsers; present a plain Chrome user agent.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|open-arc-browser)\/\S+/g, ''));
  setup?.(ses, opts);
}

export function partitionFor(profileId: string): string {
  return `persist:profile-${profileId}`;
}

/** The Profile a `partitionFor` name belongs to, or null for any other partition. */
export function profileOfPartition(partition: string): string | null {
  return partition.startsWith('persist:profile-') ? partition.slice('persist:profile-'.length) : null;
}

export function sessionFor(profileId: string): Session {
  const partition = partitionFor(profileId);
  const ses = session.fromPartition(partition);
  if (!configured.has(partition)) {
    configured.add(partition);
    configureSession(ses, { profileId, private: false });
  }
  return ses;
}

/** A fresh in-memory session for one private window. Without the `persist:` prefix nothing reaches disk. */
export function privateSession(): { ses: Session; partition: string } {
  const partition = `incognito-${randomUUID()}`;
  const ses = session.fromPartition(partition);
  configureSession(ses, { profileId: partition, private: true });
  return { ses, partition };
}

/** The Profile an item's page should load in: its Space's Profile, or the Favorites row's owner. */
export function profileOfItem(state: State, itemId: string): string | null {
  const root = rootOf(state, itemId)?.root;
  if (!root) return null;
  if (root.kind === 'favorites') return root.profileId ?? null;
  return state.spaces.find((s) => s.id === root.spaceId)?.profileId ?? null;
}

/** Permanently deletes a Profile's browsing data (cookies, history, logins). */
export async function clearProfileData(profileId: string) {
  const ses = session.fromPartition(partitionFor(profileId));
  await ses.clearStorageData();
  await ses.clearCache();
}
