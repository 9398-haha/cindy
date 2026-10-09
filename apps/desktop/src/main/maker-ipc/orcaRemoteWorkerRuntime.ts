/**
 * Lead 所在电脑侧：驱动在另一台电脑(运行设备)上运行的协同 Worker。
 *
 * 远端 Worker 在本机只有一条代理任务行(不跑 Agent)，真实任务在运行设备上。本模块负责：
 *  - 派活：经 `maker:input:enqueue` 投递到运行设备的任务，按 clientId 幂等；
 *  - 轮询：每台设备一次 `maker:list-active` 得到全部远端 Worker 的运行状态，派活后加快节奏；
 *  - 回报：派出的消息已进入对话(投递回执 accepted)且运行设备不在跑时，取最后一条 assistant
 *    消息交给现有 auto-bridge；按消息 id 去重，断线重连后自然补报，同一条只报一次；
 *  - 可达性：设备调用失败即标为不可达，恢复后自动回到在线，不判失败、不重派。
 *
 * 用户在运行设备上直接发的消息(插话)不会触发回报：只有本机派出、仍在等待回报的消息才会。
 */
import {
  DL_HISTORY_MESSAGES_CHANNEL,
  ORCA_REMOTE_WORKER_RELEASE_CHANNEL,
} from '@cindy/device-link';
import { formatAgentMessage, formatOrcaCommunicationMessage } from '@cindy/orca-workflow';

import type {
  AgentInputCreateOpts,
  AgentInputQueuedMessage,
} from '../../shared/agentInputQueue.js';

export interface RemoteWorkerRef {
  workerId: string;
  teamId: string;
  leadSessionId: string;
  /** 本机代理任务行 id；Orca 状态机、auto-bridge 都以它为键。 */
  proxySessionId: string;
  deviceId: string;
  /** 运行设备上的真实任务 id。 */
  remoteSessionId: string;
  lastBridgedMessageId: string | null;
}

export interface RemoteWorkerTurnEnd {
  status: 'done' | 'error';
  finalText: string;
  diagnostic?: string;
}

export type RemoteWorkerDispatchResult =
  | { ok: true; mode: 'dispatched' | 'queued' }
  | {
      ok: false;
      code: 'DEVICE_UNREACHABLE' | 'SESSION_NOT_FOUND' | 'SEND_FAILED';
      message: string;
    };

