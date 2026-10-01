import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { estimateWorkspace } from '../workspace';

it('counts hidden and nested files, skips root Git metadata and does not count directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  try {
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'objects'), 'excluded');
    await fs.writeFile(path.join(root, '.env'), 'abc');
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'file'), '12345');
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 2, bytes: 8 });
    await expect(
      estimateWorkspace(root, () => {
        throw new Error('owner changed');
      }),
    ).rejects.toThrow('owner changed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("skips other tasks' managed worktree directories only at a repository root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  try {
    for (const name of ['.cindy-worktrees', '.xdt-worktrees']) {
      await fs.mkdir(path.join(root, name, 'other-task'), { recursive: true });
      await fs.writeFile(path.join(root, name, 'other-task', 'file'), 'not copied');
    }
    await fs.mkdir(path.join(root, 'sub', '.cindy-worktrees'), { recursive: true });
    await fs.writeFile(path.join(root, 'sub', '.cindy-worktrees', 'file'), '1234');
    // A plain directory never holds Cindy worktrees: same-named folders are user files.
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 3, bytes: 24 });
    await fs.mkdir(path.join(root, '.git'));
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 1, bytes: 4 });
    // Only directories are skipped; a same-named file is still project content.
    await fs.rm(path.join(root, '.xdt-worktrees'), { recursive: true });
    await fs.writeFile(path.join(root, '.xdt-worktrees'), '12');
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 2, bytes: 6 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('stops an oversized directory before statting its entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  const lstat = vi.spyOn(fs, 'lstat');
  try {
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => fs.writeFile(path.join(root, `f${i}`), '')),
    );
    lstat.mockClear();
    await expect(estimateWorkspace(root, () => {}, 10)).rejects.toThrow('MIGRATION_TOO_MANY_FILES');
    // Only the repository probe ran; none of the 300 files were statted.
    expect(lstat.mock.calls.filter(([file]) => !String(file).endsWith('.git'))).toEqual([]);
  } finally {
    lstat.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('counts a wide, deep tree and stops once the file cap is exceeded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  try {
    for (let i = 0; i < 40; i++) {
      const directory = path.join(root, `d${i}`, 'nested');
      await fs.mkdir(directory, { recursive: true });
      await Promise.all(
        [0, 1, 2].map((j) => fs.writeFile(path.join(directory, `f${j}`), 'x'.repeat(j))),
      );
    }
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 120, bytes: 120 });
    expect(await estimateWorkspace(root, () => {}, 120)).toEqual({ fileCount: 120, bytes: 120 });
    await expect(estimateWorkspace(root, () => {}, 119)).rejects.toThrow(
      'MIGRATION_TOO_MANY_FILES',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
