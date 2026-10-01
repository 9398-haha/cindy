import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ipcOn: vi.fn(),
  ipcHandle: vi.fn(),
  allWindows: [] as Array<unknown>,
  trustedRead: vi.fn(),
  trustedReadWindow: vi.fn(),
  assertTrustedAppRendererEvent: vi.fn(),
  readAppearanceSettings: vi.fn(),
  readAppearanceSettingsState: vi.fn(),
  writeAppearanceSettingsPatch: vi.fn(),
  resetAppearanceSettings: vi.fn(),
  updateAppearanceSettingsAtomic: vi.fn(),
  owner: 'owner-a:1',
  boundaryPending: false,
  importWallpaper: vi.fn(),
  removeWallpaper: vi.fn(),
  ensureVideo: vi.fn(),
}));

vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => mocks.owner,
  isAppSessionBoundaryPending: () => mocks.boundaryPending,
}));
vi.mock('../custom-wallpaper.js', () => ({
  importCustomWallpaper: mocks.importWallpaper,
  removeCustomWallpaper: mocks.removeWallpaper,
}));
vi.mock('../wallpaper-video.js', () => ({ ensureWallpaperVideo: mocks.ensureVideo }));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.allWindows, fromWebContents: () => ({}) },
  ipcMain: { on: mocks.ipcOn, handle: mocks.ipcHandle },
}));

vi.mock('../appearance-settings-reader.js', () => ({
  isTrustedAppearanceSettingsReadEvent: mocks.trustedRead,
  isTrustedAppearanceSettingsReadWindow: mocks.trustedReadWindow,
}));

vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.assertTrustedAppRendererEvent,
}));

vi.mock('../appearance-settings-store.js', () => ({
  readAppearanceSettings: mocks.readAppearanceSettings,
  readAppearanceSettingsState: mocks.readAppearanceSettingsState,
  writeAppearanceSettingsPatch: mocks.writeAppearanceSettingsPatch,
  resetAppearanceSettings: mocks.resetAppearanceSettings,
  updateAppearanceSettingsAtomic: mocks.updateAppearanceSettingsAtomic,
}));

import { registerAppearanceSettingsIpc, __testing } from '../appearance-settings-ipc.js';
import { normalizeAppearanceSettings } from '../../shared/appearanceSettings.js';

const persisted = {
  uiFamily: 'Inter',
  codeFamily: 'JetBrains Mono',
  uiSize: 15,
  codeSize: 14,
  windowZoom: 1.1,
};

