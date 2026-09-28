import { expect, it, vi } from 'vitest';
import { createImportBudget, deserializeImportSnapshot, readImportFile, readImportTree, serializeImportSnapshot, snapshotFingerprint } from '../files.js';
import type { ImportSnapshot } from '../types.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('reads an explicit native memory file link without granting traversal of external directories', async ctx => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-file-link-'));
  try {
    const memory = path.join(root, 'memory'), shared = path.join(root, 'shared');
    await fs.mkdir(memory); await fs.mkdir(shared);
    const target = path.join(shared, 'state.json'), link = path.join(memory, 'state.json');
    await fs.writeFile(target, '{"cursor":7}');
    try { await fs.symlink(target, link, 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return; } throw error; }
    await expect(readImportFile(memory, link)).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
    expect(await readImportTree(memory, undefined, createImportBudget(), undefined, memory, true)).toMatchObject([
      { name: 'state.json', bytes: Buffer.from('{"cursor":7}') },
    ]);
    await expect(readImportFile(memory, link, createImportBudget(1), true)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
    const directory = path.join(memory, 'external');
    await fs.symlink(shared, directory, process.platform === 'win32' ? 'junction' : 'dir');
    const errors = vi.fn();
    expect(await readImportTree(memory, undefined, createImportBudget(), errors, memory, true)).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith('external', expect.objectContaining({ code: 'SOURCE_LINK_OUTSIDE_FOLDER' }), 'directory');
    await expect(readImportFile(memory, path.join(directory, 'state.json'), undefined, true)).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
    await expect(readImportFile(memory, target, undefined, true)).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('rejects the next file before allocating its buffer when the cumulative budget is exhausted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-budget-test-'));
  try {
    const file = path.join(root, 'resource');
    await fs.writeFile(file, '1234');
    const budget = createImportBudget(270);
    expect((await readImportFile(root, file, budget)).bytes.toString()).toBe('1234');
    const allocate = vi.spyOn(Buffer, 'alloc');
    try {
      await expect(readImportFile(root, file, budget)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
      expect(allocate).not.toHaveBeenCalled();
    } finally { allocate.mockRestore(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('hashes binary contents and checkpoints compactly without invoking Buffer.toJSON', () => {
  const snapshot: ImportSnapshot = {
    source: { kind: 'hermes', name: 'Fixture', agentId: 'fixture', root: '/fixture', workspace: '/fixture', configFile: '/fixture/config' },
    fingerprint: 'fixture', items: [
      { view: { id: 'skill', category: 'skills', name: 'skill', selected: true }, files: [{ name: 'data.bin', bytes: Buffer.alloc(256 * 1024, 255), executable: false }] },
      { view: { id: 'script', category: 'connections', name: 'script', selected: true }, asset: { name: 'script.py', bytes: Buffer.from('print(1)') } },
    ],
  };
  const legacy = JSON.stringify(snapshot);
  const stringifyBuffer = vi.spyOn(Buffer.prototype, 'toJSON').mockImplementation(() => { throw new Error('numeric buffer expansion'); });
  try {
    const hash = snapshotFingerprint(snapshot.items);
    const checkpoint = serializeImportSnapshot(snapshot);
    expect(checkpoint.length).toBeLessThan(400_000);
    expect(deserializeImportSnapshot(checkpoint)).toEqual(snapshot);
    expect(deserializeImportSnapshot(legacy)).toEqual(snapshot);
    expect(snapshotFingerprint(deserializeImportSnapshot(checkpoint).items)).toBe(hash);
    snapshot.items[0]!.files![0]!.bytes[0] = 254;
    expect(snapshotFingerprint(snapshot.items)).not.toBe(hash);
    expect(stringifyBuffer).not.toHaveBeenCalled();
  } finally { stringifyBuffer.mockRestore(); }
});

it('reads every resource in a skill with more than 4096 small files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-many-files-'));
  try {
    for (let index = 0; index < 4100; index++) await fs.writeFile(path.join(root, `resource-${index}.txt`), `Resource ${index}`);
    const files = await readImportTree(root, undefined, createImportBudget());
    expect(files).toHaveLength(4100);
    expect(files.find(file => file.name === 'resource-4099.txt')?.bytes.toString()).toBe('Resource 4099');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('charges metadata for empty files and stops streaming instead of retaining unlimited errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-empty-files-'));
  try {
    for (let index = 0; index < 20; index++) await fs.writeFile(path.join(root, `${index}.txt`), '');
    const onError = vi.fn();
    await expect(readImportTree(root, undefined, createImportBudget(1000), onError)).rejects.toThrow('SOURCE_SNAPSHOT_TOO_LARGE');
    expect(onError).not.toHaveBeenCalled();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('retries a selected subtree inside its original root and still rejects escapes and cycles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-subtree-'));
  try {
    const memory = path.join(root, 'memory'); const outside = path.join(root, 'outside');
    await fs.mkdir(memory); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'note.md'), 'Outside');
    const link = path.join(memory, 'broken');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(outside, link, linkType);
    const failures: unknown[] = [];
    expect(await readImportTree(memory, undefined, createImportBudget(), (name, error, kind) => failures.push([name, (error as Error).message, kind]))).toEqual([]);
    expect(failures).toEqual([['broken', 'SOURCE_LINK_OUTSIDE_FOLDER', 'directory']]);
    await expect(readImportTree(memory, undefined, createImportBudget(), undefined, link)).rejects.toThrow('SOURCE_LINK_OUTSIDE_FOLDER');
    await fs.rm(link, { recursive: true });
    await fs.symlink(memory, link, linkType);
    await expect(readImportTree(memory, undefined, createImportBudget(), undefined, link)).rejects.toThrow('SOURCE_LINK_CYCLE');
    await fs.rm(link, { recursive: true });
    await fs.mkdir(link); await fs.writeFile(path.join(link, 'note.md'), 'Repaired');
    const files = await readImportTree(memory, undefined, createImportBudget(), undefined, link);
    expect(files.map(file => [file.name, file.bytes.toString()])).toEqual([['broken/note.md', 'Repaired']]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