export interface OrcaRemoteWorkerRuntimeDeps {
  /** 调用运行设备的 channel；失败抛出 Error(message 形如 `[CODE] ...`)。 */
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<unknown>;
  deviceName(deviceId: string): string;
  saveLastBridgedMessageId(workerId: string, messageId: string): Promise<void>;
  onTurnStarted(proxySessionId: string): Promise<void>;
  onTurnEnded(proxySessionId: string, turn: RemoteWorkerTurnEnd): Promise<void>;
  /** 可达性或运行状态变化，供协同面板刷新。 */
  onWorkerStateChanged(leadSessionId: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** 派活后的轮询间隔；没有待回报时只做低频的可达性刷新。 */
export const REMOTE_WORKER_FAST_POLL_MS = 2_000;
export const REMOTE_WORKER_IDLE_POLL_MS = 15_000;
/** 消息已进入对话、设备不在跑，但还没有新回复时，最多再等这么多轮才按异常收尾。 */
const MISSING_REPLY_POLLS = 15;
/** `local-db:history:messages` 的 contentCharLimit 只接受 1–8000。 */
const MAX_REPORT_CHARS = 8_000;

/** 视为「设备当前不可达」的错误码：relay / 链路 / 本机开关 / 熔断。其余错误按普通失败处理。 */
const UNREACHABLE_CODES = new Set([
  'DEVICE_OFFLINE',
  'REMOTE_DISABLED',
  'ACCESS_REVOKED',
  'INVOKE_TIMEOUT',
  'LINK_NOT_OPEN',
  'NOT_CONNECTED',
  'DEVICE_LINK_NOT_CONNECTED',
  'DEVICE_LINK_CONTROL_DISABLED',
  'DEVICE_LINK_STANDBY',
  'DEVICE_UNRESPONSIVE',
]);

interface AwaitingReport {
  clientIds: string[];
  baselineMessageId: string | null;
  startedNotified: boolean;
  missingReplyPolls: number;
}

interface WorkerState {
  ref: RemoteWorkerRef;
  inTurn: boolean;
  awaiting: AwaitingReport | null;
  /** 运行设备上的工作目录(只做展示)；重启后首次轮询时补读。 */
  workingDir: string | null;
}

function errorCode(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = /^\[([A-Z_]+)\]/.exec(message);
  if (match) return match[1] ?? null;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'string'
          ? block
          : block &&
              typeof block === 'object' &&
              typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  if (
    content &&
    typeof content === 'object' &&
    typeof (content as { text?: unknown }).text === 'string'
  ) {
    return (content as { text: string }).text;
  }
  return '';
}

function agentKindOf(value: unknown): AgentInputCreateOpts['agentKind'] {
  return value === 'codex' || value === 'pi' ? value : 'claude-code';
}

interface RemoteSessionRow {
  agentKind?: unknown;
  workingDir?: unknown;
  model?: unknown;
  providerId?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  fastMode?: unknown;
  planModeEnabled?: unknown;
  sdkSessionId?: unknown;
}

/** 远端任务的建会话参数取自运行设备的任务记录；本机不知道它的原生会话 id 等运行态。 */
function createOptsFromRow(row: RemoteSessionRow): AgentInputCreateOpts {
  const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    agentKind: agentKindOf(row.agentKind === 'cc' ? 'claude-code' : row.agentKind),
    workingDir: str(row.workingDir) ?? '',
    model: str(row.model) ?? '',
    ...(str(row.providerId) ? { providerId: str(row.providerId) } : {}),
    ...(str(row.effort) ? { effort: str(row.effort) } : {}),
    ...(typeof row.fastMode === 'boolean' ? { fastMode: row.fastMode } : {}),
    ...(str(row.permissionMode) ? { permissionMode: str(row.permissionMode) } : {}),
    ...(typeof row.planModeEnabled === 'boolean' ? { planMode: row.planModeEnabled } : {}),
    ...(str(row.sdkSessionId) ? { resumeSessionId: str(row.sdkSessionId) } : {}),
  };
}

/** 远端没有 Orca Worker 桥：只带来源标签，不附 worker_id 工具提示。 */
export function buildRemoteWorkerQueuedMessage(params: {
  clientId: string;
  rawContent: string;
  createOpts: AgentInputCreateOpts;
  createdAt: string;
}): AgentInputQueuedMessage {
  const persistedContent = formatOrcaCommunicationMessage('lead', params.rawContent);
  return {
    clientId: params.clientId,
    durableDelivery: true,
    text: formatAgentMessage('lead', params.rawContent),
    persistedContent,
    model: params.createOpts.model,
    effort: params.createOpts.effort ?? '',
    permissionMode: params.createOpts.permissionMode ?? 'auto',
    workingDir: params.createOpts.workingDir,
    chatMessage: {
      clientId: params.clientId,
      role: 'user',
      content: persistedContent,
      createdAt: params.createdAt,
    },
    createOpts: params.createOpts,
    origin: { kind: 'orca', senderLabel: 'Lead', displayText: params.rawContent },
  };
}

export function createOrcaRemoteWorkerRuntime(deps: OrcaRemoteWorkerRuntimeDeps) {
  const workers = new Map<string, WorkerState>();
  const unreachableDevices = new Set<string>();
  let timer: unknown = null;
  let polling = false;
  let stopped = false;

  function deviceUnreachable(err: unknown): boolean {
    const code = errorCode(err);
    return code !== null && UNREACHABLE_CODES.has(code);
  }

  function leadsOnDevice(deviceId: string): string[] {
    return [
      ...new Set(
        [...workers.values()]
          .filter((state) => state.ref.deviceId === deviceId)
          .map((state) => state.ref.leadSessionId),
      ),
    ];
  }

  function setReachable(deviceId: string, reachable: boolean): void {
    const changed = reachable
      ? unreachableDevices.delete(deviceId)
      : !unreachableDevices.has(deviceId);
    if (!reachable) unreachableDevices.add(deviceId);
    if (changed) {
      deps.log.info('orca remote worker device reachability changed', { deviceId, reachable });
      for (const lead of leadsOnDevice(deviceId)) deps.onWorkerStateChanged(lead);
    }
  }

  function schedule(): void {
    if (stopped) return;
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    if (workers.size === 0) return;
    const fast = [...workers.values()].some((state) => state.awaiting !== null);
    timer = deps.setTimeout(
      () => {
        timer = null;
        void pollOnce().finally(schedule);
      },
      fast ? REMOTE_WORKER_FAST_POLL_MS : REMOTE_WORKER_IDLE_POLL_MS,
    );
  }

  async function lastAssistantMessage(ref: RemoteWorkerRef): Promise<{
    id: string | null;
    text: string;
    terminalError: boolean;
  }> {
    const page = (await deps.invoke(ref.deviceId, DL_HISTORY_MESSAGES_CHANNEL, [
      {
        sessionId: ref.remoteSessionId,
        workdir: null,
        fromMs: null,
        toMs: null,
        agentKind: null,
        roles: ['assistant'],
        includeRewound: false,
        limit: 1,
        cursor: null,
        order: 'desc',
        contentCharLimit: MAX_REPORT_CHARS,
      },
    ])) as {
      items?: Array<{ id?: unknown; content?: unknown }>;
      terminal?: { status?: unknown } | null;
    };
    const item = Array.isArray(page?.items) ? page.items[0] : undefined;
    return {
      id: typeof item?.id === 'string' ? item.id : null,
      text: textOf(item?.content).slice(-MAX_REPORT_CHARS),
      terminalError: page?.terminal?.status === 'error',
    };
  }

  async function deliveryStates(ref: RemoteWorkerRef, clientIds: string[]): Promise<string[]> {
    const projection = (await deps.invoke(ref.deviceId, 'maker:input:get-projection', [
      ref.remoteSessionId,
      { deliveryClientIds: clientIds },
    ])) as { deliveryReceipts?: Array<{ clientId?: unknown; state?: unknown }> };
    const receipts = Array.isArray(projection?.deliveryReceipts) ? projection.deliveryReceipts : [];
    return clientIds.map((id) => {
      const receipt = receipts.find((entry) => entry.clientId === id);
      return typeof receipt?.state === 'string' ? receipt.state : 'unknown';
    });
  }

  async function finishTurn(
    state: WorkerState,
    turn: RemoteWorkerTurnEnd,
    messageId: string | null,
  ) {
    state.awaiting = null;
    state.inTurn = false;
    if (messageId) {
      state.ref = { ...state.ref, lastBridgedMessageId: messageId };
      await deps.saveLastBridgedMessageId(state.ref.workerId, messageId).catch((err) =>
        deps.log.warn('orca remote worker: persist bridged message id failed', {
          workerId: state.ref.workerId,
          err: errorMessage(err),
        }),
      );
    }
    await deps.onTurnEnded(state.ref.proxySessionId, turn);
    deps.onWorkerStateChanged(state.ref.leadSessionId);
  }

  async function checkAwaiting(state: WorkerState, running: boolean): Promise<void> {
    const awaiting = state.awaiting;
    if (!awaiting) return;
    if (running) {
      if (!awaiting.startedNotified) {
        awaiting.startedNotified = true;
        await deps.onTurnStarted(state.ref.proxySessionId);
      }
      return;
    }
    const states = await deliveryStates(state.ref, awaiting.clientIds);
    // 仍在运行设备的队列里(排在用户插话之后等)，继续等。
    if (states.some((value) => value === 'pending' || value === 'unknown')) return;
    if (states.every((value) => value === 'removed')) {
      await finishTurn(
        state,
        {
          status: 'error',
          finalText: '',
          diagnostic: `派给 ${deps.deviceName(state.ref.deviceId)} 的消息在那台电脑上被撤回，Worker 没有执行。`,
        },
        null,
      );
      return;
    }
    const last = await lastAssistantMessage(state.ref);
    if (
      last.id &&
      last.id !== awaiting.baselineMessageId &&
      last.id !== state.ref.lastBridgedMessageId
    ) {
      await finishTurn(
        state,
        { status: last.terminalError ? 'error' : 'done', finalText: last.text },
        last.id,
      );
      return;
    }
    awaiting.missingReplyPolls += 1;
    if (last.terminalError || awaiting.missingReplyPolls >= MISSING_REPLY_POLLS) {
      await finishTurn(
        state,
        {
          status: 'error',
          finalText: '',
          diagnostic: last.terminalError
            ? `Worker 在 ${deps.deviceName(state.ref.deviceId)} 上异常结束，没有产生回复。`
            : `Worker 在 ${deps.deviceName(state.ref.deviceId)} 上本轮结束，但没有产生回复。`,
        },
        null,
      );
    }
  }

  async function pollDevice(deviceId: string, states: WorkerState[]): Promise<void> {
    let active: Map<string, boolean>;
    try {
      const result = (await deps.invoke(deviceId, 'maker:list-active', [
        { summary: true, snapshotVersion: 2 },
      ])) as { sessions?: Array<{ sessionId?: unknown; isTurnRunning?: unknown }> };
      active = new Map(
        (Array.isArray(result?.sessions) ? result.sessions : [])
          .filter((entry) => typeof entry.sessionId === 'string')
          .map((entry) => [entry.sessionId as string, entry.isTurnRunning === true]),
      );
      setReachable(deviceId, true);
    } catch (err) {
      if (deviceUnreachable(err)) setReachable(deviceId, false);
      deps.log.warn('orca remote worker: poll failed', { deviceId, err: errorMessage(err) });
      return;
    }
    for (const state of states) {
      if (state.workingDir === null) await readWorkingDir(state);
      const running = active.get(state.ref.remoteSessionId) === true;
      const changed = running !== state.inTurn;
      state.inTurn = running;
      try {
        await checkAwaiting(state, running);
      } catch (err) {
        if (deviceUnreachable(err)) setReachable(deviceId, false);
        deps.log.warn('orca remote worker: report check failed', {
          workerId: state.ref.workerId,
          err: errorMessage(err),
        });
      }
      if (changed) deps.onWorkerStateChanged(state.ref.leadSessionId);
    }
  }

  async function readWorkingDir(state: WorkerState): Promise<void> {
    try {
      const row = (await deps.invoke(state.ref.deviceId, 'local-db:sessions:get', [
        state.ref.remoteSessionId,
      ])) as RemoteSessionRow | null;
      if (typeof row?.workingDir === 'string' && row.workingDir) {
        state.workingDir = row.workingDir;
        deps.onWorkerStateChanged(state.ref.leadSessionId);
      }
    } catch {
      // 只影响展示，下一轮再试。
    }
  }

  async function pollOnce(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const byDevice = new Map<string, WorkerState[]>();
      for (const state of workers.values()) {
        byDevice.set(state.ref.deviceId, [...(byDevice.get(state.ref.deviceId) ?? []), state]);
      }
      await Promise.all([...byDevice].map(([deviceId, states]) => pollDevice(deviceId, states)));
    } finally {
      polling = false;
    }
  }

