import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { withSessionRestartLock, withSendToSessionLock, sendToSessionLocks } from '../sendToSessionLock.js';
import { isPluginTaskPermissionAllowed, PluginTaskError } from '../pluginTaskService.js';

// Execute the real switch branch with controlled Host boundaries.
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const branch = source.slice(source.indexOf("      case 'requestWriteAccess': {"), source.indexOf("      case 'startTeam': {"));
const js = ts.transpileModule(`return async function(pluginId, request) { switch(request.kind) { ${branch} } }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture() {
 let cfg: Record<string, unknown> = { permissionMode: 'plan', model: 'old' };
 const history = { input: false, startedAt: null as number | null, endedAt: null as number | null };
 const messages = {id:'message-id',sessionId:'session-id',role:'role'}, sessions = {id:'session-id',activeTurnStartedAt:'started',lastTurnEndedAt:'ended'};
 const select = vi.fn(() => ({from:(table:unknown)=>({where:()=>({limit:async()=>table===messages ? (history.input ? [{id:'manual-input'}] : []) : [{startedAt:history.startedAt,endedAt:history.endedAt}]})})}));
 const drain = vi.fn(async()=>{});
 const epoch = { client: { tx: vi.fn(async () => ({ updated: true })), drizzle: {select} } };
 const task = { taskId: 'task', revision: 1, permissionMode: 'plan' };
 const service = { get: vi.fn(async () => task), listRuns: vi.fn(async () => ({ items: [] })), completeOperation: vi.fn(async <T>(operation: () => Promise<T>) => operation()) };
 const live = { isTurnRunning: () => false, getTurnControlSnapshot: () => ({ pendingInteractionCount: 0 }), setPermissionMode: vi.fn(async () => {}) };
 const slots = new Set<string>();
 const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
 const write = vi.fn((_id: string, value: Record<string, unknown>) => { cfg = value; });
 const deps = { isPluginTaskPermissionAllowed, withSessionRestartLock, drainPersistQueue:drain,messages,sessions,eq:()=>true,and:()=>true,service, getCurrentDbClientSnapshot: () => epoch, readGhostErrandConfig: () => cfg, pluginPermissionRequests: slots, PluginTaskError, maker: { getSession: () => live }, inputCoordinator: { getQueueControlSnapshot: () => ({ pendingQueue: [] }) }, dialog, t: (x: string) => x, getInstalledGhostName: () => 'fixture', clampErrandPermissionMode: (x: string) => x, writeGhostErrandConfig: write, broadcastSessionPatched: vi.fn() };
 const run = new Function(...Object.keys(deps), js)(...Object.values(deps));
 return { run: (mode = 'acceptEdits') => run('plugin', { kind: 'requestWriteAccess', taskId: 'task', mode }), service, live, epoch, dialog, slots, write, history, drain, config: () => cfg, change: (next: Record<string, unknown>) => { cfg = next; } };
}
describe('plugin write confirmation interleavings', () => {
 it('tracks the permission commit only after confirmation and includes rollback', async () => {
  const f=fixture();let answer!:()=>void;
  f.dialog.showMessageBox.mockImplementationOnce(()=>new Promise(resolve=>{answer=()=>resolve({response:0});}));
  const operation=f.run();const rejected=expect(operation).rejects.toThrow('write failed');
  await vi.waitFor(()=>expect(f.dialog.showMessageBox).toHaveBeenCalledOnce());
  expect(f.service.completeOperation).not.toHaveBeenCalled();
  let release!:()=>void;const rollback=new Promise<void>(resolve=>{release=resolve;});
  f.epoch.client.tx.mockRejectedValueOnce(new Error('write failed'));
  f.live.setPermissionMode.mockImplementationOnce(async()=>{}).mockImplementationOnce(()=>rollback);
  answer();await vi.waitFor(()=>expect(f.live.setPermissionMode).toHaveBeenCalledTimes(2));
  expect(f.service.completeOperation).toHaveBeenCalledOnce();
  let finished=false;const tracked=f.service.completeOperation.mock.results[0]!.value.then(()=>{finished=true;},()=>{finished=true;});
  await Promise.resolve();expect(finished).toBe(false);
  release();await Promise.all([rejected,tracked]);expect(finished).toBe(true);
 });
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
  expect(f.live.setPermissionMode).toHaveBeenLastCalledWith('plan');
  expect(f.epoch.client.tx).toHaveBeenLastCalledWith('bots.persistSessionPermission', {sessionId:'task', mode:'plan'});
 });
 it.each(['database', 'lastRead'] as const)('rolls back runtime and stored permission after late %s revocation', async point => {
  const f=fixture();
  const revoke=()=>f.change({permissionMode:'acceptEdits',model:'new'});
  if(point==='database') f.epoch.client.tx.mockImplementationOnce(async()=>{revoke();return {updated:true};});
  else f.service.get.mockImplementationOnce(async()=>({taskId:'task',revision:1,permissionMode:'plan'}))
   .mockImplementationOnce(async()=>({taskId:'task',revision:1,permissionMode:'plan'}))
   .mockImplementationOnce(async()=>{revoke();return {taskId:'task',revision:1,permissionMode:'auto'};});
  await expect(f.run('auto')).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  expect(f.live.setPermissionMode.mock.calls).toEqual([['auto'],['plan']]);
  expect(f.epoch.client.tx).toHaveBeenLastCalledWith('bots.persistSessionPermission',{sessionId:'task',mode:'plan'});
  expect(f.config()).toEqual({permissionMode:'acceptEdits',model:'new'});
  expect(f.write).not.toHaveBeenCalled();expect(f.slots.size).toBe(0);
 });
 it('rolls back a persisted grant if the final ownership read fails', async()=>{
  const f=fixture();
  f.service.get.mockImplementationOnce(async()=>({taskId:'task',revision:1,permissionMode:'plan'}))
   .mockImplementationOnce(async()=>({taskId:'task',revision:1,permissionMode:'plan'}))
   .mockRejectedValueOnce(new Error('owner revoked'));
  await expect(f.run('auto')).rejects.toThrow('owner revoked');
  expect(f.live.setPermissionMode).toHaveBeenLastCalledWith('plan');
  expect(f.epoch.client.tx).toHaveBeenLastCalledWith('bots.persistSessionPermission',{sessionId:'task',mode:'plan'});
  expect(f.write).not.toHaveBeenCalled();
 });
});

describe('first plugin write approval checks actual task history', () => {
 it.each(['input','startedAt','endedAt'] as const)('rejects a manual UI turn with %s evidence without a plugin receipt', async key=>{
  const f=fixture();
  if(key==='input') f.history.input=true; else f.history[key]=1;
  await expect(f.run()).rejects.toMatchObject({code:'TASK_BUSY'});
  expect(f.dialog.showMessageBox).not.toHaveBeenCalled();expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.slots.size).toBe(0);
 });
 it('rechecks after confirmation if a manual turn completed while the dialog was open',async()=>{
  const f=fixture();f.dialog.showMessageBox.mockImplementationOnce(async()=>{f.history.input=true;return {response:0};});
  await expect(f.run()).rejects.toMatchObject({code:'TASK_BUSY'});
  expect(f.live.setPermissionMode).not.toHaveBeenCalled();expect(f.epoch.client.tx).not.toHaveBeenCalled();
 });
 it('drains pending message writes before checking and fails closed on storage failure',async()=>{
  const f=fixture();f.drain.mockImplementationOnce(async()=>{f.history.input=true;});
  await expect(f.run()).rejects.toMatchObject({code:'TASK_BUSY'});
  const g=fixture();g.drain.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(g.run()).rejects.toThrow('storage unavailable');expect(g.dialog.showMessageBox).not.toHaveBeenCalled();
 });
});

 it('rechecks under the shared lock after an earlier sender completes', async () => {
  const f = fixture(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let sender: Promise<void>;
  f.dialog.showMessageBox.mockImplementationOnce(async () => {
   sender = withSendToSessionLock('task', async () => { entered(); await barrier; f.history.endedAt = 1; });
   await started;
   return { response: 0 };
  });
  const result = expect(f.run()).rejects.toMatchObject({ code: 'TASK_BUSY' });
  await vi.waitFor(() => expect(sendToSessionLocks.has('task')).toBe(true));
  expect(f.live.setPermissionMode).not.toHaveBeenCalled();
  release(); await result; await sender!;
 });
 it('keeps send fenced through runtime permission persistence and releases after rejection', async () => {
  const f = fixture(); let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.epoch.client.tx.mockImplementationOnce(async () => { await barrier; throw new Error('persist failed'); });
  const result = expect(f.run()).rejects.toThrow('persist failed');
  await vi.waitFor(() => expect(f.epoch.client.tx).toHaveBeenCalled());
  const send = vi.fn(async () => {});
  await expect(withSendToSessionLock('task', send)).rejects.toThrow('restart');
  expect(send).not.toHaveBeenCalled();
  release(); await result;
  await withSendToSessionLock('task', send); expect(send).toHaveBeenCalledOnce();
 });


it.each(['bypassPermissions', 'auto', 'acceptEdits'])('does not report %s as granted after plugin authority is lowered', async permissionMode => {
 const f = fixture();
 f.service.get.mockImplementation(async () => ({taskId:'task',revision:1,permissionMode}));
 f.dialog.showMessageBox.mockResolvedValue({response:1});
 await expect(f.run()).resolves.toMatchObject({granted:false});
 expect(f.dialog.showMessageBox).toHaveBeenCalledOnce();
 expect(f.live.setPermissionMode).not.toHaveBeenCalled();
});
it.each(['acceptEdits', 'auto'])('reuses an effective %s grant without another confirmation',async permissionMode=>{
 const f=fixture();f.change({permissionMode});
 f.service.get.mockImplementation(async()=>({taskId:'task',revision:1,permissionMode}));
 await expect(f.run()).resolves.toMatchObject({granted:true});expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
});