describe('appearance settings IPC authorization', () => {
  it('authorizes the CDN video request and rechecks owner after download', async () => {
    const handler = mocks.ipcHandle.mock.calls.find(([name]) => name === 'appearance-settings:ensure-wallpaper-video')?.[1];
    mocks.ensureVideo.mockResolvedValueOnce(null);
    expect(await handler({}, 'cindy-window')).toBeNull();
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenCalled();
    mocks.ensureVideo.mockImplementationOnce(async () => { mocks.owner = 'owner-b:2'; return 'old-owner-url'; });
    await expect(handler({}, 'cindy-window')).rejects.toThrow('Wallpaper owner changed');
  });
  it('rejects an untrusted CDN request before starting a download', async () => {
    mocks.assertTrustedAppRendererEvent.mockImplementation(() => { throw new Error('untrusted'); });
    const handler = mocks.ipcHandle.mock.calls.find(([name]) => name === 'appearance-settings:ensure-wallpaper-video')?.[1];
    await expect(handler({}, 'cindy-window')).rejects.toThrow('untrusted');
    expect(mocks.ensureVideo).not.toHaveBeenCalled();
  });
  it.each(['appearance-settings:import-wallpaper', 'appearance-settings:remove-wallpaper'])(
    'rejects %s when the owner changes during module loading',
    async (channel) => {
      const handler = mocks.ipcHandle.mock.calls.find(([name]) => name === channel)?.[1];
      const pending = handler({ sender: {} });
      mocks.owner = 'owner-b:2';
      await expect(pending).rejects.toThrow('Unable to');
      expect(mocks.importWallpaper).not.toHaveBeenCalled();
      expect(mocks.removeWallpaper).not.toHaveBeenCalled();
    },
  );
  it.each(['appearance-settings:import-wallpaper', 'appearance-settings:remove-wallpaper'])(
    'rejects %s while the owner boundary is pending',
    async (channel) => {
      const handler = mocks.ipcHandle.mock.calls.find(([name]) => name === channel)?.[1];
      const pending = handler({ sender: {} });
      mocks.boundaryPending = true;
      await expect(pending).rejects.toThrow('Unable to');
      expect(mocks.importWallpaper).not.toHaveBeenCalled();
      expect(mocks.removeWallpaper).not.toHaveBeenCalled();
    },
  );
  it('does not let a renderer inject a path or media URL through the generic preference channel', () => {
    expect(__testing.parsePatch({ wallpaperId: 'custom' })).toEqual({ wallpaperId: 'custom' });
    expect(() =>
      __testing.parsePatch({ customWallpaperUrl: `cindy-media://blobs/${'a'.repeat(64)}.webp` }),
    ).toThrow('unknown appearance field');
    expect(() => __testing.parsePatch({ wallpaperPath: '/private.png' })).toThrow(
      'unknown appearance field',
    );
  });
  it.each(['appearance-settings:import-wallpaper', 'appearance-settings:remove-wallpaper'])(
    'rejects untrusted callers before %s can access a picker or media',
    async (channel) => {
      mocks.assertTrustedAppRendererEvent.mockImplementation(() => {
        throw new Error('untrusted');
      });
      const handler = mocks.ipcHandle.mock.calls.find(([name]) => name === channel)?.[1];
      await expect(handler({})).rejects.toThrow('untrusted');
    },
  );
  it('validates motion choices and preserves the static default for old settings', () => {
    expect(normalizeAppearanceSettings({ wallpaperId: 'cindy-window' }).wallpaperMotion).toBe(
      'static',
    );
    expect(__testing.parsePatch({ wallpaperMotion: 'dynamic' })).toEqual({
      wallpaperMotion: 'dynamic',
    });
    expect(__testing.parsePatch({ wallpaperMotion: 'static' })).toEqual({
      wallpaperMotion: 'static',
    });
    expect(() => __testing.parsePatch({ wallpaperMotion: 'auto' })).toThrow();
  });
  beforeAll(() => {
    registerAppearanceSettingsIpc();
  });

  beforeEach(() => {
    mocks.owner = 'owner-a:1';
    mocks.boundaryPending = false;
    mocks.importWallpaper.mockReset();
    mocks.removeWallpaper.mockReset();
    mocks.ensureVideo.mockReset();
    mocks.allWindows.length = 0;
    mocks.trustedRead.mockReset();
    mocks.trustedReadWindow.mockReset().mockReturnValue(false);
    mocks.assertTrustedAppRendererEvent.mockReset();
    mocks.readAppearanceSettings.mockReset().mockReturnValue(persisted);
  });

  it('同步启动读取只向已授权的外观 reader 返回持久快照', () => {
    const handler = mocks.ipcOn.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:get-sync',
    )?.[1] as (event: { returnValue?: unknown }) => void;

    mocks.trustedRead.mockReturnValue(true);
    const trustedEvent: { returnValue?: unknown } = {};
    handler(trustedEvent);
    expect(trustedEvent.returnValue).toEqual(persisted);

    mocks.trustedRead.mockReturnValue(false);
    const untrustedEvent: { returnValue?: unknown } = {};
    handler(untrustedEvent);
    expect(untrustedEvent.returnValue).toBeNull();
  });

  it('异步读取和写通道继续使用 app-content 高权限断言', async () => {
    const getHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:get',
    )?.[1] as (event: unknown) => unknown;
    const setHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:set-patch',
    )?.[1] as (event: unknown, patch: unknown) => Promise<unknown>;
    const resetHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:reset',
    )?.[1] as (event: unknown) => Promise<unknown>;

    mocks.readAppearanceSettingsState.mockReturnValue({ value: persisted, overrides: {} });
    mocks.writeAppearanceSettingsPatch.mockResolvedValue(persisted);
    mocks.resetAppearanceSettings.mockResolvedValue(persisted);

    const event = {};
    getHandler(event);
    await setHandler(event, { uiSize: 15 });
    await resetHandler(event);

    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenCalledTimes(3);
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(1, event);
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(2, event);
    expect(mocks.assertTrustedAppRendererEvent).toHaveBeenNthCalledWith(3, event);
  });

  it('外观变更广播也覆盖显式授权的 utility 窗口', async () => {
    const setHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:set-patch',
    )?.[1] as (event: unknown, patch: unknown) => Promise<unknown>;
    const allowedSend = vi.fn();
    const deniedSend = vi.fn();
    const allowed = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: allowedSend },
    };
    const denied = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: deniedSend },
    };
    mocks.allWindows.push(allowed, denied);
    mocks.trustedReadWindow.mockImplementation((win) => win === allowed);
    mocks.writeAppearanceSettingsPatch.mockResolvedValue(persisted);

    await setHandler({}, { uiSize: 15 });

    expect(allowedSend).toHaveBeenCalledWith('appearance-settings:changed', persisted);
    expect(deniedSend).not.toHaveBeenCalled();
  });

  it('accepts a validated wallpaper patch', async () => {
    const setHandler = mocks.ipcHandle.mock.calls.find(
      ([channel]) => channel === 'appearance-settings:set-patch',
    )?.[1] as (event: unknown, patch: unknown) => Promise<unknown>;
    mocks.writeAppearanceSettingsPatch.mockResolvedValue(persisted);

    await setHandler(
      {},
      {
        wallpaperId: 'cindy-window',
        wallpaperOverlay: 0.35,
      },
    );

    expect(mocks.writeAppearanceSettingsPatch).toHaveBeenCalledWith({
      wallpaperId: 'cindy-window',
      wallpaperOverlay: 0.35,
    });
  });
  it.each(['cindy', 'cindy-portrait', 'aurora', 'sunset', 'paper'])(
    'rejects retired wallpaper %s at the write boundary',
    async (wallpaperId) => {
      const setHandler = mocks.ipcHandle.mock.calls.find(
        ([channel]) => channel === 'appearance-settings:set-patch',
      )?.[1] as (event: unknown, patch: unknown) => Promise<unknown>;
      await expect(setHandler({}, { wallpaperId })).rejects.toThrow('wallpaperId is not supported');
    },
  );
});
