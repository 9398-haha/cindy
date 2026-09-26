import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ readSnapshot: vi.fn(), clearSnapshot: vi.fn() }));
const fs = vi.hoisted(() => {
  const listings = new Map<string, Array<{ uri: string; name: string }> | Error>();
  const failCreate = new Set<string>();
  class Directory {
    uri: string;
    constructor(parent: string | Directory, name?: string) {
      this.uri = `${typeof parent === 'string' ? parent : parent.uri}${name ? `/${name}` : ''}`;
    }
    get name() { return this.uri.split('/').at(-1)!; }
    list(): Array<{ uri: string; name: string }> {
      const value = listings.get(this.uri);
      if (!value || value instanceof Error) throw value ?? new Error('unavailable');
      return value;
    }
    create() {
      if (failCreate.has(this.uri)) throw new Error('disk full');
      const parent = new Directory(this.uri.slice(0, this.uri.lastIndexOf('/')));
      const entries = parent.list();
      if (entries.some((entry) => entry.name === this.name)) throw new Error('already exists');
      entries.push(this);
      listings.set(this.uri, []);
    }
    delete() {
      const parent = new Directory(this.uri.slice(0, this.uri.lastIndexOf('/')));
      listings.set(parent.uri, parent.list().filter((entry) => entry.uri !== this.uri));
      listings.delete(this.uri);
    }
  }
  return { Directory, listings, failCreate };
});
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native }));
vi.mock('expo-file-system', () => ({ Directory: fs.Directory }));
import { getSharedPayloads, clearSharedPayloads } from '@/session/incomingShareNative';

beforeEach(() => {
  vi.resetAllMocks();
  fs.listings.clear();
  fs.failCreate.clear();
  native.clearSnapshot.mockReturnValue(true);
});

it('acknowledges the exact captured bytes, not a subsequent read or re-encoded payload', () => {
  const first = '[ { "type":"file", "value":"file:///a/report.pdf", "mimeType":"application/pdf" } ]';
  native.readSnapshot.mockReturnValueOnce(first).mockReturnValueOnce('[]');
  const payloads = getSharedPayloads();
  expect(payloads).toEqual([{ shareType: 'file', value: 'file:///a/report.pdf', mimeType: 'application/pdf' }]);
  getSharedPayloads();
  clearSharedPayloads(payloads);
  expect(native.clearSnapshot).toHaveBeenCalledWith(first);
  expect(native.readSnapshot).toHaveBeenCalledTimes(2);
});

it('never clears a slot for an unknown array or missing native snapshot', () => {
  native.readSnapshot.mockReturnValue(null);
  clearSharedPayloads(getSharedPayloads());
  clearSharedPayloads([]);
  expect(native.clearSnapshot).not.toHaveBeenCalled();
});

const root = 'file:///group';
const directory = new fs.Directory(`${root}/cindy-share-12345678-1234-1234-1234-123456789abc`);
const uri = `${directory.uri}/report.pdf`;
const snapshot = JSON.stringify([{ type: 'file', value: uri }]);

