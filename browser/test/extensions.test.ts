import { describe, expect, it } from 'vitest';
import { fresh } from './helpers';
import { describeExtensionPermissions, isExtensionId, localized, newestVersion, pickIcon } from '../src/shared/extensions';
import { arcProfileId } from '../src/shared/importArc';
import { migrate } from '../src/shared/migrate';
import { DEFAULT_PROFILE_ID, STATE_VERSION } from '../src/shared/model';

describe('extension manifests', () => {
  it('resolves __MSG_ names case-insensitively, falling back when missing', () => {
    const messages = { appName: { message: 'Dark Reader' }, desc: {} };
    expect(localized('__MSG_appName__', messages, 'x')).toBe('Dark Reader');
    expect(localized('__MSG_APPNAME__', messages, 'x')).toBe('Dark Reader');
    expect(localized('__MSG_desc__', messages, 'fallback')).toBe('fallback');
    expect(localized('__MSG_gone__', null, 'id')).toBe('id');
    expect(localized('Plain Name', null, 'id')).toBe('Plain Name');
    expect(localized(undefined, messages, 'id')).toBe('id');
  });

  it('picks the smallest icon at least as big as asked, else the biggest', () => {
    expect(pickIcon({ '16': 'a.png', '48': 'b.png', '128': 'c.png' }, 32)).toBe('b.png');
    expect(pickIcon({ '16': 'a.png' }, 32)).toBe('a.png');
    expect(pickIcon(undefined, 32)).toBeNull();
  });

  it('orders version folders numerically', () => {
    expect(newestVersion(['1.2.9_0', '1.2.10_0', '1.10.0_0'])).toBe('1.10.0_0');
    expect(newestVersion([])).toBeNull();
  });

  it('recognizes Web Store ids only', () => {
    expect(isExtensionId('eimadpbcbfnmbkopoojfekhnkhdbieeh')).toBe(true);
    expect(isExtensionId('Temp')).toBe(false);
    expect(isExtensionId('../../etc/passwdaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });

  it('describes access: all sites in one line, a few named hosts, and the notable APIs only', () => {
    expect(describeExtensionPermissions(['<all_urls>', 'storage', 'tabs'])).toEqual(['Read and change everything on every website', 'See the addresses and titles of your tabs']);
    expect(describeExtensionPermissions(['https://*.github.com/*', 'https://example.com/'])).toEqual(['Read and change your data on github.com, example.com']);
    expect(describeExtensionPermissions(['a://one/', 'a://two/', 'a://three/', 'a://four/', 'a://five/'])[0]).toBe('Read and change your data on one, two, three and 2 more sites');
    expect(describeExtensionPermissions(['storage', 'alarms'])).toEqual([]);
    expect(describeExtensionPermissions(['*://*/'])).toEqual(['Read and change everything on every website']);
    expect(describeExtensionPermissions(['file:///*'])).toEqual(['Read files from this Mac that you open in a tab']);
  });

  it('maps Arc profile folders to our Profile ids, as the import does', () => {
    expect(arcProfileId('Default')).toBe(DEFAULT_PROFILE_ID);
    expect(arcProfileId('default')).toBe(DEFAULT_PROFILE_ID);
    expect(arcProfileId('Profile 1')).toBe('p-profile-1');
  });
});

describe('state migration v4 → v5', () => {
  it('adds no pinned extensions', () => {
    const v4 = structuredClone(fresh()) as any;
    v4.version = 4;
    delete v4.settings.pinnedExtensions;
    const out = migrate(v4);
    expect(out.version).toBe(STATE_VERSION);
    expect(out.settings.pinnedExtensions).toEqual({});
  });
});
