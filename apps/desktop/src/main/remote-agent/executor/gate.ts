/**
 * 远程 Agent 执行器的权限上限(控制端)。
 *
 * 分工：Agent 所在电脑上的 Cindy 用与本机任务完全相同的权限逻辑决定「问不问」(权限档、
 * 自动审查、会话内允许规则)，需要问的都弹到本机界面上让用户点。执行器在本机这一侧再守一道
 * 上限，保证另一台电脑无论如何不能越过本机用户：
 *  - 全权：一律放行(用户在本机为这个任务选了全权)；
 *  - 凭证类路径、静态可证的高危命令：本机任务这类操作总是逐次问用户，执行器只认本机用户
 *    刚批准过的同一操作；
 *  - 计划模式：只允许读取和静态可证只读的命令，其余同样要本机用户批准过。
 * 批准记录只在短时间内有效；命令批准用一次即失效，路径批准在有效期内覆盖同一路径的读写
 * (编辑会先读后写)。
 */
import path from 'node:path';

import { classifyShellCommand } from '@cindy/maker-core';

import type { ExecutorWorkspace } from './workspace';

/**
 * 与本机任务权限对应的上限档位：`full` = 全权；`plan` = 计划模式；其余权限档统一为 `normal`
 * (问不问由 Agent 侧的权限逻辑决定，这里只守高危上限)。
 */
export type ExecutorGateMode = 'full' | 'plan' | 'normal';

export type ExecutorAction =
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string }
  | { kind: 'exec'; command: string; cwd: string };

export interface ExecutorGateDecision {
  ok: boolean;
  /** 拒绝时给 Agent 看的原因。 */
  reason?: string;
}

/** 批准记录的有效期：覆盖「确认后到真正执行」之间的间隔，过期须重新确认。 */
export const EXECUTOR_APPROVAL_TTL_MS = 2 * 60_000;
const MAX_APPROVALS = 256;

interface Approval {
  kind: 'path' | 'exec';
  key: string;
  expiresAt: number;
}

export function executorGateModeFor(
  permissionMode: string | null | undefined,
  planMode = false,
): ExecutorGateMode {
  if (planMode || permissionMode === 'plan') return 'plan';
  return permissionMode === 'bypassPermissions' ? 'full' : 'normal';
}

function pathKey(target: string): string {
  return path.resolve(target);
}

export class ExecutorGate {
  private mode: ExecutorGateMode;
  private approvals: Approval[] = [];

  constructor(
    private readonly workspace: ExecutorWorkspace,
    mode: ExecutorGateMode = 'normal',
    private readonly now: () => number = Date.now,
  ) {
    this.mode = mode;
  }

  setMode(mode: ExecutorGateMode): void {
    this.mode = mode;
  }

  getMode(): ExecutorGateMode {
    return this.mode;
  }

  /** 本机用户在确认卡上允许了一个操作后调用。 */
  recordApproval(action: ExecutorAction): void {
    this.prune();
    this.approvals.push(action.kind === 'exec'
      ? { kind: 'exec', key: action.command, expiresAt: this.now() + EXECUTOR_APPROVAL_TTL_MS }
      : { kind: 'path', key: pathKey(action.path), expiresAt: this.now() + EXECUTOR_APPROVAL_TTL_MS });
    if (this.approvals.length > MAX_APPROVALS) this.approvals.splice(0, this.approvals.length - MAX_APPROVALS);
  }

  authorize(action: ExecutorAction): ExecutorGateDecision {
    if (this.mode === 'full') return { ok: true };
    if (!this.requiresApproval(action)) return { ok: true };
    if (this.consume(action)) return { ok: true };
    return {
      ok: false,
      reason: action.kind === 'exec'
        ? 'This command needs the user\'s confirmation on the computer where the task runs, and it was not confirmed.'
        : `Access to ${action.path} needs the user's confirmation on the computer where the task runs, and it was not confirmed.`,
    };
  }

  private requiresApproval(action: ExecutorAction): boolean {
    if (action.kind === 'exec') {
      const verdict = classifyShellCommand(action.command, this.workspace.allRoots(), {
        cwd: action.cwd,
        platform: process.platform,
      });
      if (verdict === 'prompt-each-time') return true;
      return this.mode === 'plan' && verdict !== 'auto-approve';
    }
    if (this.workspace.isSensitive(action.path)) return true;
    return action.kind === 'write' && this.mode === 'plan';
  }

  private consume(action: ExecutorAction): boolean {
    this.prune();
    const kind = action.kind === 'exec' ? 'exec' : 'path';
    const key = action.kind === 'exec' ? action.command : pathKey(action.path);
    const index = this.approvals.findIndex((approval) => approval.kind === kind && approval.key === key);
    if (index < 0) return false;
    if (kind === 'exec') this.approvals.splice(index, 1);
    return true;
  }

  private prune(): void {
    const t = this.now();
    this.approvals = this.approvals.filter((approval) => approval.expiresAt > t);
  }
}
