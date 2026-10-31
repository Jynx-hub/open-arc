// "Import from Arc": reads Arc's data folder (only arc-export's allow-listed files) and replaces our state.
import { dialog } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-ignore: plain JS module with JSDoc types
import { DEFAULT_FIRESTORE_DIR, buildCloudModel, findCaches, readDocs } from '../../../exporter/src/firestore.js';
import { historyFromRows, readArcModel, stateFromArc, type CloudModel, type ImportSummary } from '../shared/importArc';
import type { Store } from './store';
import { readArcHistory } from './arcHistory';
import { HISTORY_LIMIT } from '../shared/reducer';

export const ARC_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Arc');

/**
 * Boosts and Easel content from Arc's Firestore offline cache. Each cache is copied asynchronously
 * (Arc holds the live one's LOCK, and it can be large), then parsed. Missing or unreadable → empty.
 */
async function readCloud(firestoreDir: string): Promise<CloudModel> {
  const docs: unknown[] = [];
  for (const dir of findCaches(firestoreDir) as string[]) {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'open-arc-fs-'));
    try {
      await fs.promises.cp(dir, tmp, { recursive: true });
      docs.push(...readDocs(tmp));
    } catch (err) {
      console.error('skipping Arc cloud cache', err);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  }
  return buildCloudModel(docs) as CloudModel;
}

/**
 * `firestoreDir` defaults to the live cache only when importing the live Arc folder; a folder the user
 * picked (a backup, another Mac) has no cloud cache of its own, so Boosts and Easel content are skipped.
 */
export async function importFromArc(store: Store, dir?: string, firestoreDir?: string): Promise<ImportSummary | null> {
  let arcDir = dir ?? ARC_DATA_DIR;
  if (!fs.existsSync(path.join(arcDir, 'StorableSidebar.json'))) {
    const res = await dialog.showOpenDialog({ title: 'Choose your Arc data folder', properties: ['openDirectory'], defaultPath: os.homedir() });
    if (res.canceled || !res.filePaths[0]) return null;
    arcDir = res.filePaths[0];
  }
  const cloudDir = firestoreDir ?? (path.resolve(arcDir) === ARC_DATA_DIR ? DEFAULT_FIRESTORE_DIR : null);
  const cloud = cloudDir ? await readCloud(cloudDir) : { boosts: [], easels: [] };
  const arcHistory = await readArcHistory(arcDir, HISTORY_LIMIT);
  const { state, summary } = stateFromArc(readArcModel(arcDir), randomUUID, Date.now(), cloud);
  // Keep what Arc has no equivalent for. Boosts made here survive; imported ones (`arc-…`) are
  // replaced wholesale, so a Boost deleted in Arc disappears on re-import.
  const prev = store.state;
  state.boosts = [...prev.boosts.filter((b) => !b.id.startsWith('arc-')), ...state.boosts];
  state.history = historyFromRows([...arcHistory, ...prev.history], HISTORY_LIMIT);
  summary.history = state.history.length;
  state.downloads = prev.downloads;
  state.settings = { ...prev.settings, autoArchive: { ...state.settings.autoArchive, ...prev.settings.autoArchive } };
  store.dispatch({ type: 'state.replace', state });
  return summary;
}
