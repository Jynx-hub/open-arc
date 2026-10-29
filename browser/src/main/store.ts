// Owns the single copy of State: load, reduce, broadcast, and an atomic debounced save.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STATE_VERSION, type State } from '../shared/model';
import { initialState, reduce, type Action } from '../shared/reducer';

type Listener = (state: State, prev: State) => void;

export class Store {
  state: State;
  private listeners = new Set<Listener>();
  private saveTimer: NodeJS.Timeout | null = null;

  /** True when there was no saved state, so the first launch can offer an Arc import. */
  readonly firstRun: boolean;

  constructor(private file: string) {
    this.firstRun = !fs.existsSync(file);
    this.state = this.load();
  }

  dispatch(action: Action): State {
    const prev = this.state;
    this.state = reduce(prev, action);
    if (this.state !== prev) {
      for (const fn of this.listeners) fn(this.state, prev);
      this.scheduleSave();
    }
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }

  private load(): State {
    let raw: State | null = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as State;
    } catch (err) {
      if (fs.existsSync(this.file)) {
        // Keep the unreadable file for recovery rather than overwriting it.
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        console.error('state file unreadable, starting fresh', err);
      }
      return initialState(Date.now(), { space: randomUUID(), pinned: randomUUID(), today: randomUUID(), favorites: randomUUID() });
    }
    // A file from a newer version is valid data we can't read; leave it untouched and stop.
    if (raw.version > STATE_VERSION) throw new StateTooNewError(raw.version);
    return migrate(raw);
  }
}

export class StateTooNewError extends Error {
  constructor(readonly version: number) {
    super(`The saved state is from a newer version of the app (format ${version}). Update the app to open it.`);
  }
}

function migrate(state: State): State {
  // v1 is the first version; future migrations go here, one step per version.
  return state;
}
