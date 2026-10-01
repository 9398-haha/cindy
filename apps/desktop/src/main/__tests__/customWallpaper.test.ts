import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

const h = vi.hoisted(() => ({
  picker: vi.fn(),
  read: vi.fn(),
  ingest: vi.fn(),
  write: vi.fn(),
  reset: vi.fn(),
  remove: vi.fn(),
  removeId: vi.fn(),
  keep: vi.fn(),
  valid: vi.fn(),
  snapshot: { client: { drizzle: {} }, userId: 'test', clientEpoch: 1 },
}));
vi.mock('electron', () => ({ dialog: { showOpenDialog: h.picker } }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../utils/readBoundedFile.js', () => ({ readBoundedFileNoFollow: h.read }));
vi.mock('../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => h.snapshot }));
vi.mock('../appSessionState.js', () => ({ ownerScopedUserDataPath: () => 'test-lock' }));
vi.mock('../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: (_p: string, _o: unknown, fn: Function) => fn({ held: true }),
}));
vi.mock('../cindy-media/refCompensationJournal.js', () => ({
  captureMediaRefCompensationScope: () => ({ assertStillValid: h.valid }),
}));
vi.mock('../cindy-media/ingest.js', () => ({ ingestMedia: h.ingest }));
vi.mock('../cindy-media/ledger.js', () => ({
  removeRefById: h.removeId,
  removeRefs: h.remove,
  removeRefsExceptId: h.keep,
}));
vi.mock('../custom-wallpaper-settings.js', () => ({
  customWallpaperStore: { writePatchAtomic: h.write, resetAtomic: h.reset },
}));
import {
  importCustomWallpaper,
  prepareWallpaperImage,
  removeCustomWallpaper,
} from '../custom-wallpaper';

const url = `cindy-media://blobs/${'a'.repeat(64)}.webp`;
beforeEach(async () => {
  vi.resetAllMocks();
  h.picker.mockResolvedValue({ canceled: false, filePaths: ['chosen-image'] });
  h.read.mockResolvedValue(
    await sharp({ create: { width: 8, height: 4, channels: 3, background: 'blue' } })
      .png()
      .toBuffer(),
  );
  h.ingest.mockResolvedValue({ url, hash: 'a'.repeat(64), refIds: ['new-ref'] });
});

describe('custom wallpaper import', () => {
  it('decodes and pins the image before publishing, then removes only older wallpaper refs', async () => {
    expect(await importCustomWallpaper({} as never)).toBe(true);
    expect(h.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'image/webp',
        isCache: false,
        refs: [{ refKind: 'import', refId: 'desktop-custom-wallpaper', originKind: 'user' }],
        assertStillValid: expect.any(Function),
      }),
      h.snapshot.client.drizzle,
    );
    const metadata = await sharp(h.ingest.mock.calls[0][0].buffer).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 8, height: 4 });
    expect(metadata.exif).toBeUndefined();
    expect(h.write).toHaveBeenCalledWith({ url });
    expect(h.keep).toHaveBeenCalledWith(
      { refKind: 'import', refId: 'desktop-custom-wallpaper', keepId: 'new-ref' },
      h.snapshot.client.drizzle,
    );
    expect(h.ingest.mock.invocationCallOrder[0]).toBeLessThan(h.write.mock.invocationCallOrder[0]);
    expect(h.write.mock.invocationCallOrder[0]).toBeLessThan(h.keep.mock.invocationCallOrder[0]);
  });
  it('cancels without changing the preference or media', async () => {
    h.picker.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await importCustomWallpaper({} as never)).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('rejects invalid or unsupported files without publishing', async () => {
    h.read.mockResolvedValue(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>'),
    );
    await expect(importCustomWallpaper({} as never)).rejects.toThrow('INVALID_PARAMS');
    expect(h.ingest).not.toHaveBeenCalled();
    await expect(prepareWallpaperImage(Buffer.from('not an image'))).rejects.toThrow(
      'INVALID_PARAMS',
    );
    h.read.mockResolvedValue(null);
    await expect(importCustomWallpaper({} as never)).rejects.toThrow('INVALID_PARAMS');
  });
  it('compensates only the new reference when saving fails', async () => {
    h.write.mockRejectedValue(new Error('disk'));
    await expect(importCustomWallpaper({} as never)).rejects.toThrow('disk');
    expect(h.removeId).toHaveBeenCalledWith('new-ref', h.snapshot.client.drizzle);
    expect(h.keep).not.toHaveBeenCalled();
  });
  it('does not clear a successfully published image if old-reference cleanup fails', async () => {
    h.keep.mockRejectedValue(new Error('db'));
    expect(await importCustomWallpaper({} as never)).toBe(true);
    expect(h.removeId).not.toHaveBeenCalled();
  });
  it('rejects an owner switch while the picker is open', async () => {
    h.picker.mockImplementation(async () => {
      h.valid.mockImplementation(() => {
        throw new Error('owner changed');
      });
      return { canceled: false, filePaths: ['chosen-image'] };
    });
    await expect(importCustomWallpaper({} as never)).rejects.toThrow('owner changed');
    expect(h.read).not.toHaveBeenCalled();
    expect(h.ingest).not.toHaveBeenCalled();
  });
  it('forgets the preference before removing its references', async () => {
    await removeCustomWallpaper();
    expect(h.reset.mock.invocationCallOrder[0]).toBeLessThan(h.remove.mock.invocationCallOrder[0]);
    h.reset.mockRejectedValue(new Error('disk'));
    h.remove.mockClear();
    await expect(removeCustomWallpaper()).rejects.toThrow('disk');
    expect(h.remove).not.toHaveBeenCalled();
  });
});
