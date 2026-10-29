// Downloads: every Profile's session hands its `DownloadItem`s here. The list lives in State (so it
// survives restarts); the live items stay in a Map so the UI can pause, resume and cancel them.
import { app, shell, type DownloadItem, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DownloadOp } from '../shared/ipc';
import type { DownloadEntry } from '../shared/model';
import { uniqueFilename } from '../shared/files';
import { sessionFor } from './profiles';
import type { Store } from './store';

export type DownloadProgress = Record<string, { receivedBytes: number; totalBytes: number }>;

export interface DownloadHooks {
  completed(entry: DownloadEntry): void;
  /** Byte counts moved. They go to the UI on a timer, not through State, so progress never touches the saved file. */
  progress(): void;
}

export class Downloads {
  private items = new Map<string, DownloadItem>();
  /** Live byte counts of running downloads; State holds them only at start, on status changes and at the end. */
  readonly progress = new Map<string, { receivedBytes: number; totalBytes: number }>();
  /** URLs whose next download asks where to save (Save Link As…, Save Image As…). */
  private askFor = new Set<string>();

  constructor(private store: Store, private hooks: DownloadHooks) {
    // Downloads still running when the app last quit were cut off.
    for (const d of store.state.downloads) {
      if (d.state === 'progressing') store.dispatch({ type: 'download.upsert', entry: { ...d, state: 'interrupted', paused: false, endedAt: d.endedAt ?? Date.now() } });
    }
  }

  dir(): string {
    return process.env.OPEN_ARC_DOWNLOADS_DIR || app.getPath('downloads');
  }

  /** Download `url` from `wc`'s page, asking where to save it. */
  saveAs(wc: WebContents, url: string) {
    this.askFor.add(url);
    wc.downloadURL(url);
  }

  track(item: DownloadItem, profileId: string, isPrivate = false) {
    const id = randomUUID();
    const url = item.getURL();
    const dir = this.dir();
    // Match on the first URL of the chain: a redirect changes getURL() but not what the user right-clicked.
    const asked = this.askFor.delete(item.getURLChain()[0] ?? url);
    if (asked) {
      item.setSaveDialogOptions({ defaultPath: path.join(dir, item.getFilename()) });
    } else {
      // Running downloads count as taken too: their files may not exist on disk yet.
      const running = new Set([...this.items.values()].map((i) => i.getSavePath()));
      fs.mkdirSync(dir, { recursive: true });
      item.setSavePath(path.join(dir, uniqueFilename(item.getFilename(), (n) => fs.existsSync(path.join(dir, n)) || running.has(path.join(dir, n)))));
    }
    this.items.set(id, item);
    const entry: DownloadEntry = {
      id, url, filename: item.getFilename(), path: item.getSavePath(), mime: item.getMimeType(),
      totalBytes: item.getTotalBytes(), receivedBytes: 0, state: 'progressing', startedAt: Date.now(), endedAt: null, profileId,
      ...(isPrivate ? { private: true } : {}),
    };
    this.store.dispatch({ type: 'download.upsert', entry });

    item.on('updated', () => {
      this.progress.set(id, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
      this.hooks.progress();
      this.syncStatus(id, item);
    });
    item.once('done', (_e, state) => {
      this.items.delete(id);
      this.progress.delete(id);
      this.hooks.progress();
      // Dismissing a save dialog isn't a download the user wants listed.
      if (asked && state === 'cancelled' && !item.getSavePath()) return void this.store.dispatch({ type: 'download.remove', id });
      const done = this.write(id, item, { state, endedAt: Date.now(), paused: false });
      if (done?.state === 'completed') this.hooks.completed(done);
    });
  }

  /** Save the entry only when something other than the byte count changed (paused, interrupted, save path). */
  private syncStatus(id: string, item: DownloadItem) {
    const prev = this.store.state.downloads.find((d) => d.id === id);
    if (!prev) return;
    const state = item.getState() === 'interrupted' ? 'interrupted' : 'progressing';
    if (prev.state !== state || !!prev.paused !== item.isPaused() || prev.path !== item.getSavePath()) this.write(id, item, { state });
  }

  /** Copy the item into its entry. Entries the user removed stay removed. */
  private write(id: string, item: DownloadItem, patch: Partial<DownloadEntry> = {}): DownloadEntry | null {
    const prev = this.store.state.downloads.find((d) => d.id === id);
    if (!prev) return null;
    const savePath = item.getSavePath();
    const entry: DownloadEntry = {
      ...prev,
      path: savePath,
      filename: savePath ? path.basename(savePath) : item.getFilename(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      paused: item.isPaused(),
      ...patch,
    };
    this.store.dispatch({ type: 'download.upsert', entry });
    return entry;
  }

  /** A private window closed: stop its running downloads and drop its entries (finished files stay on disk). */
  forgetPrivate(profileId: string) {
    for (const d of this.store.state.downloads.filter((x) => x.private && x.profileId === profileId)) {
      this.store.dispatch({ type: 'download.remove', id: d.id });
      this.items.get(d.id)?.cancel();
    }
  }

  async run(op: DownloadOp, id: string) {
    const entry = this.store.state.downloads.find((d) => d.id === id);
    const item = this.items.get(id);
    if (!entry) return;
    switch (op) {
      case 'open':
        if (entry.path) await shell.openPath(entry.path);
        return;
      case 'show':
        if (entry.path) shell.showItemInFolder(entry.path);
        return;
      case 'cancel':
        return item?.cancel();
      case 'pause':
        item?.pause();
        return item && this.syncStatus(id, item);
      case 'resume':
        if (item?.canResume()) item.resume();
        return item && this.syncStatus(id, item);
      case 'retry':
        // A dropped connection picks up where it stopped; otherwise a fresh request with its own entry.
        if (item?.canResume()) {
          item.resume();
          return this.syncStatus(id, item);
        }
        item?.cancel();
        this.store.dispatch({ type: 'download.remove', id });
        // A private window's session is gone once it closes; its downloads can't be retried.
        return entry.private ? undefined : sessionFor(entry.profileId).downloadURL(entry.url);
      case 'remove':
        // Removing a running download stops it; the file of a finished one stays on disk.
        this.store.dispatch({ type: 'download.remove', id });
        return item?.cancel();
    }
  }
}
