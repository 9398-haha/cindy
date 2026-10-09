/**
 * Lead 所在电脑：协同远端 Worker 的宿主装配。
 *
 *  - 可选运行设备：同账号、在线、对方开启远程控制、本机允许控制的桌面电脑；逐台探测能力，
 *    旧版本标为需要更新(只读，控制端也经 `maker:orca:execution-devices` 读同一份)；
 *  - 创建：在运行设备上 open 任务，本机写一条不跑 Agent 的代理任务行，登记到运行时轮询；
 *  - 运行：把 OrcaTeamService 的会话依赖按「是否远端 Worker」分流——派活、停止、存活查询
 *    走运行设备，其余(计槽、回报、状态机)沿用现有实现；
 *  - 结束：归档或结束团队时通知运行设备 release，失败的留待重连后补发。
 */
import { createId } from '@paralleldrive/cuid2';
import {
  DeviceLinkError,
  ORCA_REMOTE_WORKER_CAPS_CHANNEL,
  ORCA_REMOTE_WORKER_OPEN_CHANNEL,
  type InvokeResultPayload,
  type OrcaExecutionDeviceView,
  type OrcaRemoteWorkerOpenResult as DeviceOpenResult,
} from '@cindy/device-link';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import type { AgentKind } from '@cindy/maker-core';

import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import {
  archiveSingleWorkerSession,
  getRemoteWorkerByProxySession,
  insertRemoteWorkerProxySession,
  listActiveRemoteWorkers,
  listUnreleasedEndedRemoteWorkers,
  markWorkerRemoteReleased,
  setWorkerLastBridgedMessageId,
  setWorkerRemoteExecution,
} from '../localDb/orcaTeamStore.js';
import { createHostSendFailure } from '../maker-host/send-outcome.js';
import type {
  OrcaRemoteWorkerOpenResult,
  OrcaWorkerCreationDeps,
} from './orcaWorkerCreationService.js';
import {
  createOrcaRemoteWorkerRuntime,
  type OrcaRemoteWorkerRuntime,
  type RemoteWorkerTurnEnd,
} from './orcaRemoteWorkerRuntime.js';
import type { OrcaTeamService, OrcaTeamServiceDeps } from './orcaTeamService.js';

