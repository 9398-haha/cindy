import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  createPluginTaskService,
  isPluginTaskPermissionAllowed,
  PluginTaskError,
  assertPluginTaskResult,
  readPluginTaskPlanReceipt,
  type PluginTaskReceipt,
  type PluginTaskStore,
  type PluginTaskServiceDeps,
} from '../pluginTaskService.js';
import type { PluginTaskView } from '../../../shared/pluginTasks.js';
import { PLUGIN_TEAM_PLAN_MAX_JSON_CHARS, PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS } from '../../../shared/pluginTasks.js';

it('rejects oversized plans before saving and refuses oversized legacy receipts without truncation', async () => {
  const f=fixture(), task=await f.create();
  const before=structuredClone(f.rows.get(task.taskId)!);
  const plan={concurrency:2,items:Array.from({length:200},(_,i)=>({label:'w'+i,workingDir:'/answer',route:f.route,task:'x'.repeat(8000)}))};
  await expect(f.service.setTeamPlan('p',task.taskId,plan)).rejects.toMatchObject({code:'INVALID_REQUEST'});
  expect(f.rows.get(task.taskId)).toEqual(before);
  for (const payload of [' '.repeat(PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS+1), JSON.stringify({teamPlan:{task:'x'.repeat(PLUGIN_TEAM_PLAN_MAX_JSON_CHARS)}})])
    expect(()=>readPluginTaskPlanReceipt(payload)).toThrow('size');
  f.rows.get(task.taskId)!.payload=JSON.stringify({teamPlan:plan});
  await expect(f.service.settleWorkerLabel('p',task.taskId,'w0')).rejects.toMatchObject({code:'INVALID_REQUEST'});
});

function fixture() {
  let seq = 0;
  let current = true;
  const rows = new Map<string, PluginTaskReceipt>();
  const tasks = new Map<string, PluginTaskView>();
  const copy = <T>(v: T): T => structuredClone(v);
  const store: PluginTaskStore = {
    get: async (id) => copy(rows.get(id)),
    find: async (p, op, t, k) =>
      copy(
        [...rows.values()].find(
          (r) => r.pluginId === p && r.operation === op && r.targetId === t && r.requestKey === k,
        ),
      ),
    list: async (p, op, t, after, limit) =>
      copy(
        [...rows.values()]
          .filter(
            (r) =>
              r.pluginId === p &&
              r.operation === op &&
              (t === null || r.targetId === t) &&
              r.id > after,
          )
          .slice(0, limit),
      ),
    forSession: async (t) =>
      copy([...rows.values()].filter((r) => r.operation === 'send' && r.targetId === t)),
    insert: async (r) => {
      expect(rows.has(r.id)).toBe(false);
      rows.set(r.id, copy(r));
    },
    save: async (r) => {
      expect(rows.get(r.id)?.revision).toBe(r.revision);
      rows.set(r.id, copy({ ...r, revision: r.revision + 1 }));
    },
  };
  const route = {
    agentKind: 'codex' as const,
    providerId: 'mine',
    model: 'model',
    effort: 'high',
    fastMode: false,
  };
  const execution = { instanceId: 'native', generation: 1 };
  const deps: PluginTaskServiceDeps = {
    store,
    readPermissionMode: () => 'auto',
    assertAuthorized: () => {
      if (!current) throw new Error('Owner changed');
    },
    assertCurrent: () => {
      if (!current) throw new Error('Owner changed');
    },
    id: () => `id-${++seq}`,
    now: () => 1,
    resolveRoute: vi.fn(async (_, r) => r ?? route),
    createSession: vi.fn(async (_, taskId, title, resolvedConfig) => {
      tasks.set(taskId, { taskId, title, resolvedConfig, revision: 1, status: 'active', permissionMode: 'plan' });
    }),
    readSession: async (id) => copy(tasks.get(id) ?? null),
    dispatch: vi.fn(async () => ({ ok: true })),
    inspect: vi.fn(async () => ({ execution: null, pending: [] })),
    cancel: vi.fn(async () => 'cancelled' as const),
  };
  const service = createPluginTaskService(deps);
  const create = () => service.create('p', { requestKey: 'create', title: 'Test' });
  const send = async () => {
    const task = await create();
    return service.send('p', {
      taskId: task.taskId,
      requestKey: 'send',
      expectedRevision: task.revision,
      text: 'hello',
    });
  };
  return {
    service,
    deps,
    rows,
    tasks,
    route,
    execution,
    create,
    send,
    switchOwner: () => {
      current = false;
    },
  };
}

