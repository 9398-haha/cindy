import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';

import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';
import type { OrcaTeamServiceDeps } from '../orcaTeamService.js';

const store = vi.hoisted(() => ({
  archiveSingleWorkerSession: vi.fn(async () => undefined),
  getRemoteWorkerByProxySession: vi.fn(async () => null),
  insertRemoteWorkerProxySession: vi.fn(async () => undefined),
  listActiveRemoteWorkers: vi.fn(async () => []),
  listUnreleasedEndedRemoteWorkers: vi.fn(async () => []),
  markWorkerRemoteReleased: vi.fn(async () => undefined),
  setWorkerLastBridgedMessageId: vi.fn(async () => undefined),
  setWorkerRemoteExecution: vi.fn(async () => undefined),
}));
vi.mock('../../localDb/orcaTeamStore.js', () => store);

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
  devices?: DeviceLinkDeviceView[];
  handle?: (deviceId: string, channel: string, args: unknown[]) => InvokeResultPayload | undefined;
} = {}) {
  const devices = opts.devices ?? [device({})];
  const remoteInvoke = vi.fn(async (deviceId: string, channel: string, args: unknown[]) => {
    const custom = opts.handle?.(deviceId, channel, args);
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
    remoteInvoke,
    listDevices: async () => ({ devices }),
    getTeamService: () => null,
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
    expect(store.archiveSingleWorkerSession).toHaveBeenCalledWith('proxy-1', undefined);
    expect(remoteInvoke.mock.calls.some(([, channel]) => channel === 'maker:orca:remote-worker:release')).toBe(true);
    expect(store.markWorkerRemoteReleased).toHaveBeenCalledWith('w-1');
    expect(workers.runtime.isRemote('proxy-1')).toBe(false);
  });
});
