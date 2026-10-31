// Captures are saved as PNG files under the app's data folder; the Library lists them.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export function capturesDir(): string {
  const dir = path.join(app.getPath('userData'), 'Captures');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function downloadsCapture(png: Buffer): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(capturesDir(), `Capture ${stamp}.png`);
  fs.writeFileSync(file, png);
  return file;
}

export function listCaptures(): { name: string; path: string; createdAt: number }[] {
  return fs
    .readdirSync(capturesDir())
    .filter((f) => f.endsWith('.png'))
    .map((f) => {
      const p = path.join(capturesDir(), f);
      return { name: f, path: p, createdAt: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
