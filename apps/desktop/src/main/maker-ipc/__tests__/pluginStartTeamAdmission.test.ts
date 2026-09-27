import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { assertPluginTaskResult, PluginTaskError } from '../pluginTaskService.js';

const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const branch = source.slice(source.indexOf("      case 'startTeam': {"), source.indexOf("      case 'setTeamPlan': {"));
const js = ts.transpileModule(`return async function(pluginId, request) { switch(request.kind) { ${branch} } }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(initial = 'active', afterConfirmation = initial) {
  const epoch = {};
  const task = { taskId: 'task', status: initial, revision: 1, permissionMode: 'auto' };
  const service = { get: vi.fn(async () => ({ ...task })) };
  const create = vi.fn(async () => ({ ok: true, teamId: 'team' }));
  const start = vi.fn(async (_id: string, _mode: unknown, check: () => Promise<void>) => {
    task.status = afterConfirmation;
    await check();
    return create();
  });
  const deps = { service, getCurrentDbClientSnapshot: () => epoch, PluginTaskError, assertPluginTaskResult, startOrcaTeamForCaller: start };
  const run = new Function(...Object.keys(deps), js)(...Object.values(deps));
  return { run: () => run('plugin', { kind: 'startTeam', taskId: 'task' }), start, create };
}

describe('plugin team active-task admission', () => {
  it('rejects an already archived task before the start flow', async () => {
    const f = fixture('archived');
    await expect(f.run()).rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(f.start).not.toHaveBeenCalled();
  });
  it('rejects archive during confirmation even without a revision change', async () => {
    const f = fixture('active', 'archived');
    await expect(f.run()).rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('starts a still-active task', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({ ok: true, teamId: 'team' });
    expect(f.create).toHaveBeenCalledOnce();
  });
});
