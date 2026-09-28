import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cachedBotSkillRuntime, invalidateBotSkillRuntime } from '../botSkillRuntimeCache';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-cache-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const projection = (name: string) => ({ pluginRoot: root,
  skills: [{ name, description: name, path: root, filePath: path.join(root, 'SKILL.md') }] });

it('shares concurrent hydration work and reconciles mutations during the read', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let version = 'old';
  const build = vi.fn(async () => {
    const captured = version;
    if (captured === 'old') await held;
    return projection(captured);
  });
  const first = cachedBotSkillRuntime(root, build);
  await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
  const second = cachedBotSkillRuntime(root, build);
  const third = cachedBotSkillRuntime(root, build);
  version = 'new';
  invalidateBotSkillRuntime(root);
  release();
  const results = await Promise.all([first, second, third]);
  expect(results.map(item => item.skills[0].name)).toEqual(['new', 'new', 'new']);
  expect(build).toHaveBeenCalledTimes(2);
  results[0].skills[0].name = 'caller edit';
  expect(results[1].skills[0].name).toBe('new');
  expect((await cachedBotSkillRuntime(root, build)).skills[0].name).toBe('new');
  expect(build).toHaveBeenCalledTimes(2);
});

it('retries failed catalog builds and never caches an unwatchable source', async () => {
  const build = vi.fn().mockRejectedValueOnce(new Error('fixture write failure')).mockResolvedValue(projection('retry'));
  await expect(cachedBotSkillRuntime(root, build)).rejects.toThrow('fixture write failure');
  expect((await cachedBotSkillRuntime(root, build)).skills[0].name).toBe('retry');
  expect(build).toHaveBeenCalledTimes(2);
  const missing = path.join(root, 'missing');
  const uncached = vi.fn(async () => ({ pluginRoot: missing, skills: [] }));
  await cachedBotSkillRuntime(missing, uncached);
  await cachedBotSkillRuntime(missing, uncached);
  expect(uncached).toHaveBeenCalledTimes(2);
});
