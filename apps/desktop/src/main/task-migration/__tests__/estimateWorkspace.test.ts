import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

it("skips only other tasks' registered worktrees, never other content of those folders", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-')));
  const git = (...args: string[]) =>
    execFileSync('git', [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@localhost',
      '-c',
      'commit.gpgsign=false',
      '-C',
      root,
      ...args,
    ]);
  try {
    await fs.writeFile(path.join(root, 'a'), 'a');
    await fs.mkdir(path.join(root, '.cindy-worktrees', 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, '.cindy-worktrees', 'notes', 'n'), 'xy');
    await fs.mkdir(path.join(root, '.xdt-worktrees', 'stale'), { recursive: true });
    await fs.writeFile(path.join(root, '.xdt-worktrees', 'stale', 'old'), 'zzz');
    // A plain directory excludes nothing, even with stray `.git` metadata at its root.
    await fs.mkdir(path.join(root, '.git'));
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 3, bytes: 6 });
    await fs.rm(path.join(root, '.git'), { recursive: true });
    git('init', '-q');
    git('add', 'a');
    git('commit', '-q', '-m', 'fixture');
    git('worktree', 'add', '-q', '-b', 'other', path.join('.cindy-worktrees', 'other-task'));
    // Only the registered worktree is skipped; user folders beside it and an unregistered
    // folder in a managed container are still project content.
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 3, bytes: 6 });
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

it('stops at the file cap even when every entry type is unknown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  const readdir = fs.readdir.bind(fs);
  const unknown = vi.spyOn(fs, 'readdir').mockImplementation((async (
    directory: string,
    options: unknown,
  ) =>
    (await readdir(directory, options as { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    }))) as never);
  const lstat = vi.spyOn(fs, 'lstat');
  try {
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => fs.writeFile(path.join(root, `f${i}`), '')),
    );
    lstat.mockClear();
    await expect(estimateWorkspace(root, () => {}, 10)).rejects.toThrow('MIGRATION_TOO_MANY_FILES');
    // Classifying the 11th file is the last per-file work; the other 289 are never statted.
    expect(lstat.mock.calls.length).toBeLessThanOrEqual(11);
  } finally {
    lstat.mockRestore();
    unknown.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('classifies entries of unknown type with lstat instead of rejecting them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-estimate-'));
  const readdir = fs.readdir.bind(fs);
  const unknown = vi.spyOn(fs, 'readdir').mockImplementation((async (
    directory: string,
    options: unknown,
  ) =>
    (await readdir(directory, options as { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    }))) as never);
  try {
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'file'), '12345');
    await fs.writeFile(path.join(root, 'top'), 'ab');
    expect(await estimateWorkspace(root, () => {})).toEqual({ fileCount: 2, bytes: 7 });
  } finally {
    unknown.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