  return {
    track(ref: RemoteWorkerRef, opts: { workingDir?: string } = {}): void {
      const existing = workers.get(ref.proxySessionId);
      const workingDir = opts.workingDir || existing?.workingDir || null;
      workers.set(
        ref.proxySessionId,
        existing
          ? { ...existing, ref, workingDir }
          : { ref, inTurn: false, awaiting: null, workingDir },
      );
      if (timer === null) schedule();
    },

    untrack(proxySessionId: string): void {
      workers.delete(proxySessionId);
      if (workers.size === 0) schedule();
    },

    isRemote(proxySessionId: string): boolean {
      return workers.has(proxySessionId);
    },

    get(proxySessionId: string): RemoteWorkerRef | null {
      return workers.get(proxySessionId)?.ref ?? null;
    },

    isTurnRunning(proxySessionId: string): boolean {
      return workers.get(proxySessionId)?.inTurn ?? false;
    },

    hasPendingReport(proxySessionId: string): boolean {
      return workers.get(proxySessionId)?.awaiting != null;
    },

    workingDir(proxySessionId: string): string | null {
      return workers.get(proxySessionId)?.workingDir ?? null;
    },

    isReachable(proxySessionId: string): boolean {
      const state = workers.get(proxySessionId);
      return state ? !unreachableDevices.has(state.ref.deviceId) : true;
    },

    async dispatch(params: {
      proxySessionId: string;
      rawContent: string;
      clientId: string;
    }): Promise<RemoteWorkerDispatchResult> {
      const state = workers.get(params.proxySessionId);
      if (!state)
        return { ok: false, code: 'SESSION_NOT_FOUND', message: 'remote worker is not tracked' };
      const { ref } = state;
      const deviceName = deps.deviceName(ref.deviceId);
      try {
        const row = (await deps.invoke(ref.deviceId, 'local-db:sessions:get', [
          ref.remoteSessionId,
        ])) as (RemoteSessionRow & { status?: unknown }) | null;
        if (typeof row?.workingDir === 'string' && row.workingDir) state.workingDir = row.workingDir;
        if (!row || (row.status !== undefined && row.status !== 'active')) {
          return {
            ok: false,
            code: 'SESSION_NOT_FOUND',
            message: `Worker 在 ${deviceName} 上的任务已不存在或已归档，消息没有发出。`,
          };
        }
        const baseline = state.awaiting?.baselineMessageId ?? (await lastAssistantMessage(ref)).id;
        const item = buildRemoteWorkerQueuedMessage({
          clientId: params.clientId,
          rawContent: params.rawContent,
          createOpts: createOptsFromRow(row),
          createdAt: new Date(deps.now()).toISOString(),
        });
        const accept = (): RemoteWorkerDispatchResult => {
          setReachable(ref.deviceId, true);
          const mode = state.inTurn ? 'queued' : 'dispatched';
          state.awaiting = {
            clientIds: [...(state.awaiting?.clientIds ?? []), params.clientId].slice(-64),
            baselineMessageId: baseline,
            startedNotified: state.awaiting?.startedNotified ?? false,
            missingReplyPolls: 0,
          };
          schedule();
          return { ok: true, mode };
        };
        try {
          await deps.invoke(ref.deviceId, 'maker:input:enqueue', [ref.remoteSessionId, item]);
        } catch (err) {
          // 请求可能已送达、只是回执丢了：按 clientId 查一次投递回执，已在队列或对话里就算送达，
          // 不重发(enqueue 按 clientId 幂等，但这里不做盲重试)。查不到再按失败处理。
          if (
            errorCode(err) === 'INVOKE_TIMEOUT' ||
            (err as { inFlight?: unknown })?.inFlight === true
          ) {
            const [delivered] = await deliveryStates(ref, [params.clientId]).catch(() => [
              'unknown',
            ]);
            if (delivered === 'pending' || delivered === 'accepted') return accept();
          }
          throw err;
        }
        return accept();
      } catch (err) {
        if (deviceUnreachable(err)) {
          setReachable(ref.deviceId, false);
          return {
            ok: false,
            code: 'DEVICE_UNREACHABLE',
            message: `${deviceName} 当前不可达（离线或已关闭远程控制），消息没有发出。`,
          };
        }
        if (errorCode(err) === 'NOT_FOUND') {
          return {
            ok: false,
            code: 'SESSION_NOT_FOUND',
            message: `Worker 在 ${deviceName} 上的任务已不存在，消息没有发出。`,
          };
        }
        return { ok: false, code: 'SEND_FAILED', message: errorMessage(err) };
      }
    },

    /** 诊断用：运行设备上这条任务的最后一条回复(读不到返回空串)。 */
    async latestReply(proxySessionId: string): Promise<string> {
      const state = workers.get(proxySessionId);
      if (!state) return '';
      try {
        return (await lastAssistantMessage(state.ref)).text;
      } catch (err) {
        if (deviceUnreachable(err)) setReachable(state.ref.deviceId, false);
        return '';
      }
    },

    /** 停止运行设备上的当前一轮；任务与记录保留。 */
    async abort(proxySessionId: string): Promise<boolean> {
      const state = workers.get(proxySessionId);
      if (!state) return false;
      try {
        await deps.invoke(state.ref.deviceId, 'maker:abort-session', [state.ref.remoteSessionId]);
        return true;
      } catch (err) {
        if (deviceUnreachable(err)) setReachable(state.ref.deviceId, false);
        deps.log.warn('orca remote worker: abort failed', {
          proxySessionId,
          err: errorMessage(err),
        });
        return false;
      }
    },

    /** 通知运行设备结束协同(任务与文件保留)。设备不可达时返回 false，由调用方留待重试。 */
    async release(ref: Pick<RemoteWorkerRef, 'deviceId' | 'remoteSessionId'>): Promise<boolean> {
      try {
        await deps.invoke(ref.deviceId, ORCA_REMOTE_WORKER_RELEASE_CHANNEL, [
          { sessionId: ref.remoteSessionId },
        ]);
        return true;
      } catch (err) {
        if (errorCode(err) === 'NOT_FOUND') return true;
        deps.log.warn('orca remote worker: release failed', {
          deviceId: ref.deviceId,
          err: errorMessage(err),
        });
        return false;
      }
    },

    /** 测试与关闭时用：立即跑一轮。 */
    pollNow: pollOnce,

    /** 账号切换后重建：清空登记与可达性，恢复调度(随后由调用方重新 track)。 */
    reset(): void {
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
      workers.clear();
      unreachableDevices.clear();
      stopped = false;
    },

    stop(): void {
      stopped = true;
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    },
  };
}

export type OrcaRemoteWorkerRuntime = ReturnType<typeof createOrcaRemoteWorkerRuntime>;
