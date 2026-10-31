import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ARCHIVE_THRESHOLDS, itemTitle, type ArchiveThreshold, type Boost, type LinkRule, type State } from '../../shared/model';
import { KEY_ACTIONS, acceleratorFor } from '../../shared/keymap';
import { describeDestination } from '../../shared/routing';
import { api, dispatch, hostOf, uid } from '../api';
import type { WindowInfo } from '../../shared/ipc';
import { DownloadsList, SitePermissionList } from './Site';
import { ExtensionsView } from './Extensions';
import { PasswordsView } from './Passwords';

const SPACE_COLORS = ['#5b6cff', '#e8590c', '#2f9e44', '#c2255c', '#1098ad', '#7048e8', '#f08c00', '#495057'];
const THRESHOLD_LABELS: Record<ArchiveThreshold, string> = {
  twentySeconds: '20 seconds (testing)', oneHour: '1 hour', sixHours: '6 hours', twelveHours: '12 hours',
  twentyFourHours: '24 hours', sevenDays: '7 days', thirtyDays: '30 days', never: 'Never',
};

export function Modal({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">×</button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ── Space editor ────────────────────────────────────────────────────────────

export function SpaceEditor({ state, spaceId, onClose }: { state: State; spaceId?: string; onClose(): void }) {
  const space = state.spaces.find((s) => s.id === spaceId);
  const [title, setTitle] = useState(space?.title ?? '');
  const [icon, setIcon] = useState(space?.icon ?? '');
  const [color, setColor] = useState(space?.color ?? SPACE_COLORS[state.spaces.length % SPACE_COLORS.length]!);
  const [profileId, setProfileId] = useState(space?.profileId ?? 'default');
  const [newProfile, setNewProfile] = useState('');

  const save = () => {
    let pid = profileId;
    if (pid === '__new') {
      pid = uid();
      dispatch({ type: 'profile.create', id: pid, name: newProfile.trim() || 'New Profile', favoritesRootId: uid(), now: Date.now() });
    }
    const patch = { title: title.trim() || 'Untitled Space', icon: icon.trim() || null, color, profileId: pid };
    if (space) {
      if (pid !== space.profileId && !confirmProfileSwitch()) return;
      dispatch({ type: 'space.update', id: space.id, patch });
    } else {
      const id = uid();
      dispatch({ type: 'space.create', id, pinnedRootId: uid(), todayRootId: uid(), ...patch, now: Date.now() });
      void api.command({ type: 'switchSpace', spaceId: id });
    }
    onClose();
  };

  return (
    <Modal title={space ? 'Edit Space' : 'New Space'} onClose={onClose}>
      <label className="field">Name<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} placeholder="e.g. Work" /></label>
      <label className="field">Icon<input value={icon} maxLength={4} onChange={(e) => setIcon(e.target.value)} placeholder="An emoji (optional)" /></label>
      <div className="field">Theme
        <div className="swatches">
          {SPACE_COLORS.map((c) => (
            <button key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
      </div>
      <label className="field">Profile
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          {state.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value="__new">New Profile…</option>
        </select>
      </label>
      {profileId === '__new' && <label className="field">Profile name<input value={newProfile} onChange={(e) => setNewProfile(e.target.value)} /></label>}
      <p className="note">Spaces that share a Profile share logins, cookies, history and Favorites.</p>
      <footer className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save}>{space ? 'Save' : 'Create Space'}</button>
      </footer>
    </Modal>
  );
}

function confirmProfileSwitch() {
  // The page is about to load with different cookies; the in-modal note already explains it.
  return true;
}

export function ConfirmDialog({ title, body, confirm, onConfirm, onClose }: { title: string; body: string; confirm: string; onConfirm(): void; onClose(): void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p>{body}</p>
      <footer className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="danger" autoFocus onClick={() => { onConfirm(); onClose(); }}>{confirm}</button>
      </footer>
    </Modal>
  );
}

// ── Space manager ───────────────────────────────────────────────────────────

export function SpaceManager({ state, onClose, onEdit }: { state: State; onClose(): void; onEdit(id: string): void }) {
  const [drag, setDrag] = useState<string | null>(null);
  return (
    <Modal title="Spaces" onClose={onClose} wide>
      <div className="space-grid">
        {state.spaces.map((s, i) => (
          <div
            key={s.id}
            className="space-card"
            style={{ ['--space' as string]: s.color }}
            draggable
            onDragStart={() => setDrag(s.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drag && dispatch({ type: 'space.move', id: drag, index: i })}
          >
            <header>
              <span>{s.icon ?? '●'} {s.title}</span>
              <button className="link" onClick={() => onEdit(s.id)}>Edit</button>
            </header>
            <SpaceItems state={state} rootId={s.pinnedRootId} label="Pinned" targets={state.spaces.filter((x) => x.id !== s.id)} />
            <SpaceItems state={state} rootId={s.todayRootId} label="Today" targets={state.spaces.filter((x) => x.id !== s.id)} />
            <footer className="muted">{state.profiles.find((p) => p.id === s.profileId)?.name} profile</footer>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function SpaceItems({ state, rootId, label, targets }: { state: State; rootId: string; label: string; targets: State['spaces'] }) {
  const kids = state.items[rootId]?.children ?? [];
  return (
    <div className="space-items">
      <div className="muted small">{label} · {kids.length}</div>
      <ul>
        {kids.slice(0, 12).map((id) => {
          const item = state.items[id];
          if (!item) return null;
          return (
            <li key={id}>
              <span className="ellipsis">{itemTitle(item)}</span>
              {targets.length > 0 && (
                <select value="" onChange={(e) => e.target.value && dispatch({ type: 'item.move', id, parentId: e.target.value, index: Infinity })}>
                  <option value="">Move…</option>
                  {targets.map((t) => <option key={t.id} value={t.pinnedRootId}>{t.title}</option>)}
                </select>
              )}
            </li>
          );
        })}
        {kids.length > 12 && <li className="muted">and {kids.length - 12} more</li>}
      </ul>
    </div>
  );
}

// ── Library: Archive, History, Downloads, Captures, Notes & Easels, Passwords, Extensions ──────────────────────

export function Library({ state, win, initialTab, onClose }: { state: State; win: WindowInfo; initialTab?: string; onClose(): void }) {
  const [tab, setTab] = useState(initialTab ?? 'archive');
  return (
    <Modal title="Library" onClose={onClose} wide>
      <nav className="tabs">
        {[['archive', 'Archive'], ['history', 'History'], ['downloads', 'Downloads'], ['captures', 'Captures'], ['docs', 'Notes & Easels'], ['passwords', 'Passwords'], ['extensions', 'Extensions']].map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id!)}>{label}</button>
        ))}
      </nav>
      {tab === 'archive' && <ArchiveView state={state} onClose={onClose} />}
      {tab === 'history' && <HistoryView onClose={onClose} />}
      {tab === 'downloads' && (
        <div>
          <div className="toolbar">
            <span className="grow muted small">Files save to your Downloads folder.</span>
            <button disabled={!state.downloads.some((d) => !d.private && d.state !== 'progressing')} onClick={() => dispatch({ type: 'download.clear' })}>Clear finished</button>
          </div>
          <DownloadsList state={state} />
        </div>
      )}
      {tab === 'captures' && <CapturesView />}
      {tab === 'docs' && <DocsView state={state} onClose={onClose} />}
      {tab === 'passwords' && <PasswordsView state={state} win={win} />}
      {tab === 'extensions' && <ExtensionsView win={win} onClose={onClose} />}
    </Modal>
  );
}

function ArchiveView({ state, onClose }: { state: State; onClose(): void }) {
  const [q, setQ] = useState('');
  const [source, setSource] = useState('all');
  const [reason, setReason] = useState('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const entries = useMemo(() => {
    const needle = q.toLowerCase();
    return state.archive.filter((e) => {
      const root = e.items[0];
      if (!root) return false;
      if (source === 'littleArc' && e.source.kind !== 'littleArc') return false;
      if (source !== 'all' && source !== 'littleArc' && !(e.source.kind === 'space' && e.source.spaceId === source)) return false;
      if (reason !== 'all' && e.reason !== reason) return false;
      return !needle || itemTitle(root).toLowerCase().includes(needle) || (root.tab?.savedURL ?? '').toLowerCase().includes(needle);
    });
  }, [state.archive, q, source, reason]);
  const spaceTitle = (id: string) => state.spaces.find((s) => s.id === id)?.title ?? 'Deleted Space';

  return (
    <div className="archive">
      <div className="toolbar">
        <input placeholder="Search the Archive" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="all">All sources</option>
          {state.spaces.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          <option value="littleArc">Mini windows</option>
        </select>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="all">Any reason</option>
          <option value="auto">Auto-archived</option>
          <option value="manual">Closed</option>
          <option value="clearButton">Cleared</option>
          <option value="clearTabGroup">Group cleared</option>
        </select>
        <button className="danger" disabled={!state.archive.length} onClick={() => setConfirmClear(true)}>Clear Archive</button>
      </div>
      <ul className="list">
        {entries.slice(0, 500).map((e) => {
          const root = e.items[0]!;
          const n = e.items.filter((i) => i.tab).length;
          return (
            <li key={e.id}>
              <div className="grow">
                <div className="ellipsis">{itemTitle(root)}{root.kind !== 'tab' ? ` (${n} tabs)` : ''}</div>
                <div className="muted small">
                  {root.tab ? hostOf(root.tab.savedURL) + ' · ' : ''}
                  {e.source.kind === 'space' ? spaceTitle(e.source.spaceId) : e.source.kind === 'littleArc' ? 'Mini window' : 'Unknown'} · {REASONS[e.reason]} · {new Date(e.archivedAt).toLocaleString()}
                </div>
              </div>
              <button onClick={() => { dispatch({ type: 'archive.restore', entryId: e.id }); void api.command({ type: 'select', id: root.id }); onClose(); }}>Restore</button>
              <button className="icon-btn" title="Delete" onClick={() => dispatch({ type: 'archive.delete', entryId: e.id })}>×</button>
            </li>
          );
        })}
        {!entries.length && <li className="muted">Nothing here.</li>}
      </ul>
      {confirmClear && (
        <ConfirmDialog title="Clear the Archive?" body="Every archived tab will be deleted permanently." confirm="Clear" onConfirm={() => dispatch({ type: 'archive.clear' })} onClose={() => setConfirmClear(false)} />
      )}
    </div>
  );
}

const REASONS: Record<string, string> = { auto: 'Auto-archived', manual: 'Closed', clearButton: 'Cleared', clearTabGroup: 'Group cleared' };

function HistoryView({ onClose }: { onClose(): void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ title: string; subtitle: string; key: string; run: unknown }[]>([]);
  useEffect(() => {
    void api.command<typeof results>({ type: 'search', query: q || ' ' }).then((r) => setResults((r ?? []).filter((x) => (x as { kind?: string }).kind === 'history')));
  }, [q]);
  return (
    <div>
      <div className="toolbar"><input autoFocus placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <ul className="list">
        {results.map((r) => (
          <li key={r.key} className="clickable" onClick={() => { void api.command(r.run as never); onClose(); }}>
            <div className="grow"><div className="ellipsis">{r.title}</div><div className="muted small">{r.subtitle}</div></div>
          </li>
        ))}
        {!results.length && <li className="muted">{q ? 'No matches.' : 'Type to search your history.'}</li>}
      </ul>
    </div>
  );
}

function CapturesView() {
  const [items, setItems] = useState<{ name: string; path: string; createdAt: number }[]>([]);
  useEffect(() => {
    void api.captures().then(setItems);
  }, []);
  return (
    <div>
      <p className="muted">Captures are saved as images in the app's data folder (Captures).</p>
      <ul className="list">
        {items.map((c) => <li key={c.path}><span className="grow ellipsis">{c.name}</span></li>)}
        {!items.length && <li className="muted">No captures yet. Use Capture Area from the Tabs menu.</li>}
      </ul>
    </div>
  );
}

function DocsView({ state, onClose }: { state: State; onClose(): void }) {
  const docs = Object.values(state.items).filter((i) => i.kind === 'note' || i.kind === 'easel');
  return (
    <ul className="list">
      {docs.map((d) => (
        <li key={d.id} className="clickable" onClick={() => { void api.command({ type: 'select', id: d.id }); onClose(); }}>
          <span>{d.kind === 'note' ? '✎' : '◩'}</span>
          <span className="grow ellipsis">{itemTitle(d)}</span>
          <span className="muted small">{new Date(d.createdAt).toLocaleDateString()}</span>
        </li>
      ))}
      {!docs.length && <li className="muted">No Notes or Easels yet.</li>}
    </ul>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

export function Settings({ state, initialTab, onClose, onEditBoost }: { state: State; initialTab?: string; onClose(): void; onEditBoost(id?: string): void }) {
  const [tab, setTab] = useState(initialTab ?? 'general');
  const set = (patch: Partial<State['settings']>) => dispatch({ type: 'settings.update', patch });
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <nav className="tabs">
        {[['general', 'General'], ['profiles', 'Profiles'], ['links', 'Link Rules'], ['sites', 'Site Search'], ['permissions', 'Site Permissions'], ['boosts', 'Boosts'], ['keys', 'Shortcuts']].map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id!)}>{label}</button>
        ))}
      </nav>
      {tab === 'general' && (
        <div className="settings-pane">
          <label className="field">Search engine URL (%s is the query)
            <input value={state.settings.searchTemplate} onChange={(e) => set({ searchTemplate: e.target.value })} />
          </label>
          <label className="check"><input type="checkbox" checked={state.settings.showSpaceHeader} onChange={(e) => set({ showSpaceHeader: e.target.checked })} /> Show the Space name at the top of the sidebar</label>
          <label className="check"><input type="checkbox" checked={state.settings.peekFromPinned} onChange={(e) => set({ peekFromPinned: e.target.checked })} /> Open links to other sites from pinned tabs and Favorites in a preview</label>
          <label className="check"><input type="checkbox" checked={state.settings.autoPictureInPicture} onChange={(e) => set({ autoPictureInPicture: e.target.checked })} /> Keep a playing video in a floating window when you switch tabs</label>
          <label className="check"><input type="checkbox" checked={state.settings.peekOnShiftClick} onChange={(e) => set({ peekOnShiftClick: e.target.checked })} /> Shift-click a link to preview it</label>
          <label className="field">Mini windows archive after
            <ThresholdSelect value={state.settings.littleArcArchive} onChange={(v) => set({ littleArcArchive: v })} />
          </label>
          <div className="row-buttons">
            <button onClick={() => api.command({ type: 'setDefaultBrowser' })}>Make default browser</button>
            <button onClick={() => { void api.command({ type: 'importArc' }); onClose(); }}>Import from Arc…</button>
          </div>
        </div>
      )}
      {tab === 'profiles' && <ProfilesPane state={state} />}
      {tab === 'links' && <LinkRulesPane state={state} />}
      {tab === 'sites' && <SiteSearchPane state={state} />}
      {tab === 'permissions' && (
        <div className="settings-pane">
          <p className="note">Sites ask before using your camera, microphone, location and similar features. Your answers are remembered here; reset one to be asked again.</p>
          <SitePermissionList state={state} />
        </div>
      )}
      {tab === 'boosts' && (
        <div className="settings-pane">
          <ul className="list">
            {state.boosts.map((b) => (
              <li key={b.id}>
                <input type="checkbox" checked={b.enabled} onChange={(e) => dispatch({ type: 'boost.upsert', boost: { ...b, enabled: e.target.checked } })} />
                <span className="grow">{b.name || b.host} <span className="muted small">{b.host}</span></span>
                <button onClick={() => onEditBoost(b.id)}>Edit</button>
                <button onClick={() => api.command({ type: 'exportBoost', id: b.id })} title="Export as a userstyle (CSS only)">Share CSS…</button>
                <button className="icon-btn" onClick={() => dispatch({ type: 'boost.remove', id: b.id })}>×</button>
              </li>
            ))}
            {!state.boosts.length && <li className="muted">No Boosts yet.</li>}
          </ul>
          <button onClick={() => onEditBoost()}>New Boost for the current site</button>
        </div>
      )}
      {tab === 'keys' && <ShortcutsPane state={state} />}
    </Modal>
  );
}

function ThresholdSelect({ value, onChange }: { value: ArchiveThreshold; onChange(v: ArchiveThreshold): void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as ArchiveThreshold)}>
      {(Object.keys(ARCHIVE_THRESHOLDS) as ArchiveThreshold[]).map((k) => <option key={k} value={k}>{THRESHOLD_LABELS[k]}</option>)}
    </select>
  );
}

function ProfilesPane({ state }: { state: State }) {
  const [askAll, setAskAll] = useState<{ profileId: string; value: ArchiveThreshold } | null>(null);
  const unused = state.profiles.filter((p) => p.id !== 'default' && !state.spaces.some((s) => s.profileId === p.id));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setThreshold = (profileId: string, value: ArchiveThreshold, all: boolean) => {
    const next = { ...state.settings.autoArchive };
    for (const p of all ? state.profiles : state.profiles.filter((x) => x.id === profileId)) next[p.id] = value;
    dispatch({ type: 'settings.update', patch: { autoArchive: next } });
  };
  return (
    <div className="settings-pane">
      <ul className="list">
        {state.profiles.map((p) => (
          <li key={p.id}>
            <input className="grow" defaultValue={p.name} disabled={p.id === 'default'} onBlur={(e) => dispatch({ type: 'profile.rename', id: p.id, name: e.target.value })} />
            <span className="muted small">{state.spaces.filter((s) => s.profileId === p.id).length} Spaces · archive Today tabs after</span>
            <ThresholdSelect value={state.settings.autoArchive[p.id] ?? 'twentyFourHours'} onChange={(v) => (state.profiles.length > 1 ? setAskAll({ profileId: p.id, value: v }) : setThreshold(p.id, v, false))} />
          </li>
        ))}
      </ul>
      <button onClick={() => dispatch({ type: 'profile.create', id: uid(), name: 'New Profile', favoritesRootId: uid(), now: Date.now() })}>Add Profile</button>
      {unused.length > 0 && <button className="danger" onClick={() => setConfirmDelete(true)}>Remove {unused.length} {unused.length === 1 ? 'Profile' : 'Profiles'} no Space uses…</button>}
      {askAll && (
        <Modal title="Apply to every Profile?" onClose={() => setAskAll(null)}>
          <p>Use “{THRESHOLD_LABELS[askAll.value]}” for all Profiles, or only this one?</p>
          <footer className="modal-actions">
            <button onClick={() => { setThreshold(askAll.profileId, askAll.value, false); setAskAll(null); }}>Only this Profile</button>
            <button className="primary" onClick={() => { setThreshold(askAll.profileId, askAll.value, true); setAskAll(null); }}>All Profiles</button>
          </footer>
        </Modal>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Remove Profiles no Space uses?"
          body={`This permanently removes the cookies, history and saved logins of: ${unused.map((p) => p.name).join(', ')}.`}
          confirm="Delete"
          onConfirm={() => unused.forEach((p) => dispatch({ type: 'profile.delete', id: p.id }))}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function LinkRulesPane({ state }: { state: State }) {
  const destValue = (d: LinkRule['destination']) => (d.kind === 'space' ? `space:${d.spaceId}` : d.kind);
  const parseDest = (v: string): LinkRule['destination'] => (v.startsWith('space:') ? { kind: 'space', spaceId: v.slice(6) } : v === 'recentSpace' ? { kind: 'recentSpace' } : { kind: 'littleArc' });
  const DestSelect = ({ value, onChange }: { value: LinkRule['destination']; onChange(d: LinkRule['destination']): void }) => (
    <select value={destValue(value)} onChange={(e) => onChange(parseDest(e.target.value))}>
      <option value="littleArc">Mini window</option>
      <option value="recentSpace">Most recent Space</option>
      {state.spaces.map((s) => <option key={s.id} value={`space:${s.id}`}>{s.title}</option>)}
    </select>
  );
  return (
    <div className="settings-pane">
      <p className="note">Links opened from other apps go through these rules from top to bottom. The first rule whose text appears in the link decides where it opens.</p>
      <ul className="list">
        {state.linkRules.map((r, i) => (
          <li key={r.id}>
            <span className="muted small">If the link contains</span>
            <input className="grow" defaultValue={r.pattern} onBlur={(e) => dispatch({ type: 'linkRule.upsert', rule: { ...r, pattern: e.target.value.trim() } })} />
            <span className="muted small">open in</span>
            <DestSelect value={r.destination} onChange={(d) => dispatch({ type: 'linkRule.upsert', rule: { ...r, destination: d } })} />
            <button className="icon-btn" disabled={i === 0} onClick={() => dispatch({ type: 'linkRule.move', id: r.id, index: i - 1 })}>↑</button>
            <button className="icon-btn" onClick={() => dispatch({ type: 'linkRule.remove', id: r.id })}>×</button>
          </li>
        ))}
      </ul>
      <button onClick={() => dispatch({ type: 'linkRule.upsert', rule: { id: uid(), pattern: '', destination: { kind: 'recentSpace' } } })}>Add rule</button>
      <label className="field">Everything else opens in
        <DestSelect value={state.settings.defaultLinkDestination} onChange={(d) => dispatch({ type: 'settings.update', patch: { defaultLinkDestination: d } })} />
      </label>
      <p className="muted small">Currently: {describeDestination(state, state.settings.defaultLinkDestination)}</p>
    </div>
  );
}

function SiteSearchPane({ state }: { state: State }) {
  const list = state.settings.siteSearches;
  const update = (next: typeof list) => dispatch({ type: 'settings.update', patch: { siteSearches: next } });
  return (
    <div className="settings-pane">
      <p className="note">In the Command Bar, type a keyword and press Tab to search that site directly.</p>
      <ul className="list">
        {list.map((s, i) => (
          <li key={i}>
            <input style={{ width: 70 }} defaultValue={s.keyword} onBlur={(e) => update(list.map((x, j) => (j === i ? { ...x, keyword: e.target.value.trim() } : x)))} />
            <input style={{ width: 120 }} defaultValue={s.name} onBlur={(e) => update(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input className="grow" defaultValue={s.template} onBlur={(e) => update(list.map((x, j) => (j === i ? { ...x, template: e.target.value } : x)))} />
            <button className="icon-btn" onClick={() => update(list.filter((_, j) => j !== i))}>×</button>
          </li>
        ))}
      </ul>
      <button onClick={() => update([...list, { keyword: 'kw', name: 'New site', template: 'https://example.com/search?q=%s' }])}>Add site</button>
    </div>
  );
}

function ShortcutsPane({ state }: { state: State }) {
  const [recording, setRecording] = useState<string | null>(null);
  const overrides = state.settings.keyOverrides;
  const used = new Map<string, string>();
  for (const a of KEY_ACTIONS) {
    const acc = acceleratorFor(a.id, overrides);
    if (acc) used.set(acc, a.id);
  }
  const record = (e: React.KeyboardEvent, id: string) => {
    e.preventDefault();
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
    if (e.key === 'Escape') return setRecording(null);
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'CmdOrCtrl'].filter(Boolean);
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key.replace(/^Arrow/, '');
    const acc = [...mods, key].join('+');
    const clash = used.get(acc);
    const next = { ...overrides, [id]: acc };
    if (clash && clash !== id) next[clash] = null; // the other action loses the chord, as in the spec's conflict rule
    dispatch({ type: 'settings.update', patch: { keyOverrides: next } });
    setRecording(null);
  };
  return (
    <div className="settings-pane">
      <ul className="list compact">
        {KEY_ACTIONS.map((a) => {
          const acc = acceleratorFor(a.id, overrides);
          return (
            <li key={a.id}>
              <span className="grow">{a.label}</span>
              <button className={`kbd ${recording === a.id ? 'recording' : ''}`} onClick={() => setRecording(a.id)} onKeyDown={(e) => recording === a.id && record(e, a.id)}>
                {recording === a.id ? 'Press keys…' : acc ? prettyAccel(acc) : '—'}
              </button>
              {a.id in overrides && <button className="link" onClick={() => { const { [a.id]: _, ...rest } = overrides; dispatch({ type: 'settings.update', patch: { keyOverrides: rest } }); }}>Reset</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function prettyAccel(acc: string): string {
  return acc
    .replace(/CmdOrCtrl\+|Cmd\+/g, '⌘')
    .replace(/Ctrl\+/g, '⌃')
    .replace(/Alt\+/g, '⌥')
    .replace(/Shift\+/g, '⇧')
    .replace(/Right/, '→').replace(/Left/, '←').replace(/Up/, '↑').replace(/Down/, '↓');
}

// ── Boost editor ────────────────────────────────────────────────────────────

export function BoostEditor({ state, boostId, currentUrl, onClose }: { state: State; boostId?: string; currentUrl: string | null; onClose(): void }) {
  const existing = state.boosts.find((b) => b.id === boostId) ?? state.boosts.find((b) => currentUrl && hostOf(currentUrl) === b.host);
  const [b, setB] = useState<Boost>(
    existing ?? { id: uid(), name: '', host: currentUrl ? hostOf(currentUrl) : '', enabled: true, css: '', js: '', zapped: [], font: null, color: null },
  );
  const [zap, setZap] = useState('');
  const save = () => {
    dispatch({ type: 'boost.upsert', boost: { ...b, host: b.host.trim().toLowerCase() } });
    void api.command({ type: 'navigate', op: 'reload' });
    onClose();
  };
  return (
    <Modal title={existing ? 'Edit Boost' : 'New Boost'} onClose={onClose} wide>
      <div className="boost-grid">
        <label className="field">Site<input value={b.host} onChange={(e) => setB({ ...b, host: e.target.value })} placeholder="example.com" /></label>
        <label className="field">Name<input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="My tweaks" /></label>
        <label className="field">Background color
          <span className="inline">
            <input type="color" value={b.color ?? '#ffffff'} onChange={(e) => setB({ ...b, color: e.target.value })} />
            {b.color && <button className="link" onClick={() => setB({ ...b, color: null })}>Remove</button>}
          </span>
        </label>
        <label className="field">Font
          <select value={b.font ?? ''} onChange={(e) => setB({ ...b, font: e.target.value || null })}>
            <option value="">Site default</option>
            {['system-ui', 'Georgia', 'Helvetica Neue', 'Menlo', 'Avenir Next', 'Palatino'].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
      </div>
      <div className="field">Hidden elements (CSS selectors)
        <ul className="list compact">
          {b.zapped.map((z) => (
            <li key={z}><code className="grow">{z}</code><button className="icon-btn" onClick={() => setB({ ...b, zapped: b.zapped.filter((x) => x !== z) })}>×</button></li>
          ))}
        </ul>
        <span className="inline">
          <input className="grow" value={zap} onChange={(e) => setZap(e.target.value)} placeholder=".cookie-banner, #sidebar-ads" />
          <button onClick={() => { if (zap.trim()) setB({ ...b, zapped: [...b.zapped, zap.trim()] }); setZap(''); }}>Hide</button>
        </span>
      </div>
      <label className="field">CSS<textarea className="code" rows={6} value={b.css} onChange={(e) => setB({ ...b, css: e.target.value })} spellCheck={false} /></label>
      <label className="field">JavaScript (runs after the page loads; never shared)<textarea className="code" rows={5} value={b.js} onChange={(e) => setB({ ...b, js: e.target.value })} spellCheck={false} /></label>
      <footer className="modal-actions">
        <label className="check"><input type="checkbox" checked={b.enabled} onChange={(e) => setB({ ...b, enabled: e.target.checked })} /> Enabled</label>
        {existing && <button className="danger" onClick={() => { dispatch({ type: 'boost.remove', id: b.id }); onClose(); }}>Delete</button>}
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!b.host.trim()} onClick={save}>Save Boost</button>
      </footer>
    </Modal>
  );
}

// ── First run, education, Live Folder setup ──────────────────────────────────

export function Welcome({ onClose }: { onClose(): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Welcome" onClose={onClose}>
      <p>Open Arc keeps your tabs in a sidebar organized into Spaces. Pinned tabs stay; Today tabs tidy themselves away into the Archive when you stop using them.</p>
      <p>If you used Arc on this Mac, bring over your Spaces, pinned tabs, Favorites, Archive and link rules. Arc's files are only read, never changed.</p>
      <footer className="modal-actions">
        <button onClick={onClose}>Start fresh</button>
        <button className="primary" disabled={busy} onClick={async () => { setBusy(true); await api.command({ type: 'importArc' }); onClose(); }}>
          {busy ? 'Importing…' : 'Import from Arc'}
        </button>
      </footer>
    </Modal>
  );
}

export function ArchiveEducation({ onClose, onSettings }: { onClose(): void; onSettings(): void }) {
  return (
    <Modal title="Idle tabs were archived" onClose={onClose}>
      <p>Tabs under Today that you haven't looked at for a while move to the Archive, so the sidebar stays short. Pinned tabs and Favorites are never archived. Everything stays searchable in the Command Bar and the Library.</p>
      <footer className="modal-actions">
        <button onClick={onSettings}>Change the timing</button>
        <button className="primary" onClick={onClose}>Got it</button>
      </footer>
    </Modal>
  );
}

export function LiveFolderDialog({ folderId, onClose }: { folderId: string; onClose(): void }) {
  const [kind, setKind] = useState<'rss' | 'github'>('rss');
  const [feed, setFeed] = useState('');
  return (
    <Modal title="Make a Live Folder" onClose={onClose}>
      <p>A Live Folder refills itself with the latest entries every half hour.</p>
      <label className="field">Source
        <select value={kind} onChange={(e) => setKind(e.target.value as 'rss' | 'github')}>
          <option value="rss">RSS or Atom feed</option>
          <option value="github">GitHub pull requests</option>
        </select>
      </label>
      <label className="field">{kind === 'rss' ? 'Feed URL' : 'Repository (owner/name)'}
        <input autoFocus value={feed} onChange={(e) => setFeed(e.target.value)} placeholder={kind === 'rss' ? 'https://example.com/feed.xml' : 'electron/electron'} />
      </label>
      <footer className="modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!feed.trim()} onClick={() => { dispatch({ type: 'liveFolder.set', id: folderId, feed: feed.trim(), kind }); void api.command({ type: 'liveFolderRefresh', id: folderId }); onClose(); }}>Create</button>
      </footer>
    </Modal>
  );
}
