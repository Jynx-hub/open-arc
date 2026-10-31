// Browsing history from Arc's Chromium profiles (User Data/<profile>/History, SQLite), read from a temp copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HistoryRow } from '../shared/importArc';

const PROFILE_DIR = /^(Default|Profile \d+)$/;

/** Web-page rows from every profile, newest first per profile (merge with `historyFromRows`). */
export async function readArcHistory(arcDir: string, limit: number): Promise<HistoryRow[]> {
  const base = path.join(arcDir, 'User Data');
  if (!fs.existsSync(base)) return [];
  const rows: HistoryRow[] = [];
  for (const dir of fs.readdirSync(base).filter((d) => PROFILE_DIR.test(d))) {
    const src = path.join(base, dir, 'History');
    if (!fs.existsSync(src)) continue;
    // Chromium locks the live file; work on a copy (plus its journal, if one is pending). The copy is
    // async because History files run to hundreds of MB and the main process must keep painting.
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'open-arc-history-'));
    try {
      await fs.promises.copyFile(src, path.join(tmp, 'History'));
      if (fs.existsSync(`${src}-journal`)) await fs.promises.copyFile(`${src}-journal`, path.join(tmp, 'History-journal'));
      const db = new DatabaseSync(path.join(tmp, 'History'));
      try {
        // Visit times are µs since 1601, too large for a double; convert to Unix ms in SQL.
        const stmt = db.prepare(
          `SELECT url, title, visit_count AS visits, (last_visit_time / 1000) - 11644473600000 AS lastVisitAt
           FROM urls WHERE hidden = 0 AND visit_count > 0 AND (url LIKE 'http://%' OR url LIKE 'https://%')
           ORDER BY last_visit_time DESC LIMIT ?`,
        );
        rows.push(...(stmt.all(limit) as unknown as HistoryRow[]));
      } finally {
        db.close();
      }
    } catch (err) {
      console.error(`skipping Arc history in ${dir}`, err);
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  }
  return rows;
}
