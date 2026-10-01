import { createHash } from 'node:crypto';
import manifest from '../shared/wallpaper-video-manifest.json';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from './appSessionState.js';
import { getCurrentDbClientSnapshot } from './localDb/client/current.js';
import { captureMediaRefCompensationScope } from './cindy-media/refCompensationJournal.js';
import { ingestMedia } from './cindy-media/ingest.js';
import { getIntegrationCacheHash, removeRefsExceptId, touchBlob } from './cindy-media/ledger.js';
import { resolveHashRef } from './cindy-media/blobStore.js';
import { readBoundedFileNoFollow } from './utils/readBoundedFile.js';
import { getClientEndpoint } from './clientEndpointsService.js';
import { guardedOutboundFetch } from './maker-host/outbound-fetch.js';
import { throwIpcError } from './utils/ipcValidate.js';

type Scene = keyof typeof manifest;
type Asset = { sha256: string; bytes: number };
const RETRY_MS = 5 * 60_000;
const states = new WeakMap<object, Map<Scene, { pending?: Promise<string | null>; retryAt: number }>>();

export function isWallpaperVideoScene(id: unknown): id is Scene {
  return typeof id === 'string' && Object.hasOwn(manifest, id);
}

export function matchesWallpaperVideo(bytes: Buffer, asset: Asset): boolean {
  // The pinned digest identifies reviewed MP4 bytes, not server-supplied MIME claims.
  return bytes.length === asset.bytes && createHash('sha256').update(bytes).digest('hex') === asset.sha256;
}

async function download(asset: Asset, assertValid: () => void): Promise<Buffer> {
  const base = getClientEndpoint('cdnBaseUrl');
  if (!base) throw new Error('Wallpaper CDN unavailable');
  const url = new URL(base.replace(/\/+$/, '') + '/wallpapers/' + asset.sha256 + '.mp4');
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid wallpaper CDN');
  const { response, release } = await guardedOutboundFetch(url.href, {
    signal: AbortSignal.timeout(30_000), credentials: 'omit', redirect: 'error',
  }, assertValid);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    assertValid();
    if (!response.ok || !response.body) throw new Error('Wallpaper CDN unavailable');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== asset.bytes) throw new Error('Wallpaper size mismatch');
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      assertValid();
      if (done) break;
      size += value.byteLength;
      if (size > asset.bytes) throw new Error('Wallpaper exceeds expected size');
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    if (!matchesWallpaperVideo(bytes, asset)) throw new Error('Wallpaper integrity mismatch');
    return bytes;
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
    else await response.body?.cancel().catch(() => undefined);
    await release();
  }
}

/** Optional enhancement: failure never prevents the bundled video from playing. */
export async function ensureWallpaperVideo(id: unknown): Promise<string | null> {
  if (!isWallpaperVideoScene(id)) throwIpcError('INVALID_PARAMS', 'Unsupported wallpaper video');
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot || isAppSessionBoundaryPending()) return null;
  let state = states.get(snapshot);
  if (!state) states.set(snapshot, state = new Map());
  const previous = state.get(id);
  if (previous?.pending) return previous.pending;
  if (previous && previous.retryAt > Date.now()) return null;
  const entry = { retryAt: 0, pending: undefined as Promise<string | null> | undefined };
  state.set(id, entry);
  entry.pending = (async () => {
    try {
      const owner = activeOwnerScopeKey();
      const compensation = captureMediaRefCompensationScope();
      const assertValid = () => {
        compensation.assertStillValid();
        if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner || getCurrentDbClientSnapshot() !== snapshot)
          throw new Error('Wallpaper owner changed');
      };
      assertValid();
      const db = snapshot.client.drizzle;
      const asset = manifest[id];
      const ref = { refKind: 'integration-cache' as const, refId: 'wallpaper:' + asset.sha256 };
      const cached = await getIntegrationCacheHash(ref.refId, db);
      assertValid();
      if (cached === asset.sha256) {
        const bytes = await readBoundedFileNoFollow(resolveHashRef(cached, '.mp4').absPath, asset.bytes).catch(() => null);
        assertValid();
        if (bytes && matchesWallpaperVideo(bytes, asset)) {
          await touchBlob(cached, db);
          assertValid();
          return 'cindy-media://blobs/' + cached + '.mp4';
        }
      }
      const bytes = await download(asset, assertValid);
      assertValid();
      const media = await ingestMedia({
        buffer: bytes, mimeType: 'video/mp4', isCache: true,
        refs: [{ ...ref, originKind: 'integration' }],
        assertStillValid: assertValid, refCompensationScope: compensation,
      }, db);
      assertValid();
      // Repair/retry remains idempotent; never remove another feature's references.
      await removeRefsExceptId({ ...ref, keepId: media.refIds[0] }, db);
      assertValid();
      return media.url;
    } catch {
      entry.retryAt = Date.now() + RETRY_MS;
      return null;
    }
  })().finally(() => { entry.pending = undefined; });
  return entry.pending;
}
