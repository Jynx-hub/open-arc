import { reduce, initialState, type Action } from '../src/shared/reducer';
import type { State } from '../src/shared/model';

export function fresh(): State {
  return initialState(1000, { space: 'S1', pinned: 'P1', today: 'T1', favorites: 'F-default' });
}

export function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

export const tab = (id: string, parentId: string, url = `https://${id}.test/`, now = 1000): Action => ({ type: 'tab.create', id, parentId, url, title: id, now });
