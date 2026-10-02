import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dir: '', owner: 'a', pending: false }));
vi.mock('electron', () => ({ app: { getPath: () => h.dir } }));
vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: h.owner }),
  isAppSessionBoundaryPending: () => h.pending,
  ownerScopedUserDataPath: (name: string) => path.join(h.dir, h.owner, name),
}));
vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));
vi.mock('../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: async (_path: string, _options: unknown, action: Function) =>
    action({ held: true }),
}));
import { customWallpaperStore, readCustomWallpaperUrl } from '../custom-wallpaper-settings';
import {
  readAppearanceSettings,
  resetAppearanceSettings,
  writeAppearanceSettingsPatch,
} from '../appearance-settings-store';

const urlA = `cindy-media://blobs/${'a'.repeat(64)}.webp`;
const urlB = `cindy-media://blobs/${'b'.repeat(64)}.webp`;
beforeEach(() => {
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallpaper-shared-'));
  h.owner = 'a';
  h.pending = false;
});
afterEach(() => fs.rmSync(h.dir, { recursive: true, force: true }));

function seedLegacy(owner: string, url: string) {
  fs.mkdirSync(path.join(h.dir, owner), { recursive: true });
  fs.writeFileSync(path.join(h.dir, owner, 'custom-wallpaper.json'), JSON.stringify({ url }));
}

describe('profile-wide wallpaper preference', () => {
  it('shares selection, replacement and reset across accounts, including sign-out', async () => {
    await customWallpaperStore.writePatchAtomic({ url: urlA });
    await writeAppearanceSettingsPatch({ wallpaperId: 'custom' });
    for (const owner of ['b', '']) {
      h.owner = owner;
      h.pending = true;
      expect(readAppearanceSettings()).toMatchObject({
        wallpaperId: 'custom',
        customWallpaperUrl: urlA,
      });
    }
    h.owner = 'b';
    h.pending = false;
    await customWallpaperStore.writePatchAtomic({ url: urlB });
    h.owner = 'a';
    expect(readAppearanceSettings()).toMatchObject({
      wallpaperId: 'custom',
      customWallpaperUrl: urlB,
    });
    await resetAppearanceSettings();
    h.owner = 'b';
    expect(readAppearanceSettings()).toMatchObject({
      wallpaperId: 'none',
      customWallpaperUrl: urlB,
    });
    await writeAppearanceSettingsPatch({ wallpaperId: 'cindy-dream' });
    h.owner = 'a';
    expect(readAppearanceSettings().wallpaperId).toBe('cindy-dream');
  });

  it('adopts the active preview image once, and never resurrects removed images from another account', async () => {
    seedLegacy('a', urlA);
    seedLegacy('b', urlB);
    await writeAppearanceSettingsPatch({ wallpaperId: 'custom' });
    expect(readAppearanceSettings()).toMatchObject({
      wallpaperId: 'custom',
      customWallpaperUrl: urlA,
    });
    h.owner = 'b';
    expect(readCustomWallpaperUrl()).toBe(urlA);
    await customWallpaperStore.writePatchAtomic({ url: '' }, { preserveDefaults: true });
    h.owner = 'a';
    expect(readAppearanceSettings()).toMatchObject({ wallpaperId: 'none', customWallpaperUrl: '' });
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'custom-wallpaper.json'), 'utf8'))).toEqual({
      url: '',
    });
  });

  it('waits for a settled active account before adopting a preview image', () => {
    seedLegacy('a', urlA);
    h.pending = true;
    expect(readCustomWallpaperUrl()).toBe('');
    h.pending = false;
    expect(readCustomWallpaperUrl()).toBe(urlA);
  });

  it('preserves unreadable shared settings instead of replacing them with a legacy image', async () => {
    seedLegacy('a', urlA);
    const target = path.join(h.dir, 'custom-wallpaper.json');
    fs.writeFileSync(target, '{broken');
    expect(readCustomWallpaperUrl()).toBe('');
    await expect(customWallpaperStore.writePatchAtomic({ url: urlB })).rejects.toThrow(
      'unreadable',
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('{broken');
  });
});
