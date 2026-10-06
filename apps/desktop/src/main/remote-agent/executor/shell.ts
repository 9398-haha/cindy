/**
 * 远程 Agent 执行器的命令执行(控制端)。
 *
 * 命令在本机执行，进程组可整体结束；输出合并 stdout/stderr(与终端里看到的顺序一致)。
 *  - `runOnce`：一次性执行，给 Pi 的 bash 用(Pi 自己负责截断与超时提示)；
 *  - `ShellSession`：给 Claude Code 风格的 Bash 用，跨调用保留当前目录(环境变量不保留，
 *    与 Claude Code 一致)，默认 2 分钟、最长 10 分钟超时，输出超过 30000 字符时保留首尾；
 *    支持后台命令，输出写到本机临时文件，可查看增量输出、可结束。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CC_BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const CC_BASH_MAX_TIMEOUT_MS = 600_000;
export const CC_BASH_MAX_OUTPUT_CHARS = 30_000;
/** 一次性执行的输出上限(超出部分丢弃头部，保留最新输出)。 */
const RUN_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const MAX_BACKGROUND_JOBS = 32;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PATH 上的可执行文件(Windows)。 */
function findOnWindowsPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    if (!dir) continue;
    const candidate = path.win32.join(dir.replace(/^"|"$/g, ''), name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Windows 上的 Git Bash(Agent 的命令都是 bash 写法；与 Claude Code 在 Windows 上的要求一致)：
 * CLAUDE_CODE_GIT_BASH_PATH → PATH 上 git.exe 旁的 bin\bash.exe → 常见安装位置。找不到返回 null。
 */
export function findWindowsGitBash(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const git = findOnWindowsPath('git.exe', env);
  if (git) {
    const gitDir = path.win32.dirname(git);
    for (const candidate of [
      path.win32.join(path.win32.dirname(gitDir), 'bin', 'bash.exe'),
      path.win32.join(gitDir, 'bash.exe'),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')]
    .filter((root): root is string => !!root);
  for (const root of roots) {
    const candidate = path.win32.join(root, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 本机用于执行命令的 shell。 */
export function resolveExecutorShell(): { file: string; args: (script: string) => string[] } {
  if (process.platform === 'win32') {
    const gitBash = findWindowsGitBash();
    if (gitBash) return { file: gitBash, args: (script) => ['-c', script] };
    return { file: process.env.ComSpec || 'cmd.exe', args: (script) => ['/d', '/s', '/c', script] };
  }
  const preferred = process.env.SHELL;
  const file = preferred && /\/(zsh|bash)$/.test(preferred) && fs.existsSync(preferred)
    ? preferred
    : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file, args: (script) => ['-c', script] };
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 进程已退出。
    }
  }
}

function terminate(child: ChildProcess): void {
  killTree(child, 'SIGTERM');
  const timer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
  timer.unref?.();
  child.once('exit', () => clearTimeout(timer));
}

export interface RunResult {
  output: Buffer;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

/** 有上限的输出缓冲：超过上限时丢弃最早的内容。 */
class OutputBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  dropped = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 1) {
      const first = this.chunks.shift()!;
      this.size -= first.length;
      this.dropped += first.length;
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onData?: (chunk: Buffer) => void;
}

/** 执行一条 shell 命令直到结束；超时 / 取消时结束整个进程组。 */
export function runOnce(script: string, opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ output: Buffer.alloc(0), exitCode: null, timedOut: false, aborted: true });
      return;
    }
    const shell = resolveExecutorShell();
    let child: ChildProcess;
    try {
      child = spawn(shell.file, shell.args(script), {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    const buffer = new OutputBuffer(RUN_MAX_OUTPUT_BYTES);
    let timedOut = false;
    let aborted = false;
    const onChunk = (chunk: Buffer) => {
      buffer.push(chunk);
      opts.onData?.(chunk);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          terminate(child);
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      terminate(child);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ output: buffer.toBuffer(), exitCode: code, timedOut, aborted });
    });
  });
}

