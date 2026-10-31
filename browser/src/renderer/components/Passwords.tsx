// Saved passwords: the save prompt after signing in, and Library › Passwords. Passwords never come to the
// UI except one at a time when revealed (main asks for Touch ID first).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Command, PasswordImport, PasswordList, PasswordOp, PasswordPrompt, WindowInfo } from '../../shared/ipc';
import type { State } from '../../shared/model';
import type { LoginSummary } from '../../shared/passwords';
import { api, hostOf, useUiEvent } from '../api';

const run = <T,>(op: PasswordOp) => api.command<T>({ type: 'passwords', ...op } as Command);

export function PasswordPromptCard({ prompt, bar }: { prompt: PasswordPrompt; bar?: boolean }) {
  const answer = (a: 'save' | 'never' | 'dismiss') => void api.command({ type: 'passwordPrompt', id: prompt.id, answer: a });
  const who = prompt.username ? <strong>{prompt.username}</strong> : 'this login';
  return (
    <div className={`permission-prompt password-prompt ${bar ? 'bar' : ''}`} role="dialog" aria-label="Save password">
      <div className="permission-text">
        {prompt.kind === 'update' ? <>Update the saved password for {who} on <strong>{hostOf(prompt.origin)}</strong>?</> : <>Save the password for {who} on <strong>{hostOf(prompt.origin)}</strong>?</>}
      </div>
      <div className="permission-actions">
        {prompt.kind === 'save' && <button className="pw-never" onClick={() => answer('never')}>Never for this site</button>}
        <button className="pw-dismiss" onClick={() => answer('dismiss')}>Not now</button>
        <button className="pw-save primary" onClick={() => answer('save')}>{prompt.kind === 'update' ? 'Update' : 'Save'}</button>
      </div>
    </div>
  );
}

/** The logins of the window's Profile; it follows the window to a Space on another Profile. */
export function PasswordsView({ state, win }: { state: State; win: WindowInfo }) {
  const profileId = state.spaces.find((s) => s.id === win.spaceId)?.profileId;
  const [list, setList] = useState<PasswordList | null>(null);
  const [q, setQ] = useState('');
  const [imported, setImported] = useState<PasswordImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = useCallback(() => void run<PasswordList>({ op: 'list' }).then(setList), []);
  useEffect(() => {
    setEditing(null);
    setImported(null);
    refresh();
  }, [refresh, profileId]);
  useUiEvent('passwords', refresh);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list?.logins ?? []).filter((l) => !needle || l.origin.toLowerCase().includes(needle) || l.username.toLowerCase().includes(needle));
  }, [list, q]);

  const importCsv = async () => {
    setError(null);
    const res = await run<PasswordImport | { error: string } | null>({ op: 'import' });
    if (!res) return;
    if ('error' in res) setError(res.error);
    else setImported(res);
  };

  if (win.kind === 'incognito') return <p className="muted small">Private windows don’t use saved passwords. Open the Library from a normal window to manage them.</p>;
  if (!list) return null;
  return (
    <div className="passwords">
      <div className="toolbar">
        <input placeholder="Search passwords" value={q} onChange={(e) => setQ(e.target.value)} />
        <button disabled={!list.available} onClick={() => void importCsv()}>Import CSV…</button>
        <button disabled={!list.logins.length} onClick={() => void run({ op: 'export' })}>Export…</button>
      </div>
      {!list.available && <p className="notice">Passwords can’t be saved here: this Mac’s keychain isn’t available, or the saved file was made on another Mac.</p>}
      {error && <p className="notice">{error}</p>}
      {imported && (
        <div className="notice import-result">
          <span className="grow">
            Imported {imported.added} new, updated {imported.updated}
            {imported.skipped ? `, skipped ${imported.skipped} without a web address or password` : ''}. The CSV file still holds every password in plain text.
          </span>
          <button className="primary" onClick={() => void run({ op: 'deleteImported' }).then(() => setImported(null))}>Delete the file</button>
          <button onClick={() => setImported(null)}>Keep it</button>
        </div>
      )}
      {list.logins.length === 0 ? (
        <div className="muted small empty-passwords">
          <p>No saved passwords yet. Open Arc offers to save one when you sign in to a site.</p>
          <p>
            To bring your passwords over from Arc (or Chrome): in that browser open Settings, then Passwords, choose Export passwords, and save the CSV file.
            Then choose Import CSV here. Open Arc keeps them encrypted with your Mac’s keychain.
          </p>
        </div>
      ) : (
        <ul className="list logins">
          {shown.map((l) => (editing === l.id ? <LoginEditor key={l.id} login={l} onDone={() => setEditing(null)} /> : <LoginRow key={l.id} login={l} onEdit={() => setEditing(l.id)} />))}
        </ul>
      )}
      {!!list.never.length && (
        <>
          <h4>Never offered for</h4>
          <ul className="list compact">
            {list.never.map((o) => (
              <li key={o}>
                <span className="grow ellipsis">{hostOf(o)}</span>
                <button className="link" onClick={() => void run({ op: 'unblock', origin: o })}>Remove</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function LoginRow({ login, onEdit }: { login: LoginSummary; onEdit(): void }) {
  const [password, setPassword] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <li className="login">
      <div className="grow">
        <div className="ellipsis">{hostOf(login.origin)}</div>
        <div className="muted small ellipsis">{login.username || '(no username)'}</div>
      </div>
      <code className="login-password">{password ?? '••••••••'}</code>
      <button className="icon-btn" title={password ? 'Hide' : 'Show password'} onClick={() => (password ? setPassword(null) : void run<string | null>({ op: 'reveal', id: login.id }).then(setPassword))}>
        {password ? '◡' : '◉'}
      </button>
      <button className="icon-btn" title="Copy password" onClick={() => void run({ op: 'copy', id: login.id })}>⧉</button>
      <button className="icon-btn" title="Edit" onClick={onEdit}>✎</button>
      {confirmDelete ? (
        <button className="danger small" onClick={() => void run({ op: 'remove', id: login.id })}>Delete</button>
      ) : (
        <button className="icon-btn" title="Delete" onClick={() => setConfirmDelete(true)}>×</button>
      )}
    </li>
  );
}

function LoginEditor({ login, onDone }: { login: LoginSummary; onDone(): void }) {
  const [username, setUsername] = useState(login.username);
  const [password, setPassword] = useState('');
  const [note, setNote] = useState(login.note);
  const save = async () => {
    await run({ op: 'update', id: login.id, username, password: password || undefined, note });
    onDone();
  };
  return (
    <li className="login editing">
      <div className="grow login-fields">
        <div className="muted small">{hostOf(login.origin)}</div>
        <input aria-label="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input aria-label="New password" type="password" placeholder="New password (leave empty to keep)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input aria-label="Note" placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button onClick={onDone}>Cancel</button>
      <button className="primary" onClick={() => void save()}>Save</button>
    </li>
  );
}
