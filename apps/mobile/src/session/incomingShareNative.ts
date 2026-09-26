import { requireOptionalNativeModule } from 'expo-modules-core';
import { Directory } from 'expo-file-system';
import type { SharePayload } from 'expo-sharing';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

const native = requireOptionalNativeModule<{
  readSnapshot(): string | null;
  clearSnapshot(expected: string): boolean;
}>('CindyIncomingShare');
const snapshots = new WeakMap<SharePayload[], string>();
const CONSUMED_DIRECTORY = '.cindy-share-consumed';

type ShareCopyState = { handled: true } | { handled: false; directory?: Directory };

/** Only discard a managed copy when a successful directory listing proves it is gone.
 * File.exists alone also returns false for inaccessible files (e.g. device protection).
 */
function inspectShareCopy(uri: string): ShareCopyState {
  const match = /^(file:\/\/.*)\/(cindy-share-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/([^/]+)$/i.exec(uri);
  if (!match) return { handled: false };
  try {
    const root = new Directory(match[1]!);
    const directory = root.list().find((entry) => entry.name === match[2]);
    if (!directory) return { handled: true };
    if (!(directory instanceof Directory)) return { handled: false };
    const entries = directory.list();
    if (entries.some((entry) => entry instanceof Directory && entry.name === CONSUMED_DIRECTORY)) {
      return { handled: true };
    }
    const decodedUri = decodeURIComponent(uri);
    return entries.some((entry) => decodeURIComponent(entry.uri) === decodedUri)
      ? { handled: false, directory } : { handled: true };
  } catch {
    // An unreadable container is not proof of deletion; preserve the share.
    return { handled: false };
  }
}

export function getSharedPayloads(): SharePayload[] {
  const snapshot = native?.readSnapshot();
  if (!snapshot) return [];
  const raw: SharePayload[] = JSON.parse(snapshot).map((item: { value: string; type: SharePayload['shareType']; mimeType?: string }) => ({
    value: item.value, shareType: item.type, mimeType: item.mimeType,
  }));
  const payloads = raw.filter((payload) => !inspectShareCopy(payload.value).handled);
  snapshots.set(payloads, snapshot);
  if (raw.length > 0 && payloads.length === 0) {
    // Do not navigate to an empty draft, even when native acknowledgement fails.
    // The next foreground/start checks again without retaining a JS-only tombstone.
    try { clearSharedPayloads(payloads); } catch { /* Diagnosed by the adapter below. */ }
  }
  return payloads;
}

export function clearSharedPayloads(expected: SharePayload[]): void {
  const snapshot = snapshots.get(expected);
  if (snapshot === undefined) return;
  try {
    if (native?.clearSnapshot(snapshot)) return;
    // False normally means a newer share replaced this one. Never clear it.
    if (native?.readSnapshot() !== snapshot) return;
  } catch {
    mobileDebugLog('warn', 'files', 'Incoming share acknowledgement failed');
  }
  // Reuse the lifetime of the existing UUID-owned copies as the fallback receipt.
  // mkdir is synchronous: once the composer receives a file, cancelling it cannot
  // replay it after process death even if native-slot or file deletion failed.
  // A new share gets new UUID directories, including when sharing the same file.
  const pending = expected.map((payload) => inspectShareCopy(payload.value));
  if (pending.some((state) => !state.handled && !state.directory)) {
    throw new Error('INCOMING_SHARE_ACK_FAILED');
  }
  const created: Directory[] = [];
  try {
    for (const state of pending) {
      if (state.handled) continue;
      const marker = new Directory(state.directory!, CONSUMED_DIRECTORY);
      marker.create();
      created.push(marker);
    }
  } catch (error) {
    // No composer handoff has happened. Undo only receipts created by this call.
    for (const marker of created) { try { marker.delete(); } catch { /* Best effort. */ } }
    throw error;
  }
}
