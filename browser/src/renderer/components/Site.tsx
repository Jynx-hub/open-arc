// Downloads list and site permissions: the prompt, the per-site settings, and the full list in Settings.
import { useState } from 'react';
import type { DownloadOp, PermissionPrompt, UiEvents } from '../../shared/ipc';
import type { DownloadEntry, State } from '../../shared/model';
import { describePermission } from '../../shared/permissions';
import { api, dispatch, hostOf, useUiEvent } from '../api';

// ── permissions ────────────────────────────────────────────────────────────

export function PermissionPromptCard({ prompt, bar }: { prompt: PermissionPrompt; bar?: boolean }) {
  const answer = (a: 'allow' | 'once' | 'block') => void api.command({ type: 'permission', id: prompt.id, answer: a });
  return (
    <div className={`permission-prompt ${bar ? 'bar' : ''}`} role="dialog" aria-label="Permission request">
      <div className="permission-text">
        <strong>{hostOf(prompt.origin)}</strong> wants to {joinWords(prompt.keys.map(describePermission))}.
      </div>
      <div className="permission-actions">
        <button className="perm-block" onClick={() => answer('block')}>Block</button>
        <button className="perm-once" onClick={() => answer('once')}>Allow once</button>
        <button className="perm-allow primary" onClick={() => answer('allow')}>Allow</button>
      </div>
    </div>
  );
}

/** Saved answers, for one site (the site panel) or every site (Settings). */
export function SitePermissionList({ state, origin }: { state: State; origin?: string }) {
  const all = state.settings.sitePermissions;
  const origins = origin ? (all[origin] ? [origin] : []) : Object.keys(all).sort();
  if (!origins.length) return <p className="muted small">{origin ? 'This site hasn’t asked for any permissions.' : 'No site has saved permissions yet.'}</p>;
  return (
    <ul className="list compact site-perms">
      {origins.flatMap((o) =>
        Object.entries(all[o]!).map(([key, decision]) => (
          <li key={`${o} ${key}`}>
            <span className="grow ellipsis">{origin ? '' : <span className="muted">{hostOf(o)} · </span>}{capitalize(describePermission(key))}</span>
            <select value={decision} onChange={(e) => dispatch({ type: 'sitePermission.set', origin: o, permission: key, decision: e.target.value as 'allow' | 'deny' })}>
              <option value="allow">Allowed</option>
              <option value="deny">Blocked</option>
            </select>
            <button className="link" title="Ask again next time" onClick={() => dispatch({ type: 'sitePermission.set', origin: o, permission: key, decision: null })}>Reset</button>
          </li>
        )),
      )}
    </ul>
  );
}

// ── downloads ──────────────────────────────────────────────────────────────

/** Downloads with live byte counts merged in (progress arrives separately from State). */
export function useDownloads(state: State, privateId: string | null = null): DownloadEntry[] {
  const [progress, setProgress] = useState<UiEvents['downloadProgress']>({});
  useUiEvent('downloadProgress', setProgress);
  // A private window lists only its own downloads, and normal windows never list a private one.
  const mine = (d: DownloadEntry) => (privateId ? d.private && d.profileId === privateId : !d.private);
  return state.downloads.filter(mine).map((d) => (d.state === 'progressing' && progress[d.id] ? { ...d, ...progress[d.id] } : d));
}

export function DownloadsList({ state, limit, privateId }: { state: State; limit?: number; privateId?: string }) {
  const downloads = useDownloads(state, privateId);
  const list = limit ? downloads.slice(0, limit) : downloads;
  const run = (op: DownloadOp, id: string) => void api.command({ type: 'download', op, id });
  if (!list.length) return <p className="muted small">No downloads yet.</p>;
  return (
    <ul className="list downloads">
      {list.map((d) => (
        <li key={d.id} className="download">
          <div className="grow">
            <div className={`ellipsis ${d.state === 'completed' ? 'clickable-text' : ''}`} onClick={() => d.state === 'completed' && run('open', d.id)} title={d.path || d.url}>{d.filename}</div>
            {d.state === 'progressing' && <progress max={d.totalBytes || 1} value={d.totalBytes ? d.receivedBytes : undefined} />}
            <div className="muted small">{downloadStatus(d)}</div>
          </div>
          {d.state === 'progressing' && (
            <>
              <button className="icon-btn" title={d.paused ? 'Resume' : 'Pause'} onClick={() => run(d.paused ? 'resume' : 'pause', d.id)}>{d.paused ? '▶' : '❙❙'}</button>
              <button className="icon-btn" title="Cancel" onClick={() => run('cancel', d.id)}>■</button>
            </>
          )}
          {d.state === 'completed' && <button className="icon-btn" title="Show in Finder" onClick={() => run('show', d.id)}>⌕</button>}
          {(d.state === 'cancelled' || d.state === 'interrupted') && <button className="icon-btn" title="Try again" onClick={() => run('retry', d.id)}>↻</button>}
          <button className="icon-btn" title="Remove from list" onClick={() => run('remove', d.id)}>×</button>
        </li>
      ))}
    </ul>
  );
}

/** Overall progress of running downloads, 0–1, or null when nothing is running. */
export function downloadProgress(downloads: DownloadEntry[]): number | null {
  const active = downloads.filter((d) => d.state === 'progressing');
  if (!active.length) return null;
  const total = active.reduce((n, d) => n + d.totalBytes, 0);
  return total ? active.reduce((n, d) => n + d.receivedBytes, 0) / total : 0;
}

function downloadStatus(d: DownloadEntry): string {
  switch (d.state) {
    case 'progressing': return `${d.paused ? 'Paused · ' : ''}${bytes(d.receivedBytes)}${d.totalBytes ? ` of ${bytes(d.totalBytes)}` : ''} · ${hostOf(d.url)}`;
    case 'completed': return `${bytes(d.totalBytes || d.receivedBytes)} · ${hostOf(d.url)}`;
    case 'cancelled': return 'Cancelled';
    case 'interrupted': return 'Stopped before it finished';
  }
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function joinWords(words: string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