describe('plugin ordinary task receipts', () => {
  it('binds isolated workspace intent to creation and idempotency', async () => {
    const f = fixture();
    const input = { requestKey: 'isolated', title: 'Test', isolatedWorkspace: true };
    const task = await f.service.create('p', input);
    expect(f.deps.createSession).toHaveBeenCalledWith('p', task.taskId, 'Test', f.route, true);
    await f.service.create('p', input);
    expect(f.deps.createSession).toHaveBeenCalledTimes(1);
    await expect(f.service.create('p', { ...input, isolatedWorkspace: false }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('creates once under concurrent retries and rejects conflicting keys', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.create(), f.create()]);
    expect(a.taskId).toBe(b.taskId);
    expect(f.deps.createSession).toHaveBeenCalledTimes(1);
    await expect(
      f.service.create('p', { requestKey: 'create', title: 'Different' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('never exposes another plugin task or run', async () => {
    const f = fixture();
    const run = await f.send();
    await expect(f.service.get('other', run.taskId)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(f.service.getRun('other', run.runId)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    expect((await f.service.list('other')).items).toEqual([]);
  });
  it('persists input identity before dispatch and does not replay after restart', async () => {
    const f = fixture();
    f.deps.dispatch = vi.fn(async (_, __, clientId) => {
      expect([...f.rows.values()].some((r) => r.payload.includes(clientId))).toBe(true);
      throw new Error('Response lost');
    });
    const run = await f.send();
    expect(run.status).toBe('reconciling');
    const restarted = createPluginTaskService(f.deps);
    const retry = await restarted.send('p', {
      taskId: run.taskId,
      requestKey: 'send',
      expectedRevision: 1,
      text: 'hello',
    });
    expect(retry.runId).toBe(run.runId);
    expect(f.deps.dispatch).toHaveBeenCalledTimes(1);
  });
  it('rejects stale revision and archived tasks without dispatch', async () => {
    const f = fixture();
    const task = await f.create();
    await expect(
      f.service.send('p', {
        taskId: task.taskId,
        requestKey: 's',
        expectedRevision: 2,
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    f.tasks.get(task.taskId)!.status = 'archived';
    await expect(
      f.service.send('p', {
        taskId: task.taskId,
        requestKey: 's',
        expectedRevision: 1,
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(f.deps.dispatch).not.toHaveBeenCalled();
  });
  it('binds native acceptance and fences late terminals from old runtime/generation', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    await f.service.settle(run.taskId, { ...f.execution, instanceId: 'old' }, 'completed', 'wrong');
    expect(JSON.parse(f.rows.get(run.runId)!.payload).status).toBe('running');
    await f.service.settle(run.taskId, f.execution, 'completed', 'output');
    await f.service.settle(run.taskId, f.execution, 'failed');
    expect(await f.service.getRun('p', run.runId)).toMatchObject({
      status: 'completed',
      outputMessageId: 'output',
    });
  });
  it('transfers only native recovery aliases to the new execution', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    await f.service.accept(
      run.taskId,
      { clientId: 'retry', retrySourceClientId: run.inputMessageId },
      { ...f.execution, generation: 2 },
    );
    await f.service.settle(run.taskId, f.execution, 'failed');
    expect(JSON.parse(f.rows.get(run.runId)!.payload).execution.generation).toBe(2);
  });
  it('cancellation before acceptance prevents a queued input from starting', async () => {
    const f = fixture();
    const run = await f.send();
    expect((await f.service.cancel('p', run.runId)).status).toBe('cancelled');
    await expect(
      f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution),
    ).rejects.toMatchObject({ code: 'REQUEST_EXPIRED' });
  });
  it('does not convert a completed output into cancellation', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    await f.service.settle(run.taskId, f.execution, 'completed');
    expect((await f.service.cancel('p', run.runId)).status).toBe('completed');
    expect(f.deps.cancel).not.toHaveBeenCalled();
  });
  it('revalidates exact configuration at vendor boundary', async () => {
    const f = fixture();
    const run = await f.send();
    f.tasks.get(run.taskId)!.resolvedConfig.model = 'other';
    await expect(
      f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution),
    ).rejects.toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
  });
  it('account switch blocks subsequent work', async () => {
    const f = fixture();
    await f.create();
    f.switchOwner();
    await expect(f.service.list('p')).rejects.toThrow('Owner changed');
  });
  it('rejects queued input when the task was archived before vendor acceptance', async () => {
    const f = fixture();
    const run = await f.send();
    f.tasks.get(run.taskId)!.status = 'archived';
    await expect(f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution))
      .rejects.toMatchObject({ code: 'TASK_BUSY' });
    expect(JSON.parse(f.rows.get(run.runId)!.payload).execution).toBeUndefined();
  });
  it('does not recreate a deleted task on request replay', async () => {
    const f = fixture();
    const task = await f.create();
    f.tasks.delete(task.taskId);
    await expect(f.create()).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(f.deps.createSession).toHaveBeenCalledTimes(1);
  });
  it('allows coordinator acceptance and synchronous terminal inside dispatch without a lock cycle', async () => {
    const f = fixture();
    f.deps.dispatch = vi.fn(async (_, taskId, clientId) => {
      await f.service.accept(taskId, { clientId }, f.execution);
      await f.service.settle(taskId, f.execution, 'completed', 'answer');
      return { ok: true };
    });
    expect(await f.send()).toMatchObject({ status: 'completed', outputMessageId: 'answer' });
  });
  it('does not hold the receipt lock while native stop delivers its terminal', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    f.deps.cancel = vi.fn(async () => {
      await f.service.settle(run.taskId, f.execution, 'completed', 'finished-before-stop');
      return 'stopping' as const;
    });
    expect(await f.service.cancel('p', run.runId)).toMatchObject({
      status: 'completed',
      outputMessageId: 'finished-before-stop',
    });
  });
  it('does not block a user retry after the plugin run ended', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(run.taskId, { clientId: run.inputMessageId }, f.execution);
    await f.service.settle(run.taskId, f.execution, 'failed');
    await expect(
      f.service.accept(
        run.taskId,
        { clientId: 'user-retry', retrySourceClientId: run.inputMessageId },
        { ...f.execution, generation: 2 },
      ),
    ).resolves.toBeUndefined();
    expect(await f.service.getRun('p', run.runId)).toMatchObject({ status: 'failed' });
  });
  it('keeps multi-hop recovery aliases but never adopts an unrelated user input', async () => {
    const f = fixture();
    const run = await f.send();
    await f.service.accept(
      run.taskId,
      { clientId: 'retry1', retrySourceClientId: run.inputMessageId },
      f.execution,
    );
    await f.service.accept(
      run.taskId,
      { clientId: 'retry2', retrySourceClientId: 'retry1' },
      { ...f.execution, generation: 2 },
    );
    await f.service.accept(run.taskId, { clientId: 'user-new' }, { ...f.execution, generation: 3 });
    await f.service.discard(run.taskId, { clientId: 'retry1' }, 'cancelled');
    const receipt = JSON.parse(f.rows.get(run.runId)!.payload);
    expect(receipt.status).toBe('running');
    expect(receipt.execution.generation).toBe(2);
    expect(receipt.inputClientIds).toEqual(['retry1', 'retry2']);
  });
});

it('permission elevation blocks new sends but preserves inspection of existing work',async()=>{
 const f=fixture();const task=await f.create();const run=await f.send();
 f.tasks.set(task.taskId,{...f.tasks.get(task.taskId)!,permissionMode:'bypassPermissions'});
 expect((await f.service.get('p',task.taskId)).taskId).toBe(task.taskId);
 expect((await f.service.getRun('p',run.runId)).runId).toBe(run.runId);
 await expect(f.service.send('p',{taskId:task.taskId,expectedRevision:task.revision,requestKey:'new-send',text:'new'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
});

it('freezes owned plan and retains settled labels',async()=>{const f=fixture(),task=await f.create();const plan={concurrency:2,items:[{label:'sample',workingDir:'/answer',route:f.route}]};await f.service.setTeamPlan('p',task.taskId,plan);await f.service.setTeamPlan('p',task.taskId,plan);await expect(f.service.setTeamPlan('other',task.taskId,plan)).rejects.toThrow('Task not found');await expect(f.service.setTeamPlan('p',task.taskId,{...plan,concurrency:3})).rejects.toThrow('immutable');await f.service.settleWorkerLabel('p',task.taskId,'sample');expect(JSON.parse(f.rows.get(task.taskId)!.payload).settledLabels).toEqual(['sample']);});


it('rechecks permissions when queued input reaches native dispatch', async () => {
 const f=fixture(), run=await f.send();
 f.tasks.get(run.taskId)!.permissionMode='bypassPermissions';
 await expect(f.service.accept(run.taskId,{clientId:run.inputMessageId},f.execution)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 expect(JSON.parse(f.rows.get(run.runId)!.payload).status).toBe('queued');
});

it('registers plans only before input and preserves identical retries after dispatch', async () => {
  const f = fixture(), task = await f.create();
  const plan = {concurrency: 2, items: [{label: 'sample', workingDir: '/answer', route: f.route}]};
  f.deps.assertTeamPlanUnstarted = vi.fn(async () => { throw new Error('Worker reservation exists'); });
  await expect(f.service.setTeamPlan('p', task.taskId, plan)).rejects.toThrow('reservation');
  f.deps.assertTeamPlanUnstarted = vi.fn(async () => undefined);
  await f.service.setTeamPlan('p', task.taskId, plan);
  await f.send();
  await expect(f.service.setTeamPlan('p', task.taskId, plan)).resolves.toEqual({ok: true});
  const late = fixture(), run = await late.send();
  await expect(late.service.setTeamPlan('p', run.taskId, plan)).rejects.toMatchObject({code: 'TASK_BUSY'});
});

it('drains terminal receipt writes before the owner database closes', async () => {
  const f = fixture(), run = await f.send();
  await f.service.accept(run.taskId, {clientId: run.inputMessageId}, f.execution);
  const save = f.deps.store.save;
  let unblock!: () => void;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  f.deps.store.save = async row => { await barrier; await save(row); };
  const terminal = f.service.settle(run.taskId, f.execution, 'completed', 'answer');
  let drained = false;
  const drain = f.service.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  unblock();
  await Promise.all([terminal, drain]);
  f.switchOwner();
  expect(JSON.parse(f.rows.get(run.runId)!.payload)).toMatchObject({status: 'completed', outputMessageId: 'answer'});
});

it.each(['send', 'cancel'] as const)('drain waits for the full %s operation including native callbacks', async kind => {
 const f = fixture(); const task = await f.create();
 const old = kind === 'cancel' ? await f.send() : null;
 let release!: () => void;
 const barrier = new Promise<void>(resolve => { release = resolve; });
 let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
 f.deps.dispatch = async (_p, taskId, inputMessageId) => {
  entered(); await barrier;
  await f.service.accept(taskId, {clientId: inputMessageId}, f.execution);
  return {ok: false};
 };
 f.deps.cancel = async () => { entered(); await barrier; return 'cancelled'; };
 const operation = kind === 'send'
  ? f.service.send('p', {taskId:task.taskId, requestKey:'new', expectedRevision:task.revision, text:'hello'})
  : f.service.cancel('p', old!.runId);
 await started;
 let drained = false; const drain = f.service.drain().then(() => { drained = true; });
 await new Promise(resolve => setTimeout(resolve, 0)); expect(drained).toBe(false);
 release(); const [run] = await Promise.all([operation, drain]);
 f.switchOwner();
 expect(JSON.parse(f.rows.get(run.runId)!.payload).status).toBe(kind === 'send' ? 'running' : 'cancelled');
});
it.each(['validation', 'archive', 'settlement', 'alreadyArchived', 'failure'] as const)('drains the real releaseWorker branch through %s', async phase => {
 const f = fixture();
 let release!: () => void, entered!: () => void;
 const barrier = new Promise<void>(resolve => { release = resolve; });
 const started = new Promise<void>(resolve => { entered = resolve; });
 const pause = async () => { entered(); await barrier; };
 const service = {...f.service,
  get: vi.fn(async () => { if (phase === 'validation') await pause(); return {taskId:'lead'}; }),
  settleWorkerLabel: vi.fn(async () => {
   if (phase === 'settlement' || phase === 'alreadyArchived') await pause();
   // Native completion enqueues work on the real receipt tail. Holding that
   // tail across archive would deadlock this callback.
   await f.create();
  }),
 };
 const archiveWorker = vi.fn(async ({beforeArchive}: {beforeArchive: () => Promise<void>}) => {
  await beforeArchive();
  if (phase === 'archive' || phase === 'failure') await pause();
  if (phase === 'failure') throw new Error('archive failed');
  await f.create();
  return {ok:true};
 });
 const record = {id:'worker',sessionId:'child',label:'one',status:phase === 'alreadyArchived' ? 'archived' : 'done'};
 const query = {from:()=>query,innerJoin:()=>query,where:()=>query,limit:async()=>[record]};
 const epoch = {client:{drizzle:{select:()=>query}}};
 const deps = {service, getCurrentDbClientSnapshot:()=>epoch,PluginTaskError,assertPluginTaskResult,readPluginTaskPlanReceipt,
  orcaWorkers:{},orcaTeams:{},sessions:{},eq:()=>true,and:()=>true,
  createPluginTaskStore:()=>({get:async()=>({payload:JSON.stringify({teamPlan:{items:[{label:'one'}]}})})}),
  readPluginWorkerCompletion:async()=>({row:record,completedAt:1}),orcaTeamService:{archiveWorker}};
 const source = readFileSync(new URL('../register.ts',import.meta.url),'utf8');
 const branch = source.slice(source.indexOf("      case 'releaseWorker': {"),source.indexOf("      case 'getTeam': {"));
 const js = ts.transpileModule(`return async function(pluginId, request) { switch(request.kind) { ${branch} } }`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const run = new Function(...Object.keys(deps),js)(...Object.values(deps));
 const operation = run('p',{kind:'releaseWorker',taskId:'lead',workerId:'worker',completedAt:1});
 const result = phase === 'failure' ? expect(operation).rejects.toThrow('archive failed') : expect(operation).resolves.toMatchObject({ok:true});
 await started;
 let drained = false;
 const drain = f.service.drain().then(()=>{drained=true;});
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(drained).toBe(false);
 release(); await Promise.all([result,drain]);
 expect(service.settleWorkerLabel).toHaveBeenCalledTimes(phase === 'failure' ? 0 : 1);
 expect(archiveWorker).toHaveBeenCalledTimes(phase === 'alreadyArchived' ? 0 : 1);
 await f.service.drain();
 f.switchOwner();
});

it.each([false, true])('team start drain excludes confirmation and includes native completion (failure=%s)', async fails => {
 const f = fixture();
 let confirm!: () => void, finish!: () => void, entered!: () => void;
 const dialog = new Promise<void>(resolve=>{confirm=resolve;});
 const native = new Promise<void>(resolve=>{finish=resolve;});
 const started = new Promise<void>(resolve=>{entered=resolve;});
 const source = readFileSync(new URL('../register.ts',import.meta.url),'utf8');
 const helper = source.slice(source.indexOf('  const startOrcaTeamForCaller ='),source.indexOf('  const pluginPermissionRequests ='));
 const deps = {assertLeadCollabProjectEnabled:async()=>{},getWorkerPermissionModeFromCreationPrefs:()=> 'auto',
  t:(key:string)=>key,orcaWorkerPermissionConfirmBridge:{request:()=>dialog},
  startOrcaTeamWithPermissionGate:async (params:unknown, handlers:{startTeam:(params:unknown)=>Promise<unknown>})=>{await dialog;return handlers.startTeam(params);},
  orcaLifecycleService:{startTeam:async()=>{entered();await native;await f.create();if(fails)throw new Error('failed');return {ok:true};}}};
 const js = ts.transpileModule(`${helper}\nreturn startOrcaTeamForCaller;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const run = new Function(...Object.keys(deps),js)(...Object.values(deps));
 const operation = run('lead',undefined,async()=>{},f.service.completeOperation);
 await f.service.drain(); // An unanswered dialog must not block logout.
 confirm();await started;
 let drained=false;const drain=f.service.drain().then(()=>{drained=true;});
 await new Promise(resolve=>setTimeout(resolve,0));expect(drained).toBe(false);
 finish();expect(await operation).toMatchObject({ok:!fails});await drain;
});

it('a rejected operation does not poison subsequent drain', async () => {
 const f = fixture(), run = await f.send();
 f.deps.cancel = async () => { throw new Error('native stop failed'); };
 await expect(f.service.cancel('p', run.runId)).rejects.toThrow('native stop failed');
 await f.service.drain();
 f.deps.cancel = async () => 'cancelled';
 await expect(f.service.cancel('p', run.runId)).resolves.toMatchObject({status:'cancelled'});
 await f.service.drain();
});



describe('current plugin dispatch authority', () => {
  it.each(['plan', 'acceptEdits', 'auto'])('allows only authority within %s configuration', configured => {
    const modes = ['plan', 'acceptEdits', 'auto'];
    for (const mode of [...modes, 'bypassPermissions', 'unknown', undefined]) {
      expect(isPluginTaskPermissionAllowed(mode, configured)).toBe(modes.includes(mode!) && modes.indexOf(mode!) <= modes.indexOf(configured));
    }
    expect(isPluginTaskPermissionAllowed('auto', undefined)).toBe(false);
  });
  it.each(['before', 'route', 'insert'])('blocks a new dispatch after revocation at %s', async point => {
    const f = fixture(), task = await f.create();
    f.tasks.get(task.taskId)!.permissionMode = 'auto';
    let mode = 'auto'; f.deps.readPermissionMode = () => mode;
    if (point === 'before') mode = 'plan';
    if (point === 'route') f.deps.resolveRoute = async () => { mode = 'plan'; return f.route; };
    if (point === 'insert') {
      const insert = f.deps.store.insert;
      f.deps.store.insert = async row => { await insert(row); mode = 'plan'; };
    }
    const attempt = f.service.send('p', {taskId:task.taskId,expectedRevision:task.revision,requestKey:'new',text:'input'});
    if (point === 'insert') await expect(attempt).resolves.toMatchObject({status:'reconciling'});
    else await expect(attempt).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    expect(f.deps.dispatch).not.toHaveBeenCalled();
  });
  it.each(['before', 'route', 'save'])('blocks queued acceptance after revocation at %s and keeps cancel available', async point => {
    const f = fixture(), run = await f.send();
    f.tasks.get(run.taskId)!.permissionMode = 'auto';
    let mode = 'auto'; f.deps.readPermissionMode = () => mode;
    if (point === 'before') mode = 'plan';
    if (point === 'route') f.deps.resolveRoute = async () => { mode = 'plan'; return f.route; };
    if (point === 'save') {
      const save = f.deps.store.save;
      f.deps.store.save = async row => { await save(row); mode = 'plan'; };
    }
    await expect(f.service.accept(run.taskId,{clientId:run.inputMessageId},f.execution)).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    // Same-key retries observe the existing receipt; they never reopen dispatch.
    const calls = vi.mocked(f.deps.dispatch).mock.calls.length;
    await f.send(); expect(f.deps.dispatch).toHaveBeenCalledTimes(calls);
    await expect(f.service.cancel('p',run.runId)).resolves.toMatchObject({status:'cancelled'});
  });
});

it('keeps taskless plans immutable instead of retroactively granting scope', async () => {
 const f=fixture(),task=await f.create();
 const old={concurrency:2,items:[{label:'sample',workingDir:'/answer',route:f.route}]};
 await f.service.setTeamPlan('p',task.taskId,old);
 const scoped={...old,task:'Coordinate',items:[{...old.items[0]!,task:'Run tests'}]};
 await expect(f.service.setTeamPlan('p',task.taskId,scoped)).rejects.toThrow('immutable');
 await f.send();
 await expect(f.service.setTeamPlan('p',task.taskId,scoped)).rejects.toThrow('immutable');
 await f.service.setTeamPlan('p',task.taskId,old);
 expect(JSON.parse(f.rows.get(task.taskId)!.payload).teamPlan).toEqual(old);
});

it.each(['sent', 'running', 'queued', 'workers'])('rejects late initial plan registration after %s', async state => {
 const f=fixture(),task=await f.create();
 if(state==='sent') await f.send();
 if(state==='running') vi.mocked(f.deps.inspect).mockResolvedValue({execution:f.execution,pending:[]});
 if(state==='queued') vi.mocked(f.deps.inspect).mockResolvedValue({execution:null,pending:[{clientId:'queued'}]});
 if(state==='workers') f.deps.assertTeamPlanUnstarted=async()=>{throw new Error('Workers already exist');};
 await expect(f.service.setTeamPlan('p',task.taskId,{concurrency:1,task:'Coordinate',items:[]})).rejects.toThrow();
 expect(JSON.parse(f.rows.get(task.taskId)!.payload).teamPlan).toBeUndefined();
});

it('registers a complete scope once and permits only identical replays', async () => {
 const f=fixture(),task=await f.create();
 const plan={concurrency:2,task:'Coordinate',items:[{label:'sample',workingDir:'/answer',route:f.route,task:'Run tests'}]};
 await f.service.setTeamPlan('p',task.taskId,plan);
 await f.service.setTeamPlan('p',task.taskId,plan);
 await expect(f.service.setTeamPlan('p',task.taskId,{...plan,task:'Publish'})).rejects.toThrow('immutable');
 await expect(f.service.setTeamPlan('p',task.taskId,{...plan,items:[{...plan.items[0]!,task:'Publish'}]})).rejects.toThrow('immutable');
});
