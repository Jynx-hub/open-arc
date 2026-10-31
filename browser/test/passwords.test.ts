import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../src/shared/csv';
import { loginOrigin, loginsFor, loginsFromCsv, loginsToCsv, mergeLogins, sameSite, saveKind, summarize, type Login } from '../src/shared/passwords';

let n = 0;
const id = () => `id${++n}`;
const login = (origin: string, username: string, password: string, updatedAt = 1): Login => ({ id: id(), origin, username, password, note: '', createdAt: 1, updatedAt });

describe('CSV', () => {
  it('reads quotes, commas and line breaks inside fields, CRLF and a BOM', () => {
    const text = '﻿name,url,username,password,note\r\nex,https://ex.com/,"a, b","pa""ss","line 1\nline 2"\r\n\r\nlast,https://l.com,u,p,';
    expect(parseCsv(text)).toEqual([
      ['name', 'url', 'username', 'password', 'note'],
      ['ex', 'https://ex.com/', 'a, b', 'pa"ss', 'line 1\nline 2'],
      ['last', 'https://l.com', 'u', 'p', ''],
    ]);
  });

  it('writes what it reads', () => {
    const rows = [['a', 'b,c'], ['"q"', 'x\ny'], ['', '']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('logins', () => {
  it('keeps only web logins with a password, by column name', () => {
    const rows = parseCsv('url,password,username,name\nhttps://a.com/login?x=1,pw,ann,a\nandroid://app,pw,bob,b\nhttps://b.com,,carl,c\nnot a url,pw,dan,d\n');
    const { logins, skipped } = loginsFromCsv(rows, 5, id);
    expect(skipped).toBe(3);
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({ origin: 'https://a.com', username: 'ann', password: 'pw', note: '', createdAt: 5 });
  });

  it('refuses a file without url and password columns', () => {
    expect(() => loginsFromCsv([['title', 'user']], 1, id)).toThrow(/url and password/);
  });

  it('matches the same scheme, host and port, with or without www', () => {
    expect(sameSite('https://example.com', 'https://www.example.com')).toBe(true);
    expect(sameSite('https://example.com', 'http://example.com')).toBe(false);
    expect(sameSite('https://example.com', 'https://evil-example.com')).toBe(false);
    expect(sameSite('https://example.com', 'https://login.example.com')).toBe(false);
    expect(sameSite('http://127.0.0.1:3000', 'http://127.0.0.1:4000')).toBe(false);
    expect(loginOrigin('https://Example.com:443/a')).toBe('https://example.com');
    expect(loginOrigin('javascript:alert(1)')).toBeNull();
  });

  it('lists a site’s logins newest first', () => {
    const all = [login('https://a.com', 'old', 'x', 1), login('https://b.com', 'b', 'x', 9), login('https://www.a.com', 'new', 'y', 5)];
    expect(loginsFor(all, 'https://a.com').map((l) => l.username)).toEqual(['new', 'old']);
  });

  it('merges by site and username, updating changed passwords', () => {
    const existing = [login('https://a.com', 'ann', 'old'), login('https://a.com', 'bob', 'same')];
    const incoming = [login('https://a.com', 'ann', 'new'), login('https://a.com', 'bob', 'same'), login('https://c.com', 'cat', 'pw')];
    const r = mergeLogins(existing, incoming, 7);
    expect([r.added, r.updated, r.unchanged]).toEqual([1, 1, 1]);
    expect(r.logins.find((l) => l.username === 'ann')).toMatchObject({ password: 'new', updatedAt: 7, id: existing[0]!.id });
  });

  it('treats www and the bare host as one site when merging', () => {
    const r = mergeLogins([login('https://x.com', 'alice', 'old')], [login('https://www.x.com', 'alice', 'new')], 3);
    expect([r.added, r.updated]).toEqual([0, 1]);
    expect(r.logins).toHaveLength(1);
  });

  it('exports in the column layout it imports', () => {
    const l = { ...login('https://a.com', 'ann', 'p,w'), note: 'n' };
    const back = loginsFromCsv(parseCsv(loginsToCsv([l])), 1, id).logins[0]!;
    expect(back).toMatchObject({ origin: l.origin, username: 'ann', password: 'p,w', note: 'n' });
  });

  it('offers to save new logins and update changed passwords only', () => {
    const all = [login('https://a.com', 'ann', 'pw')];
    expect(saveKind(all, 'https://a.com', 'ann', 'pw')).toBeNull();
    expect(saveKind(all, 'https://www.a.com', 'ann', 'new')).toBe('update');
    expect(saveKind(all, 'https://a.com', 'bob', 'pw')).toBe('save');
    expect(saveKind(all, 'https://a.com', 'ann', '')).toBeNull();
  });

  it('summaries never carry the password', () => {
    expect('password' in summarize(login('https://a.com', 'ann', 'secret'))).toBe(false);
  });
});