const CAPS_PROBE_TIMEOUT_MS = 5_000;
const RELEASE_RETRY_MS = 5 * 60_000;
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export interface OrcaRemoteWorkersDeps {
  remoteInvoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
  listDevices(): Promise<{ devices: DeviceLinkDeviceView[] }>;
  /** 事件回调需要的团队服务；创建顺序上晚于本模块，按需取。 */
  getTeamService(): OrcaTeamService | null;
  broadcastOrcaWorkerChanged(leadSessionId: string): void;
  readLeadTitle(leadSessionId: string): Promise<string>;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** 把隧道结果统一成「成功返回值 / 抛出带 `[CODE]` 的错误」，保留 inFlight 标记。 */
export async function invokeDeviceValue(
  remoteInvoke: OrcaRemoteWorkersDeps['remoteInvoke'],
  deviceId: string,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  let result: InvokeResultPayload;
  try {
    result = await remoteInvoke(deviceId, channel, args);
  } catch (err) {
    if (err instanceof DeviceLinkError) {
      throw Object.assign(new Error(`[${err.code}] ${err.message}`), {
        inFlight: err.inFlight === true,
      });
    }
    throw err;
  }
  if (result.ok) return result.result;
  const code =
    result.error.code === 'IPC_ERROR'
      ? (/^\[([A-Z_]+)\]/.exec(result.error.message)?.[1] ?? 'IPC_ERROR')
      : result.error.code;
  throw new Error(`[${code}] ${result.error.message}`);
}

function codeOf(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  return /^\[([A-Z_]+)\]/.exec(message)?.[1] ?? null;
}

export function isExecutionDeviceCandidate(device: DeviceLinkDeviceView): boolean {
  return (
    device.online &&
    device.remoteControlEnabled &&
    device.controlEnabled &&
    !device.isSelf &&
    !isMobilePlatform(device.platform)
  );
}

export function createOrcaRemoteWorkers(deps: OrcaRemoteWorkersDeps) {
  const deviceNames = new Map<string, string>();
  let releaseRetryTimer: ReturnType<typeof setInterval> | null = null;
  const invoke = (deviceId: string, channel: string, args: unknown[]) =>
    invokeDeviceValue(deps.remoteInvoke, deviceId, channel, args);
  const nameOf = (deviceId: string) => deviceNames.get(deviceId) || '另一台电脑';

  const runtime: OrcaRemoteWorkerRuntime = createOrcaRemoteWorkerRuntime({
    invoke,
    deviceName: nameOf,
    saveLastBridgedMessageId: setWorkerLastBridgedMessageId,
    onTurnStarted: async (proxySessionId) => {
      await deps.getTeamService()?.handleWorkerTurnStarted(proxySessionId);
    },
    onTurnEnded: async (proxySessionId, turn: RemoteWorkerTurnEnd) => {
      const service = deps.getTeamService();
      if (!service) return;
      if (turn.finalText)
        service.captureWorkerText(proxySessionId, turn.finalText, { isFinal: true });
      await service.handleWorkerTerminalTurn({
        sessionId: proxySessionId,
        status: turn.status,
        finalText: turn.finalText,
        ...(turn.diagnostic ? { diagnostic: turn.diagnostic } : {}),
      });
    },
    onWorkerStateChanged: deps.broadcastOrcaWorkerChanged,
    now: Date.now,
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: deps.log,
  });

  async function refreshDeviceNames(): Promise<DeviceLinkDeviceView[]> {
    const { devices } = await deps.listDevices();
    for (const device of devices) if (device.name) deviceNames.set(device.deviceId, device.name);
    return devices;
  }

  async function probeSupported(deviceId: string): Promise<boolean | null> {
    try {
      await Promise.race([
        invoke(deviceId, ORCA_REMOTE_WORKER_CAPS_CHANNEL, []),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('[INVOKE_TIMEOUT] caps probe timed out')),
            CAPS_PROBE_TIMEOUT_MS,
          ).unref?.(),
        ),
      ]);
      return true;
    } catch (err) {
      return codeOf(err) === 'CHANNEL_NOT_ALLOWED' ? false : null;
    }
  }

  async function releaseAndMark(row: {
    workerId: string;
    deviceId: string;
    remoteSessionId: string;
  }) {
    if (await runtime.release(row))
      await markWorkerRemoteReleased(row.workerId).catch(() => undefined);
  }

  async function retryPendingReleases(): Promise<void> {
    const rows = await listUnreleasedEndedRemoteWorkers().catch(() => []);
    await Promise.all(rows.map(releaseAndMark));
  }

  return {
    runtime,

    /**
     * 按当前账号恢复仍在协同中的远端 Worker，并补发未送达的结束通知。可重入：每次先清空
     * 上一账号的登记，数据库就绪后(及账号切换后)由宿主再调一次。
     */
    async start(): Promise<void> {
      runtime.reset();
      if (releaseRetryTimer) clearInterval(releaseRetryTimer);
      releaseRetryTimer = null;
      await refreshDeviceNames().catch(() => undefined);
      for (const row of await listActiveRemoteWorkers()) runtime.track(row);
      void retryPendingReleases();
      // 结束通知在运行设备离线时发不出去；低频补发，送达即记账，不重复。
      releaseRetryTimer = setInterval(() => void retryPendingReleases(), RELEASE_RETRY_MS);
      releaseRetryTimer.unref?.();
    },

    stop(): void {
      runtime.stop();
      if (releaseRetryTimer) clearInterval(releaseRetryTimer);
      releaseRetryTimer = null;
    },

    deviceName: nameOf,

    async listExecutionDevices(): Promise<OrcaExecutionDeviceView[]> {
      const devices = (await refreshDeviceNames()).filter(isExecutionDeviceCandidate);
      const supported = await Promise.all(devices.map((device) => probeSupported(device.deviceId)));
      // 探测失败(超时等)视为暂时不可用，不列出；明确不支持的列为需要更新。顺序固定：
      // 可用的在前，再按名称，避免每次打开列表顺序跳动。
      return devices
        .flatMap((device, index) =>
          supported[index] === null
            ? []
            : [
                {
                  deviceId: device.deviceId,
                  name: device.name,
                  platform: device.platform,
                  supported: supported[index] === true,
                },
              ],
        )
        .sort(
          (a, b) =>
            Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name),
        );
    },

    async openRemoteWorker(
      input: Parameters<NonNullable<OrcaWorkerCreationDeps['openRemoteWorker']>>[0],
    ): Promise<OrcaRemoteWorkerOpenResult> {
      const devices = await refreshDeviceNames().catch(() => null);
      const device = devices?.find((item) => item.deviceId === input.deviceId);
      if (devices && (!device || !isExecutionDeviceCandidate(device))) {
        return {
          ok: false,
          errorCode: 'REMOTE_AGENT_DEVICE_UNREACHABLE',
          message: `${device?.name ?? '指定的电脑'} 当前不可用：需要在线，且已开启「允许远程控制」。`,
        };
      }
      const name = nameOf(input.deviceId);
      const supported = await probeSupported(input.deviceId);
      if (supported === false) {
        return {
          ok: false,
          errorCode: 'UNSUPPORTED_CAPABILITY',
          message: `${name} 的 Cindy 版本过旧，需要更新后才能运行协同 Worker。`,
        };
      }
      if (supported === null) {
        return {
          ok: false,
          errorCode: 'REMOTE_AGENT_DEVICE_UNREACHABLE',
          message: `${name} 当前不可达，Worker 没有创建。`,
        };
      }
      const remoteSessionId = createId();
      let opened: DeviceOpenResult;
      try {
        opened = (await invoke(input.deviceId, ORCA_REMOTE_WORKER_OPEN_CHANNEL, [
          {
            sessionId: remoteSessionId,
            agentKind: input.agent,
            ...(input.model ? { model: input.model } : {}),
            ...(input.providerId ? { providerId: input.providerId } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.fast !== undefined ? { fastMode: input.fast } : {}),
            permissionMode: input.permissionMode,
            ...(input.workingDir ? { workingDir: input.workingDir } : {}),
            title: input.title,
            lead: {
              leadSessionId: input.leadSessionId,
              leadTitle: await deps.readLeadTitle(input.leadSessionId).catch(() => ''),
              workerLabel: input.label,
            },
          },
        ])) as DeviceOpenResult;
      } catch (err) {
        const code = codeOf(err);
        if (code === 'CHANNEL_NOT_ALLOWED' && input.workingDir) {
          return {
            ok: false,
            errorCode: 'INVALID_PARAMS',
            message: `${name} 上找不到这个目录或不允许使用：${input.workingDir}。Worker 没有创建。`,
          };
        }
        if (
          code === 'INVALID_PARAMS' ||
          code === 'WORKDIR_NOT_FOUND' ||
          code === 'NOT_A_DIRECTORY'
        ) {
          return {
            ok: false,
            errorCode: 'INVALID_PARAMS',
            message: `${name} 拒绝了创建请求：${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (code === 'CHANNEL_NOT_ALLOWED') {
          return {
            ok: false,
            errorCode: 'UNSUPPORTED_CAPABILITY',
            message: `${name} 的 Cindy 版本过旧，需要更新后才能运行协同 Worker。`,
          };
        }
        deps.log.warn('orca remote worker: open failed', { deviceId: input.deviceId, code });
        return {
          ok: false,
          errorCode:
            code === 'INVOKE_TIMEOUT' || code === 'DEVICE_OFFLINE' || code === 'LINK_NOT_OPEN'
              ? 'REMOTE_AGENT_DEVICE_UNREACHABLE'
              : 'INTERNAL',
          message: `在 ${name} 上创建 Worker 失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const proxySessionId = createId();
      const agent: AgentKind = opened.agentKind ?? input.agent;
      try {
        await insertRemoteWorkerProxySession({
          id: proxySessionId,
          title: input.title,
          agentKind: agent,
          model: opened.model || input.model || '',
          effort: input.effort && EFFORTS.has(input.effort) ? input.effort : null,
          permissionMode: input.permissionMode,
          fastMode: input.fast === true,
        });
      } catch (err) {
        await releaseAndMark({
          workerId: input.workerId,
          deviceId: input.deviceId,
          remoteSessionId,
        }).catch(() => undefined);
        throw err;
      }
      return {
        ok: true,
        proxySessionId,
        remoteSessionId: opened.sessionId || remoteSessionId,
        agent,
        model: opened.model,
        workingDir: opened.workingDir,
      };
    },

    async recordRemoteWorker(
      input: Parameters<NonNullable<OrcaWorkerCreationDeps['recordRemoteWorker']>>[0],
    ) {
      await setWorkerRemoteExecution(input.workerId, {
        deviceId: input.deviceId,
        remoteSessionId: input.remoteSessionId,
      });
      const { workingDir, ...ref } = input;
      runtime.track({ ...ref, lastBridgedMessageId: null }, { workingDir });
      deps.broadcastOrcaWorkerChanged(input.leadSessionId);
    },

    async discardRemoteWorker(input: {
      proxySessionId: string;
      deviceId: string;
      remoteSessionId: string;
    }) {
      runtime.untrack(input.proxySessionId);
      await runtime.release(input);
      await archiveSingleWorkerSession(input.proxySessionId).catch(() => undefined);
    },

    archive,
    wrapTeamDeps,

    /** 团队结束后：停掉仍在跑的远端 Worker，并补发全部未送达的结束通知。 */
    async releaseEnded(proxySessionIds: readonly string[]): Promise<void> {
      await Promise.all(
        proxySessionIds
          .filter((id) => runtime.isRemote(id))
          .map(async (id) => {
            if (runtime.isTurnRunning(id)) await runtime.abort(id);
            runtime.untrack(id);
          }),
      );
      await retryPendingReleases();
    },
  };

  /** 归档或结束团队：通知运行设备结束协同(任务保留)，本机归档代理行。 */
  async function archive(
    proxySessionId: string,
    beforeMutation?: () => Promise<void>,
  ): Promise<void> {
    const row = await getRemoteWorkerByProxySession(proxySessionId);
    runtime.untrack(proxySessionId);
    await archiveSingleWorkerSession(proxySessionId, beforeMutation);
    if (row) await releaseAndMark(row);
  }

  /**
   * 包装 OrcaTeamService 的会话依赖：远端 Worker 的代理任务在本机永远不跑 Agent，
   * 涉及会话的操作改走运行设备；其余依赖原样透传。
   */
  function wrapTeamDeps(base: OrcaTeamServiceDeps): OrcaTeamServiceDeps {
    const remote = (sessionId: string) => runtime.isRemote(sessionId);
    const wrapped: OrcaTeamServiceDeps = {
      ...base,
      // 远端 Worker 在本机永远没有活会话；只有运行设备正在跑时才视为在线，
      // 否则按「已恢复」派发(恢复本身是空操作)，wake_kind 与实际一致。
      getLiveSession: (sessionId) =>
        remote(sessionId)
          ? runtime.isTurnRunning(sessionId)
            ? { isTurnRunning: () => true }
            : null
          : base.getLiveSession(sessionId),
      resumeWorkerSession: async (worker, link) => {
        if (remote(worker.sessionId)) return;
        await base.resumeWorkerSession(worker, link);
      },
      closeWorkerSession: async (sessionId, beforeClose) => {
        if (!remote(sessionId)) return base.closeWorkerSession(sessionId, beforeClose);
        await beforeClose?.();
        await runtime.abort(sessionId);
      },
      closeWorkerSessionIfIdle: async (sessionId, sendLockHeld) =>
        remote(sessionId)
          ? !runtime.isTurnRunning(sessionId)
          : base.closeWorkerSessionIfIdle(sessionId, sendLockHeld),
      hasPendingWorkerInput: async (sessionId) =>
        remote(sessionId)
          ? runtime.hasPendingReport(sessionId)
          : base.hasPendingWorkerInput(sessionId),
      archiveWorkerSession: async (sessionId, beforeMutation) => {
        if (!remote(sessionId)) {
          const row = await getRemoteWorkerByProxySession(sessionId).catch(() => null);
          if (!row) return base.archiveWorkerSession(sessionId, beforeMutation);
        }
        await archive(sessionId, beforeMutation);
      },
      dispatchWorkerMessage: async (params) => {
        if (!remote(params.targetSessionId)) return base.dispatchWorkerMessage(params);
        const clientId = createId();
        const result = await runtime.dispatch({
          proxySessionId: params.targetSessionId,
          rawContent: params.message,
          clientId,
        });
        const meta = { source: params.dispatchMeta.source, context: params.dispatchMeta.context };
        if (!result.ok) {
          return {
            ok: false,
            dispatchOutcome: {
              ...createHostSendFailure(
                result.code === 'DEVICE_UNREACHABLE'
                  ? 'HOST_NOT_READY'
                  : result.code === 'SESSION_NOT_FOUND'
                    ? 'SESSION_NOT_FOUND'
                    : 'SEND_FAILED',
                result.message,
              ),
              ...meta,
            },
          };
        }
        await params.onAccepted?.();
        await params.onAcceptedCommit?.();
        return {
          ok: true,
          mode: result.mode,
          clientId,
          dispatchOutcome:
            result.mode === 'queued'
              ? {
                  kind: 'session-dispatch',
                  source: meta.source,
                  dispatched: true,
                  wakeKind: 'queued',
                }
              : { kind: 'session-dispatch', source: meta.source, dispatched: true },
          targetTitle: null,
          targetLastUserSendAt: null,
        };
      },
      reserveWorkerMessage: async (params) => {
        if (!remote(params.targetSessionId)) return base.reserveWorkerMessage(params);
        // 打断改派：先停远端当前一轮，再把新指令作为下一条派过去。
        await params.beforeReserve?.();
        params.onReserved?.();
        await runtime.abort(params.targetSessionId);
        return wrapped.dispatchWorkerMessage({
          targetSessionId: params.targetSessionId,
          message: params.message,
          workerId: params.workerId,
          dispatchMeta: params.dispatchMeta,
          onAccepted: params.onAccepted,
          onAcceptedRollback: params.onAcceptedRollback,
          onAcceptedCommit: params.onAcceptedCommit,
        });
      },
      requestWorkerInterrupt: async (sessionId) => {
        if (!remote(sessionId)) return base.requestWorkerInterrupt(sessionId);
        const requested = await runtime.abort(sessionId);
        return { stopOutcome: requested ? 'requested' : 'unconfirmed', queuePaused: false };
      },
      getWorkerQueuePaused: (sessionId) =>
        remote(sessionId) ? false : base.getWorkerQueuePaused(sessionId),
      getSessionQueueSnapshot: async (sessionId) =>
        remote(sessionId)
          ? {
              pendingQueue: [],
              steeringClientIds: [],
              consumingClientIds: [],
              inspectionMessages: [],
              isWorking: runtime.isTurnRunning(sessionId),
              willQueue: runtime.isTurnRunning(sessionId),
              queuePaused: false,
            }
          : base.getSessionQueueSnapshot(sessionId),
      ensureWorkerQueueRestored: async (sessionId) =>
        remote(sessionId) ? false : base.ensureWorkerQueueRestored(sessionId),
      removeQueuedMessage: (sessionId, clientId, expected) =>
        remote(sessionId) ? false : base.removeQueuedMessage(sessionId, clientId, expected),
      replaceQueuedMessage: (sessionId, clientId, next, expected) =>
        remote(sessionId) ? false : base.replaceQueuedMessage(sessionId, clientId, next, expected),
      steerStoredQueuedMessage: async (sessionId, clientId) =>
        remote(sessionId)
          ? { kind: 'queued', reason: 'STEER_UNSUPPORTED' }
          : base.steerStoredQueuedMessage(sessionId, clientId),
      moveQueuedMessage: (sessionId, clientId, position) =>
        remote(sessionId) ? null : base.moveQueuedMessage(sessionId, clientId, position),
      mergeQueuedMessages: (sessionId, clientIds, buildReplacement) =>
        remote(sessionId)
          ? false
          : base.mergeQueuedMessages(sessionId, clientIds, buildReplacement),
    };
    return wrapped;
  }
}

export type OrcaRemoteWorkers = ReturnType<typeof createOrcaRemoteWorkers>;
