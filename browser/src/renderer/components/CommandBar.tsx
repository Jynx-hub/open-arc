import { useEffect, useRef, useState } from 'react';
import type { Command, OpenWhere, SearchResult } from '../../shared/ipc';
import type { SiteSearch, State } from '../../shared/model';
import { api } from '../api';
import { Favicon } from './Sidebar';

export type CommandBarMode = 'new' | 'current' | 'split';

const KIND_ICON: Record<SearchResult['kind'], string> = {
  tab: '⇥', history: '◷', archive: '⌫', search: '⌕', url: '↗', action: '⌘', siteSearch: '⌕', space: '◐',
};

export function CommandBar({ state, mode, initial, onClose, onRendererAction }: {
  state: State;
  mode: CommandBarMode;
  initial: string;
  onClose(): void;
  onRendererAction(id: string): void;
}) {
  const [query, setQuery] = useState(initial);
  const [site, setSite] = useState<SiteSearch | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  /** The query `results` belong to; Enter re-searches when typing has outrun the last response. */
  const resultsFor = useRef<string | null>(null);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    const n = ++seq.current;
    const q = fullQuery();
    void api.command<SearchResult[]>({ type: 'search', query: q }).then((r) => {
      if (n === seq.current) {
        resultsFor.current = q;
        setResults(r ?? []);
        setIndex(0);
      }
    });
  }, [query, site]);

  function fullQuery() {
    return site ? `${site.keyword} ${query}` : query;
  }

  const where: OpenWhere = mode === 'current' ? 'current' : mode === 'split' ? 'split' : 'newTab';

  const run = (r: SearchResult | undefined) => {
    if (!r) return;
    const q = site ? `${site.keyword} ${query}` : query;
    void api.command({ type: 'pickResult', query: q, key: r.key });
    onClose();
    if ('action' in r.run) return onRendererAction(r.run.action);
    let cmd: Command = r.run;
    if (cmd.type === 'open') cmd = { ...cmd, where };
    else if (cmd.type === 'select' && mode === 'split') cmd = { type: 'splitWith', id: '', withId: cmd.id };
    if (cmd.type === 'splitWith') {
      void api.getWindow().then((w) => w.selectedId && api.command({ ...cmd, id: w.selectedId } as Command));
      return;
    }
    if (cmd.type === 'runAction' && ['archive', 'library', 'settings', 'linkRules', 'newSpace', 'spaceManager', 'boost', 'history', 'commandBar', 'focusURL'].includes(cmd.id)) {
      return onRendererAction(cmd.id);
    }
    void api.command(cmd);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      return site ? setSite(null) : onClose();
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      setIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = fullQuery();
      if (resultsFor.current === q) run(results[index]);
      else void api.command<SearchResult[]>({ type: 'search', query: q }).then((r) => run(r?.[0]));
    } else if ((e.key === 'Tab' || e.key === ' ') && !site) {
      // "<keyword>" + Tab/Space turns into a Site Search for that site.
      const match = state.settings.siteSearches.find((s) => s.keyword.toLowerCase() === query.trim().toLowerCase());
      if (match && (e.key === 'Tab' || query.trim() === query)) {
        e.preventDefault();
        setSite(match);
        setQuery('');
      } else if (e.key === 'Tab') e.preventDefault();
    } else if (e.key === 'Backspace' && site && !query) {
      setSite(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="command-bar" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cb-input-row">
          {site && <span className="site-pill">{site.name}</span>}
          <input
            ref={input}
            value={query}
            placeholder={site ? `Search ${site.name}` : mode === 'split' ? 'Open beside this tab…' : 'Search, enter an address, or type a command…'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </div>
        {results.length > 0 && (
          <ul className="cb-results">
            {results.map((r, i) => (
              <li key={r.key + i} className={i === index ? 'active' : ''} onMouseEnter={() => setIndex(i)} onMouseDown={(e) => { e.preventDefault(); run(r); }}>
                <span className="cb-icon">{r.favicon !== undefined && r.kind === 'tab' ? <Favicon url="" known={r.favicon} size={16} /> : KIND_ICON[r.kind]}</span>
                <span className="cb-title">{r.title}</span>
                <span className="cb-sub">{r.subtitle}</span>
                {i === index && <span className="cb-enter">↵</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
