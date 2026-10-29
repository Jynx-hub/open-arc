// Site permission requests from every Profile's session. Saved answers and the always-allowed set
// decide most requests at once; the rest wait in a per-page queue until the user answers the prompt.
import { systemPreferences, type PermissionCheckHandlerHandlerDetails, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { PermissionPrompt } from '../shared/ipc';
import { decide, originOf, permissionKeys } from '../shared/permissions';
import type { Store } from './store';

interface Pending extends PermissionPrompt {
  wc: WebContents;
  resolve(granted: boolean): void;
}

export interface PermissionHooks {
  /** The prompt shown for `wc` changed. */
  changed(wc: WebContents): void;
  /** Camera or microphone was granted to `wc`. */
  capturing(wc: WebContents, keys: string[]): void;
}

const MEDIA = ['camera', 'microphone'] as const;

export class Permissions {
  private queues = new Map<WebContents, Pending[]>();
  private watched = new WeakSet<WebContents>();

  constructor(private store: Store, private hooks: PermissionHooks) {}

  request(wc: WebContents, permission: string, callback: (granted: boolean) => void, details: { requestingUrl?: string; mediaTypes?: string[] }) {
    let fired = false;
    const resolve = (granted: boolean) => {
      if (fired) return;
      fired = true;
      callback(granted);
    };
    const origin = originOf(details.requestingUrl || wc.getURL());
    const keys = permissionKeys(permission, details.mediaTypes);
    const decision = decide(this.store.state.settings.sitePermissions, origin ?? '', keys);
    if (decision === 'allow') return void this.grant(wc, keys, resolve);
    if (decision === 'deny' || !origin) return resolve(false);

    this.watch(wc);
    const queue = this.queues.get(wc) ?? [];
    queue.push({ id: randomUUID(), wc, origin, keys, resolve });
    this.queues.set(wc, queue);
    if (queue.length === 1) this.hooks.changed(wc);
  }

  /** Synchronous checks (`navigator.permissions.query`, feature detection) see only what is already allowed. */
  check(permission: string, requestingOrigin: string, details: PermissionCheckHandlerHandlerDetails): boolean {
    const media = details.mediaType && details.mediaType !== 'unknown' ? [details.mediaType] : undefined;
    return decide(this.store.state.settings.sitePermissions, originOf(requestingOrigin) ?? '', permissionKeys(permission, media)) === 'allow';
  }

  /** The prompt to show for a window: the first page in `wcs` (most important first) with a request waiting. */
  promptFor(wcs: WebContents[]): PermissionPrompt | null {
    for (const wc of wcs) {
      const first = this.queues.get(wc)?.[0];
      if (first) return { id: first.id, origin: first.origin, keys: first.keys };
    }
    return null;
  }

  /** Saved answers changed elsewhere (Settings, the site panel): requests they now decide stop waiting. */
  recheck() {
    for (const [wc, queue] of [...this.queues]) this.settle(wc, queue);
  }

  respond(id: string, answer: 'allow' | 'once' | 'block') {
    for (const [wc, queue] of this.queues) {
      const answered = queue.find((p) => p.id === id);
      if (!answered) continue;
      if (answer !== 'once') {
        for (const key of answered.keys) {
          this.store.dispatch({ type: 'sitePermission.set', origin: answered.origin, permission: key, decision: answer === 'allow' ? 'allow' : 'deny' });
        }
      }
      // The same question asked again while the prompt was up gets the same answer.
      const same = (p: Pending) => p.origin === answered.origin && p.keys.join() === answered.keys.join();
      const rest = queue.filter((p) => !same(p));
      for (const p of queue.filter(same)) {
        if (answer === 'block') p.resolve(false);
        else void this.grant(wc, p.keys, p.resolve);
      }
      this.settle(wc, rest);
      return;
    }
  }

  /** Re-check the waiting requests against saved answers; the first one still undecided becomes the prompt. */
  private settle(wc: WebContents, queue: Pending[]) {
    const saved = this.store.state.settings.sitePermissions;
    const waiting: Pending[] = [];
    for (const p of queue) {
      const d = decide(saved, p.origin, p.keys);
      if (d === 'ask') waiting.push(p);
      else if (d === 'allow') void this.grant(wc, p.keys, p.resolve);
      else p.resolve(false);
    }
    if (waiting.length) this.queues.set(wc, waiting);
    else this.queues.delete(wc);
    this.hooks.changed(wc);
  }

  private async grant(wc: WebContents, keys: string[], resolve: (granted: boolean) => void) {
    const media = MEDIA.filter((k) => keys.includes(k));
    // macOS asks once per app for the camera and microphone, on top of the site's permission.
    // TODO(packaging): NSCameraUsageDescription / NSMicrophoneUsageDescription in Info.plist.
    let ok = true;
    if (process.platform === 'darwin') {
      for (const k of media) ok = (await systemPreferences.askForMediaAccess(k).catch(() => false)) && ok;
    }
    resolve(ok);
    if (ok && media.length && !wc.isDestroyed()) this.hooks.capturing(wc, media);
  }

  /** A page that navigates away or closes takes its unanswered prompts with it. */
  private watch(wc: WebContents) {
    if (this.watched.has(wc)) return;
    this.watched.add(wc);
    const drop = () => {
      const queue = this.queues.get(wc);
      if (!queue) return;
      this.queues.delete(wc);
      for (const p of queue) p.resolve(false);
      if (!wc.isDestroyed()) this.hooks.changed(wc);
    };
    wc.on('did-navigate', drop);
    wc.once('destroyed', drop);
  }
}