it.each(['directory', 'file'])('does not replay a share whose %s was deleted before restart', (missing) => {
  fs.listings.set(root, missing === 'directory' ? [] : [directory]);
  fs.listings.set(directory.uri, []);
  native.readSnapshot.mockReturnValue(snapshot);
  expect(getSharedPayloads()).toEqual([]);
  expect(native.clearSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
  // There is no in-memory consumed flag: a fresh read must also reject the orphan.
  expect(getSharedPayloads()).toEqual([]);
});

it('does not navigate to an orphan even if native clearing fails', () => {
  fs.listings.set(root, []);
  native.readSnapshot.mockReturnValue(snapshot);
  native.clearSnapshot.mockImplementation(() => { throw new Error('native write failed'); });
  expect(getSharedPayloads()).toEqual([]);
  expect(getSharedPayloads()).toEqual([]);
});

it.each(['root', 'directory'])('preserves shares when the %s cannot be read', (inaccessible) => {
  fs.listings.set(root, inaccessible === 'root' ? new Error('protected') : [directory]);
  fs.listings.set(directory.uri, new Error('protected'));
  native.readSnapshot.mockReturnValue(snapshot);
  expect(getSharedPayloads()).toEqual([{ shareType: 'file', value: uri, mimeType: undefined }]);
  expect(native.clearSnapshot).not.toHaveBeenCalled();
});

it('preserves a real file with Unicode, spaces and literal percent escapes in its name', () => {
  const encodedUri = `${directory.uri}/${encodeURIComponent('讨论稿 100% %20.pdf')}`;
  fs.listings.set(root, [directory]);
  fs.listings.set(directory.uri, [{ uri: encodedUri, name: encodedUri.split('/').at(-1)! }]);
  native.readSnapshot.mockReturnValue(JSON.stringify([{ type: 'file', value: encodedUri }]));
  expect(getSharedPayloads()).toHaveLength(1);
  expect(native.clearSnapshot).not.toHaveBeenCalled();
});

it('keeps valid files in a mixed batch and acknowledges the original bytes only after consumption', () => {
  const live = `${directory.uri}/live.pdf`;
  const mixed = JSON.stringify([{ type: 'file', value: uri }, { type: 'file', value: live }]);
  fs.listings.set(root, [directory]);
  fs.listings.set(directory.uri, [{ uri: live, name: 'live.pdf' }]);
  native.readSnapshot.mockReturnValue(mixed);
  const payloads = getSharedPayloads();
  expect(payloads).toEqual([{ shareType: 'file', value: live, mimeType: undefined }]);
  expect(native.clearSnapshot).not.toHaveBeenCalled();
  clearSharedPayloads(payloads);
  expect(native.clearSnapshot).toHaveBeenCalledExactlyOnceWith(mixed);
});

it('never clears a newer share that arrives during stale-file inspection', () => {
  let slot = snapshot;
  native.readSnapshot.mockImplementation(() => slot);
  native.clearSnapshot.mockImplementation((expected) => {
    if (slot === expected) slot = '';
    return slot === '';
  });
  const next = '[{"type":"file","value":"file:///new/report.pdf"}]';
  fs.listings.set(root, []);
  const list = vi.spyOn(fs.Directory.prototype, 'list').mockImplementationOnce(() => {
    slot = next;
    return [];
  });
  expect(getSharedPayloads()).toEqual([]);
  expect(slot).toBe(next);
  expect(getSharedPayloads()).toHaveLength(1);
  list.mockRestore();
});

it('leaves unmanaged paths and remote URLs to the existing share handling', () => {
  native.readSnapshot.mockReturnValue(JSON.stringify([
    { type: 'file', value: 'file:///original.pdf' },
    { type: 'url', value: 'https://example.com/report.pdf' },
  ]));
  expect(getSharedPayloads()).toHaveLength(2);
  expect(native.clearSnapshot).not.toHaveBeenCalled();
});

it.each(['throw', 'false'])('does not replay existing files after native acknowledgement returns %s', async (failure) => {
  fs.listings.set(root, [directory]);
  fs.listings.set(directory.uri, [{ uri, name: 'report.pdf' }]);
  native.readSnapshot.mockReturnValue(snapshot);
  native.clearSnapshot.mockImplementation(() => {
    if (failure === 'throw') throw new Error('native storage failed');
    return false;
  });
  clearSharedPayloads(getSharedPayloads());
  expect(directory.list().some((entry) => entry.uri === uri)).toBe(true);
  // Simulate process death: native storage and filesystem survive; JS receipts do not.
  vi.resetModules();
  const restarted = await import('@/session/incomingShareNative');
  expect(restarted.getSharedPayloads()).toEqual([]);
  // Explicitly sharing the same named file again produces a fresh UUID directory.
  const nextDirectory = new fs.Directory(`${root}/cindy-share-abcdefab-1234-1234-1234-123456789abc`);
  const nextUri = `${nextDirectory.uri}/report.pdf`;
  fs.listings.set(root, [directory, nextDirectory]);
  fs.listings.set(nextDirectory.uri, [{ uri: nextUri, name: 'report.pdf' }]);
  native.readSnapshot.mockReturnValue(JSON.stringify([{ type: 'file', value: nextUri }]));
  expect(restarted.getSharedPayloads()).toEqual([{ shareType: 'file', value: nextUri, mimeType: undefined }]);
});

it('never overwrites a source file named like the receipt directory', () => {
  const collisionUri = `${directory.uri}/.cindy-share-consumed`;
  fs.listings.set(root, [directory]);
  fs.listings.set(directory.uri, [{ uri: collisionUri, name: '.cindy-share-consumed' }]);
  native.readSnapshot.mockReturnValue(JSON.stringify([{ type: 'file', value: collisionUri }]));
  native.clearSnapshot.mockImplementation(() => { throw new Error('native storage failed'); });
  const payloads = getSharedPayloads();
  expect(payloads).toHaveLength(1);
  expect(() => clearSharedPayloads(payloads)).toThrow('already exists');
  expect(directory.list()).toEqual([{ uri: collisionUri, name: '.cindy-share-consumed' }]);
});

it('rolls back partial receipts when acknowledgement fails for a multi-file share', () => {
  const other = new fs.Directory(`${root}/cindy-share-abcdefab-1234-1234-1234-123456789abc`);
  const otherUri = `${other.uri}/report.pdf`;
  fs.listings.set(root, [directory, other]);
  fs.listings.set(directory.uri, [{ uri, name: 'report.pdf' }]);
  fs.listings.set(other.uri, [{ uri: otherUri, name: 'report.pdf' }]);
  native.readSnapshot.mockReturnValue(JSON.stringify([
    { type: 'file', value: uri }, { type: 'file', value: otherUri },
  ]));
  native.clearSnapshot.mockImplementation(() => { throw new Error('native storage failed'); });
  fs.failCreate.add(`${other.uri}/.cindy-share-consumed`);
  expect(() => clearSharedPayloads(getSharedPayloads())).toThrow('disk full');
  expect(getSharedPayloads()).toHaveLength(2);
  expect(directory.list()).toEqual([{ uri, name: 'report.pdf' }]);
});
