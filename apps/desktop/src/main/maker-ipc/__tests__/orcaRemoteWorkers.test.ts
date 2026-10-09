import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';

import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';
import type { OrcaTeamService, OrcaTeamServiceDeps, WorkerTerminalTurnCapture } from '../orcaTeamService.js';
import { withSendToSessionLock } from '../sendToSessionLock.js';

const store = vi.hoisted(() => ({
  archiveSingleWorkerSession: vi.fn(async () => undefined),
  getRemoteWorkerByProxySession: vi.fn(async () => null),
  insertRemoteWorkerProxySession: vi.fn(async () => undefined),
  listActiveRemoteWorkers: vi.fn(async () => []),
  listUnreleasedEndedRemoteWorkers: vi.fn(async () => []),
  markWorkerRemoteReleased: vi.fn(async () => undefined),
  saveWorkerRemoteReport: vi.fn(async () => undefined),
  markWorkerRemoteStopConfirmed: vi.fn(async () => undefined),
  getWorkerRemoteReleaseState: vi.fn(async () => ({ remoteStopConfirmedAt: null as number | null, remoteReleasedAt: null as number | null })),
  saveRemoteWorkerOpen: vi.fn(async () => undefined),
  removeRemoteWorkerOpen: vi.fn(async () => undefined),
  listOrphanRemoteWorkerOpens: vi.fn(async (_sessionId?: string) => []),
  setWorkerRemoteExecution: vi.fn(async () => undefined),
}));
vi.mock('../../localDb/orcaTeamStore.js', () => store);
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

import {
  createOrcaRemoteWorkers,
  invokeDeviceValue,
  isExecutionDeviceCandidate,
} from '../orcaRemoteWorkers.js';

function device(overrides: Partial<DeviceLinkDeviceView>): DeviceLinkDeviceView {
  return {
    deviceId: 'mac-mini',
    name: 'Mac mini',
    platform: 'darwin',
    appVersion: '1.0.0',
    lastSeenAt: null,
    online: true,
    busy: false,
    remoteControlEnabled: true,
    controlEnabled: true,
    isSelf: false,
    ...overrides,
  };
}

const ok = (result: unknown): InvokeResultPayload => ({ ok: true, result }) as InvokeResultPayload;
const fail = (code: string, message: string): InvokeResultPayload =>
  ({ ok: false, error: { code, message } }) as InvokeResultPayload;

function setup(opts: {
  getOwnerToken?: () => unknown;
  devices?: DeviceLinkDeviceView[];
  handle?: (deviceId: string, channel: string, args: unknown[]) => InvokeResultPayload | undefined | Promise<InvokeResultPayload | undefined>;
  getTeamService?: () => OrcaTeamService | null;
} = {}) {
  const devices = opts.devices ?? [device({})];
  const remoteInvoke = vi.fn(async (deviceId: string, channel: string, args: unknown[]) => {
    const custom = await opts.handle?.(deviceId, channel, args);
    if (custom) return custom;
    switch (channel) {
      case 'maker:orca:remote-worker:caps':
        return ok({ version: 1 });
      case 'maker:orca:remote-worker:open':
        return ok({
          sessionId: (args[0] as { sessionId: string }).sessionId,
          workingDir: '/Users/demo/Interviews',
          model: 'claude-opus-5-5',
          agentKind: 'claude-code',
        });
      case 'local-db:sessions:get':
        return ok({ id: 'remote-1', status: 'active', agentKind: 'cc', workingDir: '/Users/demo/Interviews', model: 'm' });
      case 'local-db:history:messages':
        return ok({ items: [], terminal: null });
      case 'maker:input:enqueue':
        return ok({});
      case 'maker:abort-session':
        return ok(undefined);
      case 'maker:orca:remote-worker:release':
        return ok({ released: true });
      default:
        return fail('CHANNEL_NOT_ALLOWED', channel);
    }
  });
  const workers = createOrcaRemoteWorkers({
    getOwnerToken: opts.getOwnerToken,
    remoteInvoke,
    listDevices: async () => ({ devices }),
    getTeamService: opts.getTeamService ?? (() => null),
    broadcastOrcaWorkerChanged: vi.fn(),
    readLeadTitle: async () => '访谈整理',
    log: { info: vi.fn(), warn: vi.fn() },
  });
  return { workers, remoteInvoke };
}

