// Profile → Electron session. Each Profile has its own persistent cookies, storage and cache.
import { session, type Session } from 'electron';
import type { State } from '../shared/model';
import { rootOf } from '../shared/tree';

const configured = new Set<string>();
let setup: ((ses: Session, profileId: string) => void) | null = null;

/** Per-session wiring that needs the app's services (downloads, permissions). Set once, before any window opens. */
export function setSessionSetup(fn: (ses: Session, profileId: string) => void) {
  setup = fn;
}

export function partitionFor(profileId: string): string {
  return `persist:profile-${profileId}`;
}

export function sessionFor(profileId: string): Session {
  const partition = partitionFor(profileId);
  const ses = session.fromPartition(partition);
  if (!configured.has(partition)) {
    configured.add(partition);
    // Some sites refuse unfamiliar browsers; present a plain Chrome user agent.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|open-arc-browser)\/\S+/g, ''));
    setup?.(ses, profileId);
  }
  return ses;
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
