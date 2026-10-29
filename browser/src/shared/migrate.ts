// Saved-state migrations, one step per format version. Pure, so tests can run them without Electron.
import { STATE_VERSION, type Item, type State } from './model';

export function migrate(state: State): State {
  if (state.version < 2) {
    // v2: Easel scenes are always `{ shapes: [] }` or richer; v1 created them as null.
    const fix = (item: Item) => {
      if (item.kind === 'easel' && !(item.easel?.scene && Array.isArray(item.easel.scene.shapes))) item.easel = { scene: { shapes: [] } };
    };
    Object.values(state.items).forEach(fix);
    state.archive.forEach((entry) => entry.items.forEach(fix));
    state.version = 2;
  }
  if (state.version < 3) {
    // v3: a downloads list and saved site permissions.
    state.downloads ??= [];
    state.settings = { ...state.settings, sitePermissions: state.settings.sitePermissions ?? {} };
    state.version = 3;
  }
  if (state.version < 4) {
    // v4: automatic Picture in Picture, on by default.
    state.settings = { ...state.settings, autoPictureInPicture: state.settings.autoPictureInPicture ?? true };
    state.version = 4;
  }
  return { ...state, version: STATE_VERSION };
}
