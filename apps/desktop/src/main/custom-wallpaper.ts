import { dialog, type BrowserWindow } from 'electron';
import sharp from 'sharp';

import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { getCurrentDbClientSnapshot } from './localDb/client/current.js';
import { captureMediaRefCompensationScope } from './cindy-media/refCompensationJournal.js';
import { ingestMedia } from './cindy-media/ingest.js';
import { removeRefById, removeRefs, removeRefsExceptId } from './cindy-media/ledger.js';
import { customWallpaperStore } from './custom-wallpaper-settings.js';
import { createLogger } from './logger.js';
import { ownerScopedUserDataPath } from './appSessionState.js';
import { withCrossProcessLock } from './device-link/crossProcessLock.js';

const log = createLogger('custom-wallpaper');
const REF = { refKind: 'import' as const, refId: 'desktop-custom-wallpaper' };
const MAX_BYTES = 20 * 1024 * 1024;
let queue: Promise<unknown> = Promise.resolve();

function captureScope() {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throwIpcError('INTERNAL', 'Wallpaper storage is not ready');
  const compensation = captureMediaRefCompensationScope();
  const assertValid = () => {
    compensation.assertStillValid();
    if (getCurrentDbClientSnapshot() !== snapshot)
      throwIpcError('INTERNAL', 'Wallpaper owner changed');
  };
  return { db: snapshot.client.drizzle, compensation, assertValid };
}

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const lockPath = ownerScopedUserDataPath('custom-wallpaper-operation.lock');
  const result = queue
    .catch(() => undefined)
    .then(() =>
      withCrossProcessLock(
        lockPath,
        { label: 'custom-wallpaper', waitMs: 12_000 },
        async (status) => {
          if (!status.held)
            throwIpcError('INTERNAL', 'Wallpaper is being changed in another window');
          return action();
        },
      ),
    );
  queue = result;
  return result;
}

/** Decode real raster bytes, apply orientation, strip metadata and retain a static 4K preview. */
export async function prepareWallpaperImage(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > MAX_BYTES)
    throwIpcError('INVALID_PARAMS', 'Choose a PNG, JPEG or WebP image up to 20 MB');
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? ''))
      throw new Error('Unsupported image');
    return await image
      .rotate()
      .resize({ width: 3840, height: 3840, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
  } catch {
    throwIpcError('INVALID_PARAMS', 'Choose a valid PNG, JPEG or WebP image up to 40 megapixels');
  }
}

/** Paths come only from this native picker, never from the renderer or remote peers. */
export async function importCustomWallpaper(parent: BrowserWindow): Promise<boolean> {
  const scope = captureScope();
  return serialize(async () => {
    scope.assertValid();
    const selected = await dialog.showOpenDialog(parent, {
      properties: ['openFile'],
      filters: [{ name: 'PNG / JPEG / WebP', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    scope.assertValid();
    if (selected.canceled || !selected.filePaths[0]) return false;
    let bytes: Buffer;
    try {
      const read = await readBoundedFileNoFollow(selected.filePaths[0], MAX_BYTES, {
        nonBlocking: true,
      });
      if (!read) throw new Error('Unreadable image');
      bytes = read;
    } catch {
      throwIpcError('INVALID_PARAMS', 'Cannot read image; choose a local image up to 20 MB');
    }
    const buffer = await prepareWallpaperImage(bytes);
    scope.assertValid();
    const media = await ingestMedia(
      {
        buffer,
        mimeType: 'image/webp',
        isCache: false,
        refs: [{ ...REF, originKind: 'user' }],
        assertStillValid: scope.assertValid,
        refCompensationScope: scope.compensation,
      },
      scope.db,
    );
    try {
      scope.assertValid();
      await customWallpaperStore.writePatchAtomic({ url: media.url });
    } catch (error) {
      await Promise.allSettled(media.refIds.map((id) => removeRefById(id, scope.db)));
      throw error;
    }
    // Publication succeeded. Cleanup failure must retain the new selection and its pin.
    try {
      await removeRefsExceptId({ ...REF, keepId: media.refIds[0] }, scope.db);
    } catch {
      log.warn('Previous wallpaper reference cleanup deferred');
    }
    scope.assertValid();
    return true;
  });
}

export async function removeCustomWallpaper(): Promise<void> {
  const scope = captureScope();
  return serialize(async () => {
    scope.assertValid();
    // Forget the preference before unpinning; never delete shared media bytes here.
    await customWallpaperStore.resetAtomic();
    try {
      await removeRefs(REF, scope.db);
    } catch {
      log.warn('Removed wallpaper reference cleanup deferred');
    }
    scope.assertValid();
  });
}
