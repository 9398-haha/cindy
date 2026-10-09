import { describe, expect, it, vi } from 'vitest';

import {
  createOrcaRemoteWorkerRuntime,
  type OrcaRemoteWorkerRuntimeDeps,
  type RemoteWorkerRef,
} from '../orcaRemoteWorkerRuntime.js';

const ref: RemoteWorkerRef = {
  workerId: 'worker-1',
  teamId: 'team-1',
  leadSessionId: 'lead-1',
  proxySessionId: 'proxy-1',
  deviceId: 'mac-mini',
  remoteSessionId: 'remote-1',
  lastBridgedMessageId: null,
};

interface FakeDevice {
  offline: boolean;
  running: boolean;
  receipts: Record<string, string>;
  assistant: { id: string; content: unknown } | null;
  terminalError: boolean;
  enqueueError?: Error & { inFlight?: boolean };
  enqueued: unknown[];
  aborted: number;
  released: number;
}

function setup(device: Partial<FakeDevice> = {}) {
  const state: FakeDevice = {
    offline: false,
    running: false,
    receipts: {},
    assistant: { id: 'msg-0', content: '旧回复' },
    terminalError: false,
    enqueued: [],
    aborted: 0,
    released: 0,
    ...device,
  };
  const invoke = vi.fn(async (_deviceId: string, channel: string, args: unknown[]) => {
    if (state.offline) throw new Error('[DEVICE_OFFLINE] target offline');
    switch (channel) {
      case 'maker:list-active':
        return {
          format: 'active-sessions-v2',
          sessions: [{ sessionId: 'remote-1', isTurnRunning: state.running }],
        };
      case 'local-db:sessions:get':
        return {
          id: 'remote-1',
          status: 'active',
          agentKind: 'cc',
          workingDir: '/Users/demo/Interviews',
          model: 'claude-opus-5-5',
          effort: 'high',
          permissionMode: 'auto',
          fastMode: false,
          sdkSessionId: 'sdk-1',
        };
      case 'local-db:history:messages':
        return {
          items: state.assistant ? [state.assistant] : [],
          hasMore: false,
          nextCursor: null,
          terminal: state.terminalError ? { status: 'error' } : null,
        };
      case 'maker:input:enqueue':
        if (state.enqueueError) throw state.enqueueError;
        state.enqueued.push(args[1]);
        state.receipts[(args[1] as { clientId: string }).clientId] = 'pending';
        return {};
      case 'maker:input:get-projection': {
        const ids = (args[1] as { deliveryClientIds: string[] }).deliveryClientIds;
        return {
          deliveryReceipts: ids.map((clientId) => ({
            clientId,
            state: state.receipts[clientId] ?? 'unknown',
          })),
        };
      }
      case 'maker:abort-session':
        state.aborted += 1;
        return undefined;
      case 'maker:orca:remote-worker:release':
        state.released += 1;
        return { released: true };
      default:
        throw new Error(`[CHANNEL_NOT_ALLOWED] ${channel}`);
    }
  });
  const deps: OrcaRemoteWorkerRuntimeDeps = {
    invoke,
    deviceName: () => 'Mac mini',
    saveLastBridgedMessageId: vi.fn(async () => undefined),
    onTurnStarted: vi.fn(async () => undefined),
    onTurnEnded: vi.fn(async () => undefined),
    onWorkerStateChanged: vi.fn(),
    now: () => Date.parse('2026-10-09T10:24:00Z'),
    setTimeout: vi.fn(() => ({})),
    clearTimeout: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const runtime = createOrcaRemoteWorkerRuntime(deps);
  runtime.track(ref);
  return { runtime, deps, state, invoke };
}

describe('orca remote worker runtime', () => {
  it('enqueues a Lead message on the execution device with the device task’s own settings', async () => {
    const { runtime, state } = setup();
    await expect(
      runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: '转写这段访谈', clientId: 'c-1' }),
    ).resolves.toEqual({ ok: true, mode: 'dispatched' });
    expect(state.enqueued).toHaveLength(1);
    expect(state.enqueued[0]).toMatchObject({
      clientId: 'c-1',
      durableDelivery: true,
      text: '[From Orca Lead]\n转写这段访谈',
      origin: { kind: 'orca', senderLabel: 'Lead', displayText: '转写这段访谈' },
      createOpts: {
        agentKind: 'claude-code',
        workingDir: '/Users/demo/Interviews',
        model: 'claude-opus-5-5',
        resumeSessionId: 'sdk-1',
      },
    });
    expect((state.enqueued[0] as { text: string }).text).not.toContain('worker_id');
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
  });

  it('reports the turn start once and the final reply once after the message was consumed', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: '转写', clientId: 'c-1' });

    state.running = true;
    state.receipts['c-1'] = 'accepted';
    await runtime.pollNow();
    await runtime.pollNow();
    expect(deps.onTurnStarted).toHaveBeenCalledTimes(1);
    expect(runtime.isTurnRunning('proxy-1')).toBe(true);

    state.running = false;
    state.assistant = { id: 'msg-1', content: [{ type: 'text', text: '逐字稿已生成' }] };
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', {
      status: 'done',
      finalText: '逐字稿已生成',
    });
    expect(deps.saveLastBridgedMessageId).toHaveBeenCalledWith('worker-1', 'msg-1');
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);

    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting while the message is still queued behind other input on the device', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: '转写', clientId: 'c-1' });
    state.assistant = { id: 'msg-user-turn', content: '插话的回复' };
    await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
  });

  it('does not report turns started by someone on the device itself', async () => {
    const { runtime, deps, state } = setup();
    state.running = true;
    await runtime.pollNow();
    expect(runtime.isTurnRunning('proxy-1')).toBe(true);
    state.running = false;
    state.assistant = { id: 'msg-9', content: '插话的回复' };
    await runtime.pollNow();
    expect(deps.onTurnStarted).not.toHaveBeenCalled();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
  });

  it('marks the device unreachable without failing the worker, then recovers and still reports', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: '转写', clientId: 'c-1' });
    state.offline = true;
    await runtime.pollNow();
    expect(runtime.isReachable('proxy-1')).toBe(false);
    expect(deps.onWorkerStateChanged).toHaveBeenCalledWith('lead-1');
    expect(deps.onTurnEnded).not.toHaveBeenCalled();

    state.offline = false;
    state.receipts['c-1'] = 'accepted';
    state.assistant = { id: 'msg-1', content: '断线期间完成' };
    await runtime.pollNow();
    expect(runtime.isReachable('proxy-1')).toBe(true);
    expect(deps.onTurnEnded).toHaveBeenCalledWith('proxy-1', {
      status: 'done',
      finalText: '断线期间完成',
    });
  });

  it('fails a dispatch to an offline device instead of queueing it', async () => {
    const { runtime, state } = setup({ offline: true });
    const result = await runtime.dispatch({
      proxySessionId: 'proxy-1',
      rawContent: 'x',
      clientId: 'c-1',
    });
    expect(result).toMatchObject({ ok: false, code: 'DEVICE_UNREACHABLE' });
    expect(state.enqueued).toHaveLength(0);
    expect(runtime.hasPendingReport('proxy-1')).toBe(false);
  });

  it('treats a lost enqueue reply as delivered when the device already holds the message', async () => {
    const lost = Object.assign(new Error('[INVOKE_TIMEOUT] no reply'), { inFlight: true });
    const { runtime, state } = setup({ enqueueError: lost, receipts: { 'c-1': 'pending' } });
    await expect(
      runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' }),
    ).resolves.toEqual({ ok: true, mode: 'dispatched' });
    expect(state.enqueued).toHaveLength(0);
    expect(runtime.hasPendingReport('proxy-1')).toBe(true);
  });

  it('does not re-report an already bridged reply and ends with an error when no new reply appears', async () => {
    const { runtime, deps, state } = setup({ assistant: { id: 'msg-0', content: '旧回复' } });
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    for (let i = 0; i < 14; i += 1) await runtime.pollNow();
    expect(deps.onTurnEnded).not.toHaveBeenCalled();
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith(
      'proxy-1',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('reports an error turn when the device marks the session as failed', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' });
    state.receipts['c-1'] = 'accepted';
    state.terminalError = true;
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith(
      'proxy-1',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('reports an error when the message was withdrawn on the device', async () => {
    const { runtime, deps, state } = setup();
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' });
    state.receipts['c-1'] = 'removed';
    await runtime.pollNow();
    expect(deps.onTurnEnded).toHaveBeenCalledWith(
      'proxy-1',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('aborts and releases through the device and treats an already-deleted task as released', async () => {
    const { runtime, state, invoke } = setup();
    await expect(runtime.abort('proxy-1')).resolves.toBe(true);
    expect(state.aborted).toBe(1);
    await expect(runtime.release(ref)).resolves.toBe(true);
    expect(state.released).toBe(1);
    invoke.mockRejectedValueOnce(new Error('[NOT_FOUND] gone'));
    await expect(runtime.release(ref)).resolves.toBe(true);
    state.offline = true;
    await expect(runtime.release(ref)).resolves.toBe(false);
  });

  it('learns the working directory on the device once for display', async () => {
    const { runtime, deps, invoke } = setup();
    expect(runtime.workingDir('proxy-1')).toBeNull();
    await runtime.pollNow();
    expect(runtime.workingDir('proxy-1')).toBe('/Users/demo/Interviews');
    expect(deps.onWorkerStateChanged).toHaveBeenCalledWith('lead-1');
    await runtime.pollNow();
    expect(invoke.mock.calls.filter(([, channel]) => channel === 'local-db:sessions:get')).toHaveLength(1);
    runtime.track({ ...ref, proxySessionId: 'proxy-2' }, { workingDir: 'D:\\work' });
    expect(runtime.workingDir('proxy-2')).toBe('D:\\work');
  });

  it('polls slowly when idle and quickly while a report is pending', async () => {
    const { runtime, deps } = setup();
    expect(deps.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 15_000);
    await runtime.dispatch({ proxySessionId: 'proxy-1', rawContent: 'x', clientId: 'c-1' });
    expect(deps.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 2_000);
    runtime.untrack('proxy-1');
    expect(runtime.isRemote('proxy-1')).toBe(false);
  });
});
