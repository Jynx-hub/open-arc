// Extensions installed in Arc, to offer reinstalling them from the Chrome Web Store. Only each manifest's
// name (and its locale file, for a translated name) is read; extension code is never copied.
import path from 'node:path';
import fs from 'node:fs';
import { isExtensionId, localized, type ArcExtension, type Manifest } from '../shared/extensions';
import { installedIn, readJson } from './extensions';

const PROFILE_DIR = /^(Default|Profile \d+)$/;

export function listArcExtensions(arcDir: string): ArcExtension[] {
  const base = path.join(arcDir, 'User Data');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base)
    .filter((d) => PROFILE_DIR.test(d))
    .flatMap((profileDir) =>
      // `Temp` and other non-id folders are Chromium's own.
      installedIn(path.join(base, profileDir, 'Extensions'))
        .filter(({ id }) => isExtensionId(id))
        .map(({ id, dir }) => {
          const manifest = readJson<Manifest>(path.join(dir, 'manifest.json'));
          const messages = manifest?.default_locale ? readJson<Record<string, { message?: string }>>(path.join(dir, '_locales', manifest.default_locale, 'messages.json')) : null;
          return { id, name: localized(manifest?.name, messages, id), profileDir };
        }),
    );
}
