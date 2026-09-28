import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectBotOwnSkillMounts, listBotSkillsForSession } from '../botSkillService';
import { BOT_SKILL_RUNTIME_INDEX_BYTES } from '../botSkillRuntimeProjection';
import { botSkillRootDir, parseBotSkillFile } from '../botSkillStore';
import { buildBotSkillIndex } from '../botSystemPrompt';
import { applyPiBotSkillPolicy } from '../../../../../../packages/maker-core/src/agents/pi/bot-skill-policy';
import { buildCodexBotSkillConfigOverrides } from '../../../../../../packages/maker-core/src/agents/codex/capability-routing';

let userDataDir: string;
const botId = 'imported-bot';
beforeEach(async () => { userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-projection-')); });
afterEach(async () => { await fs.rm(userDataDir, { recursive: true, force: true }); });
const deps = () => ({ userDataDir, resolveBotId: async () => ({ ok: true as const, botId }) });

async function writeSkill(slug: string, source: string, disabled = false) {
  const directory = path.join(botSkillRootDir(userDataDir, botId), disabled ? 'disabled-skills' : 'skills', slug);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, 'SKILL.md');
  await fs.writeFile(filePath, source);
  return filePath;
}

async function assertBoundedNativeMounts() {
  const mounts = await collectBotOwnSkillMounts(botId, deps());
  expect(mounts.skills).toHaveLength(1);
  expect(Buffer.byteLength(buildBotSkillIndex(mounts.skills))).toBeLessThan(BOT_SKILL_RUNTIME_INDEX_BYTES);
  const policy = { mode: 'allowlist' as const, configured: [], catalog: [], ownSkills: mounts.skills };
  const pi = applyPiBotSkillPolicy(policy, {
    skillPaths: [], launchSkillPaths: [], launchSkillDigests: [], launchSkillSourceFingerprints: [],
  } as unknown as Parameters<typeof applyPiBotSkillPolicy>[1]);
  expect(pi.explicitSkillPaths).toEqual([mounts.skills[0].path]);
  expect(Buffer.byteLength(JSON.stringify(pi.explicitSkillPaths))).toBeLessThan(4096);
  expect(buildCodexBotSkillConfigOverrides(policy)['skills.config']).toEqual([
    { path: mounts.skills[0].filePath, enabled: true },
  ]);
  // Claude Code sees only the discovery Skill, never the original large shelf.
  expect(await fs.readdir(path.join(mounts.pluginRoot, 'skills'))).toEqual(['personal-skill-library']);
  expect(JSON.parse(await fs.readFile(path.join(mounts.pluginRoot, '.claude-plugin/plugin.json'), 'utf8')).name)
    .toBe('personal-skill-library');
  const mountedSource = await fs.readFile(mounts.skills[0].filePath, 'utf8');
  const metadata = parseBotSkillFile(mountedSource);
  expect(metadata.name.length).toBeLessThanOrEqual(64);
  expect(metadata.description.length).toBeLessThanOrEqual(280);
  expect(Buffer.byteLength(mountedSource)).toBeLessThan(4096);
  return mounts;
}

describe('complete personal Skills with bounded startup projection', () => {
  it('preserves a near-16 MiB original header and loads only bounded runtime metadata', async () => {
    const source = `---\r\nname: ${'n'.repeat(7 * 1024 * 1024)}\r\ndescription: ${'d'.repeat(8 * 1024 * 1024)} tail-query\r\n---\r\nRun scripts/report.py\r\n`;
    const original = await writeSkill('oversized', source);
    await fs.mkdir(path.join(path.dirname(original), 'scripts'));
    await fs.writeFile(path.join(path.dirname(original), 'scripts/report.py'), '# original resource');
    const mounts = await assertBoundedNativeMounts();
    const rows = (await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'oversized', filePath: original, bodyStartLine: 5 });
    expect(rows[0].name).toHaveLength(64);
    expect(rows[0].description).toHaveLength(280);
    expect(await fs.readFile(original, 'utf8')).toBe(source);
    expect(source.split('\n').slice(rows[0].bodyStartLine - 1).join('\n')).toContain('Run scripts/report.py');
    expect(await fs.readFile(path.join(path.dirname(rows[0].filePath), 'scripts/report.py'), 'utf8')).toBe('# original resource');
    // Search sees even metadata beyond the runtime preview and returns a short page.
    const page = await listBotSkillsForSession({ callerSessionId: 'session', query: 'tail-query' }, deps());
    expect(page).toMatchObject({ ok: true, total: 1, skills: [{ slug: 'oversized' }] });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(BOT_SKILL_RUNTIME_INDEX_BYTES);
    // Disabling the only Skill also clears its previously mounted catalog.
    const disabled = path.join(botSkillRootDir(userDataDir, botId), 'disabled-skills');
    await fs.mkdir(disabled);
    await fs.rename(path.dirname(original), path.join(disabled, 'oversized'));
    expect((await collectBotOwnSkillMounts(botId, deps())).skills).toEqual([]);
    expect(await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8')).toBe('');
    expect(await fs.readFile(path.join(disabled, 'oversized', 'SKILL.md'), 'utf8')).toBe(source);
  });

  it('keeps every Skill in a large shelf discoverable, including the final page and later additions', async () => {
    const count = 2048;
    // Bounded filesystem concurrency; these are real files consumed by the store.
    for (let start = 0; start < count; start += 32) {
      await Promise.all(Array.from({ length: 32 }, (_, offset) => {
        const slug = `skill-${String(start + offset).padStart(5, '0')}`;
        return writeSkill(slug, `---\nname: ${slug}\ndescription: Workflow ${slug}\n---\nInstructions for ${slug}\n`);
      }));
    }
    await writeSkill('disabled', '---\nname: disabled\ndescription: Leave disabled\n---\nDo not run\n', true);
    const mounts = await assertBoundedNativeMounts();
    let catalog = (await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(catalog).toHaveLength(count);
    expect(new Set(catalog.map(item => item.slug)).size).toBe(count);
    const last = catalog.at(-1);
    expect(last.slug).toBe('skill-02047');
    expect(await fs.readFile(last.filePath, 'utf8')).toContain('Instructions for skill-02047');
    const firstPage = await listBotSkillsForSession({ callerSessionId: 'session', query: 'workflow' }, deps());
    expect(firstPage).toMatchObject({ ok: true, total: count, nextOffset: 20 });
    const lastPage = await listBotSkillsForSession({ callerSessionId: 'session', query: 'workflow', offset: count - 1 }, deps());
    expect(lastPage).toMatchObject({ ok: true, skills: [{ slug: 'skill-02047' }] });
    expect(lastPage).not.toHaveProperty('nextOffset');
    await writeSkill('z-new', '---\nname: z-new\ndescription: Newly learned\n---\nNew steps\n');
    await collectBotOwnSkillMounts(botId, deps());
    catalog = (await fs.readFile(path.join(mounts.pluginRoot, 'catalog.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(catalog).toHaveLength(count + 1);
    expect(catalog.at(-1).slug).toBe('z-new');
    expect(await fs.readdir(path.join(mounts.pluginRoot))).not.toEqual(expect.arrayContaining([expect.stringMatching(/\.tmp$/)]));
  }, 30_000);

  it('paginates by response bytes as well as page size without losing the remainder', async () => {
    for (let index = 0; index < 35; index++) {
      const slug = `wide-${String(index).padStart(2, '0')}`;
      await writeSkill(slug, `---\nname: ${slug}\ndescription: ${'说明'.repeat(140)}\n---\nSteps\n`);
    }
    const found: string[] = [];
    let offset = 0;
    do {
      const result = await listBotSkillsForSession({ callerSessionId: 'session', limit: 50, offset }, deps());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(BOT_SKILL_RUNTIME_INDEX_BYTES + 256);
      found.push(...result.skills.map(item => item.slug));
      if (result.nextOffset === undefined) break;
      expect(result.nextOffset).toBeGreaterThan(offset);
      offset = result.nextOffset;
    } while (offset < 35);
    expect(found).toHaveLength(35);
    expect(new Set(found).size).toBe(35);
    expect(offset).toBeGreaterThan(0);
  });
});