const openInput = {
  deviceId: 'mac-mini',
  workerId: 'w-1',
  teamId: 'team-1',
  leadSessionId: 'lead-1',
  label: 'transcriber',
  role: 'developer',
  agent: 'claude-code' as const,
  permissionMode: 'auto' as const,
  title: 'transcriber',
};

function baseDeps() {
  return {
    getLiveSession: vi.fn(() => null),
    dispatchWorkerMessage: vi.fn(async () => ({ ok: true, local: true })),
    hasPendingWorkerInput: vi.fn(async () => true),
    archiveWorkerSession: vi.fn(async () => undefined),
    withSessionSendLock: withSendToSessionLock,
  } as unknown as OrcaTeamServiceDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('invokeDeviceValue', () => {
  it('unwraps the tunnel result and keeps the original error code', async () => {
    await expect(invokeDeviceValue(async () => ok(3), 'd', 'c', [])).resolves.toBe(3);
    await expect(
      invokeDeviceValue(async () => fail('IPC_ERROR', '[NOT_FOUND] gone'), 'd', 'c', []),
    ).rejects.toThrow(/^\[NOT_FOUND\]/);
    await expect(
      invokeDeviceValue(async () => fail('DEVICE_OFFLINE', 'offline'), 'd', 'c', []),
    ).rejects.toThrow(/^\[DEVICE_OFFLINE\]/);
  });

  it('marks link errors that hit an in-flight request', async () => {
    const lost = Object.assign(new DeviceLinkError('INVOKE_TIMEOUT' as never, 'lost'), {
      inFlight: true,
    });
    await expect(
      invokeDeviceValue(async () => Promise.reject(lost), 'd', 'c', []),
    ).rejects.toMatchObject({ message: '[INVOKE_TIMEOUT] lost', inFlight: true });
  });
});

describe('execution devices', () => {
  it('only offers other online desktops that allow remote control', () => {
    expect(isExecutionDeviceCandidate(device({}))).toBe(true);
    expect(isExecutionDeviceCandidate(device({ online: false }))).toBe(false);
    expect(isExecutionDeviceCandidate(device({ remoteControlEnabled: false }))).toBe(false);
    expect(isExecutionDeviceCandidate(device({ controlEnabled: false }))).toBe(false);
    expect(isExecutionDeviceCandidate(device({ isSelf: true }))).toBe(false);
    expect(isExecutionDeviceCandidate(device({ platform: 'ios' }))).toBe(false);
  });

  it('lists outdated devices as unsupported and leaves out devices that did not answer', async () => {
    const { workers } = setup({
      devices: [
        device({}),
        device({ deviceId: 'old-pc', name: 'Old PC', platform: 'win32' }),
        device({ deviceId: 'flaky', name: 'Flaky' }),
      ],
      handle: (deviceId, channel) =>
        channel !== 'maker:orca:remote-worker:caps'
          ? undefined
          : deviceId === 'old-pc'
            ? fail('CHANNEL_NOT_ALLOWED', channel)
            : deviceId === 'flaky'
              ? fail('DEVICE_OFFLINE', 'offline')
              : undefined,
    });
    await expect(workers.listExecutionDevices()).resolves.toEqual([
      { deviceId: 'mac-mini', name: 'Mac mini', platform: 'darwin', supported: true },
      { deviceId: 'old-pc', name: 'Old PC', platform: 'win32', supported: false },
    ]);
  });

  it('lists usable devices first in a stable order', async () => {
    const { workers } = setup({
      devices: [
        device({ deviceId: 'old-pc', name: 'Old PC' }),
        device({ deviceId: 'b', name: 'Beta' }),
        device({ deviceId: 'a', name: 'Alpha' }),
      ],
      handle: (deviceId, channel) =>
        channel === 'maker:orca:remote-worker:caps' && deviceId === 'old-pc'
          ? fail('CHANNEL_NOT_ALLOWED', channel)
          : undefined,
    });
    expect((await workers.listExecutionDevices()).map((d) => d.deviceId)).toEqual([
      'a',
      'b',
      'old-pc',
    ]);
  });
});

describe('openRemoteWorker', () => {
  it('opens the task on the device and writes a local proxy row without a directory', async () => {
    const { workers, remoteInvoke } = setup();
    const result = await workers.openRemoteWorker({ ...openInput, workingDir: '/Users/demo/Interviews' });
    expect(result).toMatchObject({
      ok: true,
      agent: 'claude-code',
      model: 'claude-opus-5-5',
      workingDir: '/Users/demo/Interviews',
    });
    const open = remoteInvoke.mock.calls.find(([, channel]) => channel === 'maker:orca:remote-worker:open');
    expect(open?.[2][0]).toMatchObject({
      agentKind: 'claude-code',
      permissionMode: 'auto',
      workingDir: '/Users/demo/Interviews',
      lead: { leadSessionId: 'lead-1', leadTitle: '访谈整理', workerLabel: 'transcriber' },
    });
    expect(store.insertRemoteWorkerProxySession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-5-5', permissionMode: 'auto' }),
    );
  });

  it('refuses an offline device without falling back to this computer', async () => {
    const { workers, remoteInvoke } = setup({ devices: [device({ online: false })] });
    await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({
      ok: false,
      errorCode: 'REMOTE_AGENT_DEVICE_UNREACHABLE',
    });
    expect(remoteInvoke).not.toHaveBeenCalled();
    expect(store.insertRemoteWorkerProxySession).not.toHaveBeenCalled();
  });

  it('reports an outdated device as unsupported', async () => {
    const { workers } = setup({
      handle: (_d, channel) =>
        channel === 'maker:orca:remote-worker:caps' ? fail('CHANNEL_NOT_ALLOWED', channel) : undefined,
    });
    await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({
      ok: false,
      errorCode: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('explains a rejected directory on the device', async () => {
    const { workers } = setup({
      handle: (_d, channel) =>
        channel === 'maker:orca:remote-worker:open' ? fail('CHANNEL_NOT_ALLOWED', 'path guard') : undefined,
    });
    await expect(
      workers.openRemoteWorker({ ...openInput, workingDir: '/nope' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS', message: expect.stringContaining('/nope') });
  });
});

describe('start', () => {
  it('rebuilds tracking for the current account each time it runs', async () => {
    const row = {
      workerId: 'w-1',
      teamId: 'team-1',
      leadSessionId: 'lead-1',
      proxySessionId: 'proxy-1',
      deviceId: 'mac-mini',
      remoteSessionId: 'remote-1',
      lastBridgedMessageId: null,
    };
    let owner = {};
    const { workers } = setup({ getOwnerToken: () => owner });
    store.listActiveRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.start();
    expect(workers.runtime.isRemote('proxy-1')).toBe(true);
    // 换账号后重建：上一账号的 Worker 不再被当作远端处理。
    owner = {};
    store.listActiveRemoteWorkers.mockResolvedValueOnce([] as never);
    await workers.start();
    expect(workers.runtime.isRemote('proxy-1')).toBe(false);
    workers.stop();
  });

  it('keeps accepted reports when ensureReady starts the same owner again', async () => {
    const { workers } = setup();
    const row = { ...openInput, proxySessionId: 'proxy-1', remoteSessionId: 'remote-1', lastBridgedMessageId: null };
    store.listActiveRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.start();
    await workers.runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'task', clientId: 'c-1' });
    await workers.start();
    expect(store.listActiveRemoteWorkers).toHaveBeenCalledOnce();
    expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
    workers.stop();
  });

  it('restores the TeamService report identity before tracking its durable pending input', async () => {
    const restore = vi.fn();
    const service = { restoreWorkerPendingReport: restore, captureWorkerTerminalTurn: vi.fn(() => ({ autoBridgeIdentity: {} })) };
    const { workers } = setup({ getTeamService: () => service as unknown as OrcaTeamService });
    const row = { ...openInput, proxySessionId: 'proxy-1', remoteSessionId: 'remote-1', lastBridgedMessageId: null,
      pendingReport: { clientIds: ['c-1'], baselineMessageId: null } };
    store.listActiveRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.start();
    expect(restore).toHaveBeenCalledWith('proxy-1', row);
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(service.captureWorkerTerminalTurn.mock.invocationCallOrder[0]!);
    expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
    workers.stop();
  });

  it('does not install an old account snapshot after another owner has restored', async () => {
    let owner = {};
    const { workers } = setup({ getOwnerToken: () => owner });
    let resolveRows!: (rows: never[]) => void;
    const gate = new Promise<never[]>((resolve) => { resolveRows = resolve; });
    store.listActiveRemoteWorkers.mockImplementationOnce(() => gate);
    const first = workers.start();
    await vi.waitFor(() => expect(store.listActiveRemoteWorkers).toHaveBeenCalledOnce());
    owner = {};
    store.listActiveRemoteWorkers.mockResolvedValueOnce([]);
    await workers.start();
    resolveRows([{ ...openInput, proxySessionId: 'old-proxy', remoteSessionId: 'remote-1' }] as never[]);
    await first;
    expect(workers.runtime.isRemote('old-proxy')).toBe(false);
    workers.stop();
  });
});

describe('wrapTeamDeps', () => {
  async function trackedWorker(setupOpts?: Parameters<typeof setup>[0]) {
    const ctx = setup(setupOpts);
    await ctx.workers.recordRemoteWorker({
      workerId: 'w-1',
      teamId: 'team-1',
      leadSessionId: 'lead-1',
      proxySessionId: 'proxy-1',
      deviceId: 'mac-mini',
      remoteSessionId: 'remote-1',
      workingDir: '/Users/demo/Interviews',
    });
    return ctx;
  }

  function reportService() {
    let capture: WorkerTerminalTurnCapture = {
      sessionId: 'proxy-1', manualInterrupt: null, autoBridgeIdentity: null,
    };
    const service = {
      captureWorkerTerminalTurn: vi.fn(() => capture),
      captureWorkerText: vi.fn(),
      handleWorkerTerminalTurn: vi.fn(async () => { capture = { ...capture, autoBridgeIdentity: null }; }),
      handleWorkerTurnStarted: vi.fn(async () => undefined),
    };
    const history: Array<{ id: string; clientId?: string; role: string; content: string }> = [];
    const handle = (_deviceId: string, channel: string, args: unknown[]) => {
      if (channel === 'maker:input:enqueue') {
        const clientId = (args[1] as { clientId: string }).clientId;
        history.push({ id: `input-${clientId}`, clientId, role: 'user', content: 'Lead input' });
        return ok({});
      }
      if (channel === 'maker:input:get-projection') {
        return ok({ deliveryReceipts: (args[1] as { deliveryClientIds: string[] }).deliveryClientIds
          .map((clientId) => ({ clientId, state: 'accepted' })) });
      }
      if (channel === 'maker:list-active') return ok({ sessions: [] });
      if (channel === 'local-db:history:messages') {
        const roles = (args[0] as { roles: string[] }).roles;
        return ok({ items: history.filter((row) => roles.includes(row.role)).slice().reverse(), hasMore: false });
      }
      return undefined;
    };
    const onAccepted = async () => {
      capture = { sessionId: 'proxy-1', manualInterrupt: null, autoBridgeIdentity: {} };
    };
    return { service, history, handle, onAccepted, capture: () => capture };
  }

  it('waits for the host accepted lifecycle before reporting an immediate remote reply', async () => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    const wrapped = workers.wrapTeamDeps(baseDeps());
    let finishCommit!: () => void;
    let enteredCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => { finishCommit = resolve; });
    const entered = new Promise<void>((resolve) => { enteredCommit = resolve; });
    const dispatch = wrapped.dispatchWorkerMessage({
      targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
      onAccepted: report.onAccepted,
      onAcceptedCommit: async () => { enteredCommit(); await commitGate; },
    } as never);
    try {
      await entered;
      report.history.push({ id: 'reply-1', role: 'assistant', content: 'Immediate result' });
      await workers.runtime.pollNow();
      expect(report.service.handleWorkerTerminalTurn).not.toHaveBeenCalled();
      expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
      finishCommit();
      await dispatch;
      await workers.runtime.pollNow();
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledWith(expect.objectContaining({
        finalText: 'Immediate result', capture: expect.objectContaining({ sessionId: 'proxy-1' }),
      }));
    } finally {
      finishCommit();
      await dispatch;
      workers.stop();
    }
  });

  it('keeps the old terminal capture when a new dispatch commits during report persistence', async () => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    const wrapped = workers.wrapTeamDeps(baseDeps());
    const dispatch = () => wrapped.dispatchWorkerMessage({
      targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' }, onAccepted: report.onAccepted,
    } as never);
    try {
      await dispatch();
      const firstCapture = report.capture();
      report.history.push({ id: 'reply-1', role: 'assistant', content: 'First result' });
      report.service.handleWorkerTerminalTurn.mockImplementationOnce(async () => { await dispatch(); });
      await workers.runtime.pollNow();
      expect(report.capture()).not.toBe(firstCapture);
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledWith(expect.objectContaining({
        finalText: 'First result', capture: firstCapture,
      }));
      expect(report.service.captureWorkerText).not.toHaveBeenCalled();
      expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
      report.history.push({ id: 'reply-2', role: 'assistant', content: 'Second result' });
      await workers.runtime.pollNow();
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenLastCalledWith(expect.objectContaining({
        finalText: 'Second result', capture: expect.objectContaining({ sessionId: 'proxy-1' }),
      }));
    } finally { workers.stop(); }
  });

  it('serializes concurrent remote sends through accepted commit so the latest reply owns the latest capture', async () => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    const wrapped = workers.wrapTeamDeps(baseDeps());
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const params = {
      targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' }, onAccepted: report.onAccepted,
    };
    const first = wrapped.dispatchWorkerMessage({ ...params, onAccepted: async () => {
      enteredFirst(); await firstGate; await report.onAccepted();
    } } as never);
    let second: ReturnType<typeof wrapped.dispatchWorkerMessage> | undefined;
    try {
      await entered;
      second = wrapped.dispatchWorkerMessage(params as never);
      // Drain queued microtasks without releasing the first accepted callback.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(report.history.filter((row) => row.role === 'user')).toHaveLength(1);
      releaseFirst();
      const results = await Promise.all([first, second]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(report.history.filter((row) => row.role === 'user')).toHaveLength(2);
      report.history.push({ id: 'reply-final', role: 'assistant', content: 'Latest result' });
      const latestCapture = report.capture();
      await workers.runtime.pollNow();
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledOnce();
      expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledWith(expect.objectContaining({
        finalText: 'Latest result', capture: latestCapture,
      }));
    } finally {
      releaseFirst();
      await first;
      await second;
      workers.stop();
    }
  });

  it.each([false, true])('restores the previous report after an accepted callback rolls back (previous=%s)', async (previous) => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    const wrapped = workers.wrapTeamDeps(baseDeps());
    const params = {
      targetSessionId: 'proxy-1', workerId: 'w-1', message: 'task',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' }, onAccepted: report.onAccepted,
    };
    try {
      if (previous) {
        await wrapped.dispatchWorkerMessage(params as never);
        report.history.push({ id: 'reply-1', role: 'assistant', content: 'First result' });
      }
      await expect(wrapped.dispatchWorkerMessage({ ...params,
        onAccepted: async () => { throw new Error('accepted lifecycle rolled back'); },
      } as never)).rejects.toThrow('accepted lifecycle rolled back');
      expect(workers.runtime.hasPendingReport('proxy-1')).toBe(previous);
      if (previous) {
        const previousCapture = report.capture();
        await workers.runtime.pollNow();
        expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledWith(expect.objectContaining({ finalText: 'First result', capture: previousCapture }));
      }
    } finally { workers.stop(); }
  });

  it('treats an idle remote worker as not live so dispatch reports it as resumed', async () => {
    const { workers } = await trackedWorker();
    const wrapped = workers.wrapTeamDeps(baseDeps());
    expect(wrapped.getLiveSession('proxy-1')).toBeNull();
    workers.stop();
  });

  it('leaves local workers on the existing path', async () => {
    const { workers } = await trackedWorker();
    const base = baseDeps();
    const wrapped = workers.wrapTeamDeps(base);
    await wrapped.dispatchWorkerMessage({ targetSessionId: 'local-1' } as never);
    expect(base.dispatchWorkerMessage).toHaveBeenCalledTimes(1);
    await expect(wrapped.hasPendingWorkerInput('local-1')).resolves.toBe(true);
    workers.stop();
  });

  it('sends a Lead message for a remote worker to its device', async () => {
    const { workers, remoteInvoke } = await trackedWorker();
    const base = baseDeps();
    const onAccepted = vi.fn(async () => undefined);
    const result = await workers.wrapTeamDeps(base).dispatchWorkerMessage({
      targetSessionId: 'proxy-1',
      workerId: 'w-1',
      message: '转写这段访谈',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
      onAccepted,
    } as never);
    expect(result).toMatchObject({ ok: true, mode: 'dispatched' });
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(base.dispatchWorkerMessage).not.toHaveBeenCalled();
    expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:input:enqueue')).toBe(true);
    workers.stop();
  });

  it('fails the dispatch when the device is offline instead of queueing it', async () => {
    let offline = false;
    const { workers } = await trackedWorker({
      handle: () => (offline ? fail('DEVICE_OFFLINE', 'offline') : undefined),
    });
    offline = true;
    const result = await workers.wrapTeamDeps(baseDeps()).dispatchWorkerMessage({
      targetSessionId: 'proxy-1',
      workerId: 'w-1',
      message: 'x',
      dispatchMeta: { source: 'mcp', context: 'send_to_worker' },
    } as never);
    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: { kind: 'host-send', accepted: false, code: 'HOST_NOT_READY' },
    });
    workers.stop();
  });

  it('archives a remote worker by releasing it on the device and keeping the task there', async () => {
    const { workers, remoteInvoke } = await trackedWorker();
    store.getRemoteWorkerByProxySession.mockResolvedValueOnce({
      workerId: 'w-1',
      teamId: 'team-1',
      leadSessionId: 'lead-1',
      proxySessionId: 'proxy-1',
      deviceId: 'mac-mini',
      remoteSessionId: 'remote-1',
      lastBridgedMessageId: null,
    } as never);
    const base = baseDeps();
    await workers.wrapTeamDeps(base).archiveWorkerSession('proxy-1');
    expect(base.archiveWorkerSession).not.toHaveBeenCalled();
    expect(store.archiveSingleWorkerSession).toHaveBeenCalledWith('proxy-1', expect.any(Function));
    expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:orca:remote-worker:release')).toBe(true);
    expect(store.markWorkerRemoteReleased).toHaveBeenCalledWith('w-1');
    expect(workers.runtime.isRemote('proxy-1')).toBe(false);
  });

  it('keeps remote routing when archive persistence or authorization fails', async () => {
    const { workers } = await trackedWorker();
    store.archiveSingleWorkerSession.mockRejectedValueOnce(new Error('permission revoked'));
    const base = baseDeps();
    const wrapped = workers.wrapTeamDeps(base);
    await expect(wrapped.archiveWorkerSession('proxy-1')).rejects.toThrow('permission revoked');
    expect(workers.runtime.isRemote('proxy-1')).toBe(true);
    await wrapped.dispatchWorkerMessage({ targetSessionId: 'proxy-1', message: 'task', dispatchMeta: { source: 'mcp' } } as never);
    expect(base.dispatchWorkerMessage).not.toHaveBeenCalled();
    workers.stop();
  });

  it('retries a Lead refusal until its captured report identity is settled', async () => {
    const report = reportService();
    const { workers } = await trackedWorker({ handle: report.handle, getTeamService: () => report.service as unknown as OrcaTeamService });
    await workers.wrapTeamDeps(baseDeps()).dispatchWorkerMessage({ targetSessionId: 'proxy-1', message: 'task',
      dispatchMeta: { source: 'mcp' }, onAccepted: report.onAccepted } as never);
    report.history.push({ id: 'reply-1', role: 'assistant', content: 'Result' });
    report.service.handleWorkerTerminalTurn.mockImplementationOnce(async () => undefined);
    await workers.runtime.pollNow();
    expect(workers.runtime.hasPendingReport('proxy-1')).toBe(true);
    await workers.runtime.pollNow();
    expect(workers.runtime.hasPendingReport('proxy-1')).toBe(false);
    expect(report.service.handleWorkerTerminalTurn).toHaveBeenCalledTimes(2);
    workers.stop();
  });

  it('stops a freshly dispatched Worker without waiting for the running poll and persists that phase', async () => {
    const { workers, remoteInvoke } = await trackedWorker();
    const row = { workerId: 'w-1', deviceId: 'mac-mini', remoteSessionId: 'remote-1', remoteStopConfirmedAt: null };
    store.listUnreleasedEndedRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.releaseEnded(['proxy-1']);
    expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:abort-session')).toHaveLength(1);
    expect(store.markWorkerRemoteStopConfirmed).toHaveBeenCalledWith('w-1');
    expect(store.markWorkerRemoteStopConfirmed.mock.invocationCallOrder[0]).toBeLessThan(
      remoteInvoke.mock.invocationCallOrder[remoteInvoke.mock.calls.findIndex(([, channel]) => channel === 'maker:orca:remote-worker:release')]!,
    );
    store.listUnreleasedEndedRemoteWorkers.mockResolvedValueOnce([{ ...row, remoteStopConfirmedAt: Date.now() }] as never);
    store.getWorkerRemoteReleaseState.mockResolvedValueOnce({ remoteStopConfirmedAt: Date.now(), remoteReleasedAt: null });
    await workers.releaseEnded([]);
    // A lost release reply must not stop a new ordinary task on the same B session.
    expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:abort-session')).toHaveLength(1);
    workers.stop();
  });

  it('coalesces overlapping releases and rereads phase before processing a stale snapshot', async () => {
    let releaseGate!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const releasing = new Promise<void>((resolve) => { entered = resolve; });
    const { workers, remoteInvoke } = await trackedWorker({ handle: async (_device, channel) => {
      if (channel === 'maker:orca:remote-worker:release') { entered(); await gate; }
      return undefined;
    } });
    const row = { workerId: 'w-1', deviceId: 'mac-mini', remoteSessionId: 'remote-1' };
    store.listUnreleasedEndedRemoteWorkers.mockResolvedValueOnce([row] as never).mockResolvedValueOnce([row] as never);
    const first = workers.releaseEnded(['proxy-1']);
    await releasing;
    const second = workers.releaseEnded([]);
    await vi.waitFor(() => expect(store.listUnreleasedEndedRemoteWorkers).toHaveBeenCalledTimes(2));
    releaseGate();
    await Promise.all([first, second]);
    store.getWorkerRemoteReleaseState.mockResolvedValueOnce({ remoteStopConfirmedAt: 1, remoteReleasedAt: 2 });
    store.listUnreleasedEndedRemoteWorkers.mockResolvedValueOnce([row] as never);
    await workers.releaseEnded([]);
    expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:abort-session')).toHaveLength(1);
    expect(remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:orca:remote-worker:release')).toHaveLength(1);
    workers.stop();
  });
});

describe('remote open recovery', () => {
  it('rechecks an orphan snapshot after a Worker has become associated', async () => {
    const { workers, remoteInvoke } = setup();
    let deliver!: (rows: never[]) => void;
    let entered!: () => void;
    const gate = new Promise<never[]>((resolve) => { deliver = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    store.listOrphanRemoteWorkerOpens.mockImplementationOnce(async () => { entered(); return gate; });
    const cleanup = workers.releaseEnded([]);
    await reading;
    await workers.recordRemoteWorker({ ...openInput, proxySessionId: 'proxy-1', remoteSessionId: 'remote-1' });
    store.listOrphanRemoteWorkerOpens.mockResolvedValueOnce([]);
    deliver([{ deviceId: 'mac-mini', remoteSessionId: 'remote-1', createdAt: Date.now() }] as never[]);
    await cleanup;
    expect(store.listOrphanRemoteWorkerOpens).toHaveBeenLastCalledWith('remote-1');
    expect(workers.runtime.isRemote('proxy-1')).toBe(true);
    expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:orca:remote-worker:release')).toBe(false);
    workers.stop();
  });

  it('rejects an old owner open that resumes after a new account starts', async () => {
    let owner = {};
    let finishList!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { finishList = resolve; });
    const listing = new Promise<void>((resolve) => { entered = resolve; });
    const invoke = vi.fn(async () => ok({ version: 1 }));
    let first = true;
    const workers = createOrcaRemoteWorkers({ getOwnerToken: () => owner, remoteInvoke: invoke,
      listDevices: async () => { if (first) { first = false; entered(); await gate; } return { devices: [device({})] }; },
      getTeamService: () => null, broadcastOrcaWorkerChanged: vi.fn(), readLeadTitle: async () => 'Old Lead',
      log: { info: vi.fn(), warn: vi.fn() } });
    const opening = workers.openRemoteWorker(openInput);
    // Attach the rejection assertion before allowing the old asynchronous request to resume.
    const rejected = expect(opening).rejects.toThrow('owner changed');
    await listing;
    workers.stop(); owner = {};
    await workers.start();
    finishList(); await rejected;
    expect(store.saveRemoteWorkerOpen).not.toHaveBeenCalled();
    expect(store.insertRemoteWorkerProxySession).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    workers.stop();
  });

  it('does not associate or discard an old creation in a new account', async () => {
    let owner = {};
    const { workers, remoteInvoke } = setup({ getOwnerToken: () => owner });
    const opened = await workers.openRemoteWorker(openInput);
    if (!opened.ok) throw Error('expected successful open');
    workers.stop(); owner = {}; await workers.start();
    const record = { ...openInput, proxySessionId: opened.proxySessionId, remoteSessionId: opened.remoteSessionId };
    await expect(workers.recordRemoteWorker(record)).rejects.toThrow('owner changed');
    await workers.discardRemoteWorker(record);
    expect(store.setWorkerRemoteExecution).not.toHaveBeenCalled();
    expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:orca:remote-worker:release')).toBe(false);
    workers.stop();
  });

  it('reuses the same remote session id after losing an open reply', async () => {
    let opens = 0;
    const { workers, remoteInvoke } = setup({ handle: (_device, channel) => {
      if (channel === 'maker:orca:remote-worker:open' && ++opens === 1) return fail('INVOKE_TIMEOUT', 'reply lost');
      return undefined;
    } });
    await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({ ok: true });
    const calls = remoteInvoke.mock.calls.filter(([, channel]) => channel === 'maker:orca:remote-worker:open');
    expect(calls).toHaveLength(2);
    expect(calls[0]![2]).toEqual(calls[1]![2]);
    expect(store.saveRemoteWorkerOpen).toHaveBeenCalledOnce();
    workers.stop();
  });

  it('retains an uncertain open for durable cleanup when both replies are lost', async () => {
    const { workers } = setup({ handle: (_device, channel) =>
      channel === 'maker:orca:remote-worker:open' ? fail('INVOKE_TIMEOUT', 'reply lost') : undefined });
    await expect(workers.openRemoteWorker(openInput)).resolves.toMatchObject({ ok: false });
    expect(store.saveRemoteWorkerOpen).toHaveBeenCalledOnce();
    expect(store.removeRemoteWorkerOpen).not.toHaveBeenCalled();
    workers.stop();
  });

  it.each(['REMOTE_WORKDIR_NOT_FOUND', 'REMOTE_WORKDIR_NOT_DIRECTORY', 'REMOTE_WORKDIR_INVALID', 'REMOTE_WORKDIR_UNAVAILABLE'])(
    'preserves the target directory error %s', async (code) => {
      const { workers } = setup({ handle: (_device, channel) => channel === 'maker:orca:remote-worker:open' ? fail(code, 'directory unavailable') : undefined });
      await expect(workers.openRemoteWorker({ ...openInput, workingDir: '/remote/folder' })).resolves.toMatchObject({ ok: false, errorCode: code });
      workers.stop();
    },
  );
});
