import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { PluginTaskError } from '../pluginTaskService.js';

// Execute the real switch branch with controlled Host boundaries.
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const branch = source.slice(source.indexOf("      case 'requestWriteAccess': {"), source.indexOf("      case 'startTeam': {"));
const js = ts.transpileModule(`return async function(pluginId, request) { switch(request.kind) { ${branch} } }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
 let cfg: Record<string, unknown> = { permissionMode: 'plan', model: 'old' };
 const epoch = { client: { tx: vi.fn(async () => ({ updated: true })) } };
 const task = { taskId: 'task', revision: 1, permissionMode: 'plan' };
 const service = { get: vi.fn(async () => task), listRuns: vi.fn(async () => ({ items: [] })) };
 const live = { isTurnRunning: () => false, getTurnControlSnapshot: () => ({ pendingInteractionCount: 0 }), setPermissionMode: vi.fn(async () => {}) };
 const slots = new Set<string>();
 const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
 const write = vi.fn((_id: string, value: Record<string, unknown>) => { cfg = value; });
 const deps = { service, getCurrentDbClientSnapshot: () => epoch, readGhostErrandConfig: () => cfg, pluginPermissionRequests: slots, PluginTaskError, maker: { getSession: () => live }, inputCoordinator: { getQueueControlSnapshot: () => ({ pendingQueue: [] }) }, dialog, t: (x: string) => x, getInstalledGhostName: () => 'fixture', clampErrandPermissionMode: (x: string) => x, writeGhostErrandConfig: write, broadcastSessionPatched: vi.fn() };
 const run = new Function(...Object.keys(deps), js)(...Object.values(deps));
 return { run: (mode = 'acceptEdits') => run('plugin', { kind: 'requestWriteAccess', taskId: 'task', mode }), service, live, epoch, dialog, slots, write, config: () => cfg, change: (next: Record<string, unknown>) => { cfg = next; } };
}
describe('plugin write confirmation interleavings', () => {
 it('owns the existing slot across idle checks and releases it on failure', async () => {
  const f = fixture(); let reject!: (e: Error) => void;
  f.service.listRuns.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  const first = f.run(); const rejected = expect(first).rejects.toThrow('idle failed');
  await vi.waitFor(() => expect(f.slots.size).toBe(1));
  await expect(f.run()).rejects.toMatchObject({ code: 'TASK_BUSY' });
  expect(f.dialog.showMessageBox).not.toHaveBeenCalled(); expect(f.slots.size).toBe(1);
  reject(new Error('idle failed')); await rejected; expect(f.slots.size).toBe(0);
  await expect(f.run()).resolves.toMatchObject({ granted: true });
 });
 it.each(['runtime', 'database', 'lastRead'])('preserves unrelated configuration changed during %s', async point => {
  const f = fixture(), change = () => f.change({ permissionMode: 'plan', model: 'new', workingDir: '/chosen', fastMode: true });
  if (point === 'runtime') f.live.setPermissionMode.mockImplementationOnce(async () => { change(); });
  if (point === 'database') f.epoch.client.tx.mockImplementationOnce(async () => { change(); return { updated: true }; });
  if (point === 'lastRead') f.service.get.mockImplementationOnce(async () => ({ taskId: 'task', revision: 1, permissionMode: 'plan' })).mockImplementationOnce(async () => ({ taskId: 'task', revision: 1, permissionMode: 'plan' })).mockImplementationOnce(async () => { change(); return { taskId: 'task', revision: 1, permissionMode: 'plan' }; });
  await f.run('auto'); expect(f.config()).toEqual({ permissionMode: 'auto', model: 'new', workingDir: '/chosen', fastMode: true });
 });
 it('does not overwrite a later permission change', async () => {
  const f = fixture(); f.live.setPermissionMode.mockImplementationOnce(async () => { f.change({ permissionMode: 'acceptEdits', model: 'new' }); });
  await expect(f.run('auto')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(f.write).not.toHaveBeenCalled(); expect(f.slots.size).toBe(0);
 });
});
