// "Import from Arc": reads Arc's data folder (only arc-export's allow-listed files) and replaces our state.
import { dialog } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readArcModel, stateFromArc, type ImportSummary } from '../shared/importArc';
import type { Store } from './store';

export const ARC_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Arc');

export async function importFromArc(store: Store, dir?: string): Promise<ImportSummary | null> {
  let arcDir = dir ?? ARC_DATA_DIR;
  if (!fs.existsSync(path.join(arcDir, 'StorableSidebar.json'))) {
    const res = await dialog.showOpenDialog({ title: 'Choose your Arc data folder', properties: ['openDirectory'], defaultPath: os.homedir() });
    if (res.canceled || !res.filePaths[0]) return null;
    arcDir = res.filePaths[0];
  }
  const { state, summary } = stateFromArc(readArcModel(arcDir), randomUUID, Date.now());
  // Keep what Arc has no equivalent for.
  const prev = store.state;
  state.boosts = prev.boosts;
  state.history = prev.history;
  state.settings = { ...prev.settings, autoArchive: { ...state.settings.autoArchive, ...prev.settings.autoArchive } };
  store.dispatch({ type: 'state.replace', state });
  return summary;
}