/** 超过上限时保留首尾，中间注明省略了多少行。 */
export function truncateOutput(text: string, max = CC_BASH_MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  const omitted = text.slice(half, text.length - half);
  const omittedLines = omitted.split('\n').length - 1;
  return `${head}\n\n... [${omittedLines} lines truncated] ...\n\n${tail}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

export interface ShellCommandResult {
  text: string;
  isError: boolean;
}

interface BackgroundJob {
  id: string;
  command: string;
  outputPath: string;
  child: ChildProcess;
  exitCode: number | null;
  done: boolean;
  killed: boolean;
  readOffset: number;
}

export interface ShellSessionOptions {
  workingDir: string;
  /** 当前目录离开这些目录时重置回工作目录(与 Claude Code 一致)。 */
  isAllowedCwd: (cwd: string) => boolean;
  /** 后台命令输出文件所在目录(本机)。 */
  tempDir?: string;
}

export class ShellSession {
  private cwd: string;
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly tempDir: string;
  private closed = false;

  constructor(private readonly opts: ShellSessionOptions) {
    this.cwd = opts.workingDir;
    this.tempDir = opts.tempDir ?? path.join(os.tmpdir(), 'cindy-remote-agent');
  }

  getCwd(): string {
    return this.cwd;
  }

  /** 执行一条命令；命令结束后记下它所在的目录，下一条命令从那里开始。 */
  async run(command: string, timeoutMs: number | undefined, signal?: AbortSignal): Promise<ShellCommandResult> {
    if (this.closed) return { text: 'The shell session has ended.', isError: true };
    const timeout = Math.min(Math.max(1, Math.floor(timeoutMs ?? CC_BASH_DEFAULT_TIMEOUT_MS)), CC_BASH_MAX_TIMEOUT_MS);
    await fsp.mkdir(this.tempDir, { recursive: true });
    const cwdFile = path.join(this.tempDir, `cwd-${randomUUID()}`);
    const startCwd = await this.validCwd();
    const script = process.platform === 'win32' && !/bash\.exe$/i.test(resolveExecutorShell().file)
      ? command
      : `cd -- ${shellQuote(startCwd)} && eval ${shellQuote(command)} < /dev/null; __cindy_status=$?; pwd -P >| ${shellQuote(cwdFile)}; exit $__cindy_status`;
    const started = Date.now();
    let result: RunResult;
    try {
      result = await runOnce(script, { cwd: startCwd, timeoutMs: timeout, signal });
    } catch (error) {
      await fsp.rm(cwdFile, { force: true });
      return { text: `Failed to run command: ${(error as Error).message}`, isError: true };
    }
    let resetNote = '';
    try {
      const next = (await fsp.readFile(cwdFile, 'utf8')).trim();
      if (next) {
        if (this.opts.isAllowedCwd(next)) this.cwd = next;
        else {
          this.cwd = this.opts.workingDir;
          resetNote = `\nShell cwd was reset to ${this.opts.workingDir}`;
        }
      }
    } catch {
      // 命令中途退出(exit / 超时 / 取消)时没有写出目录，保持原目录。
    } finally {
      await fsp.rm(cwdFile, { force: true });
    }
    const output = truncateOutput(result.output.toString('utf8').replace(/\s+$/, ''));
    if (result.aborted) {
      return { text: `${output}\n[Command was interrupted]`.trim(), isError: true };
    }
    if (result.timedOut) {
      return { text: `${output}\nCommand timed out after ${formatDuration(Date.now() - started)}`.trim(), isError: true };
    }
    if (result.exitCode !== 0) {
      return { text: `${output}${resetNote}\nExit code ${String(result.exitCode)}`.trim(), isError: true };
    }
    return { text: `${output}${resetNote}`.trim() || '(No output)', isError: false };
  }

  /** 后台执行：立即返回编号与输出文件位置。 */
  async startBackground(command: string): Promise<ShellCommandResult> {
    if (this.closed) return { text: 'The shell session has ended.', isError: true };
    this.pruneJobs();
    if ([...this.jobs.values()].filter((job) => !job.done).length >= MAX_BACKGROUND_JOBS) {
      return { text: `Too many background commands are running (limit ${MAX_BACKGROUND_JOBS}). Stop one with KillShell first.`, isError: true };
    }
    await fsp.mkdir(this.tempDir, { recursive: true });
    const id = `bash_${randomUUID().slice(0, 8)}`;
    const outputPath = path.join(this.tempDir, `${id}.output`);
    const out = fs.openSync(outputPath, 'w');
    const startCwd = await this.validCwd();
    const shell = resolveExecutorShell();
    let child: ChildProcess;
    try {
      child = spawn(shell.file, shell.args(`cd -- ${shellQuote(startCwd)} && eval ${shellQuote(command)} < /dev/null`), {
        cwd: startCwd,
        env: process.env,
        stdio: ['ignore', out, out],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      fs.closeSync(out);
      return { text: `Failed to start command: ${(error as Error).message}`, isError: true };
    }
    fs.closeSync(out);
    const job: BackgroundJob = { id, command, outputPath, child, exitCode: null, done: false, killed: false, readOffset: 0 };
    child.once('exit', (code) => {
      job.exitCode = code;
      job.done = true;
    });
    child.once('error', () => {
      job.done = true;
    });
    this.jobs.set(id, job);
    return {
      text: `Command running in background with ID: ${id}. Output is being written to: ${outputPath}. Use BashOutput with this ID to read new output, and KillShell to stop it.`,
      isError: false,
    };
  }

  /** 读取后台命令自上次读取以来的新输出。 */
  async readBackground(id: string, filter?: string): Promise<ShellCommandResult> {
    const job = this.jobs.get(id);
    if (!job) return { text: `No background command found with ID: ${id}`, isError: true };
    let text = '';
    try {
      const handle = await fsp.open(job.outputPath, 'r');
      try {
        const stat = await handle.stat();
        const length = Math.max(0, stat.size - job.readOffset);
        if (length > 0) {
          const buffer = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, job.readOffset);
          job.readOffset += bytesRead;
          text = buffer.subarray(0, bytesRead).toString('utf8');
        }
      } finally {
        await handle.close();
      }
    } catch {
      text = '';
    }
    if (filter) {
      try {
        const pattern = new RegExp(filter);
        text = text.split('\n').filter((line) => pattern.test(line)).join('\n');
      } catch {
        return { text: `Invalid filter regular expression: ${filter}`, isError: true };
      }
    }
    const status = job.killed ? 'killed' : job.done ? 'completed' : 'running';
    const lines = [
      `<status>${status}</status>`,
      ...(job.done && job.exitCode !== null ? [`<exit_code>${job.exitCode}</exit_code>`] : []),
      text ? `<output>\n${truncateOutput(text.replace(/\s+$/, ''))}\n</output>` : '<output>(No new output)</output>',
    ];
    return { text: lines.join('\n'), isError: false };
  }

  killBackground(id: string): ShellCommandResult {
    const job = this.jobs.get(id);
    if (!job) return { text: `No background command found with ID: ${id}`, isError: true };
    if (job.done) return { text: `Background command ${id} has already finished.`, isError: false };
    job.killed = true;
    terminate(job.child);
    return { text: `Successfully killed background command ${id} (${job.command})`, isError: false };
  }

  /** 任务结束：结束所有后台命令并清理输出文件。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs.values()) {
      if (!job.done) terminate(job.child);
      await fsp.rm(job.outputPath, { force: true });
    }
    this.jobs.clear();
  }

  private pruneJobs(): void {
    if (this.jobs.size < MAX_BACKGROUND_JOBS * 2) return;
    for (const [id, job] of this.jobs) {
      if (job.done) {
        void fsp.rm(job.outputPath, { force: true });
        this.jobs.delete(id);
      }
    }
  }

  private async validCwd(): Promise<string> {
    try {
      const stat = await fsp.stat(this.cwd);
      if (stat.isDirectory()) return this.cwd;
    } catch {
      // 目录被删时退回工作目录。
    }
    this.cwd = this.opts.workingDir;
    return this.cwd;
  }
}
