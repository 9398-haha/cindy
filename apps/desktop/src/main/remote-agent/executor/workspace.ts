/**
 * 远程 Agent 执行器的工作区(控制端)。
 *
 * Agent 跑在另一台电脑上，它对本机文件和命令的每个请求都在这里落地。路径一律按本机路径
 * 解析：相对路径以任务工作目录为基准。Agent 所在电脑上的影子目录(只放项目说明类小文件，
 * 让 Agent 照常加载项目说明与 Skill)在这里映射回本机真实目录，模型即使用了影子路径也落在
 * 本机项目里。
 */
import fs from 'node:fs';
import path from 'node:path';

import { isSensitiveCredentialPath } from '@cindy/maker-core';

export interface ExecutorPathAlias {
  /** Agent 所在电脑上的影子目录(绝对路径，按该电脑的路径写法)。 */
  from: string;
  /** 对应的本机真实目录。 */
  to: string;
}

export interface ExecutorWorkspaceRoots {
  /** 任务工作目录(本机绝对路径)。 */
  workingDir: string;
  /** 额外允许的目录(任务的附加目录)。 */
  extraDirs?: readonly string[];
  /** 影子目录映射。 */
  aliases?: readonly ExecutorPathAlias[];
}

export class ExecutorPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorPathError';
  }
}

/** 取一个路径的真实路径；不存在时按最近的已存在祖先解析，再拼回剩余部分。 */
export function realPathOrAncestor(target: string): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 影子目录前缀匹配：只认完整路径段(`/a/b` 不匹配 `/a/bc`)，不区分分隔符写法。 */
function stripAliasPrefix(input: string, from: string): string | null {
  const normalizedInput = input.replace(/\\/g, '/');
  const normalizedFrom = from.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedFrom) return null;
  if (normalizedInput === normalizedFrom) return '';
  if (normalizedInput.startsWith(`${normalizedFrom}/`)) return normalizedInput.slice(normalizedFrom.length + 1);
  return null;
}

export class ExecutorWorkspace {
  readonly workingDir: string;
  private roots: string[];
  private extraDirs: string[];
  private aliases: ExecutorPathAlias[];

  constructor(roots: ExecutorWorkspaceRoots) {
    if (!path.isAbsolute(roots.workingDir)) throw new ExecutorPathError('working directory must be absolute');
    this.workingDir = path.resolve(roots.workingDir);
    this.extraDirs = [];
    this.roots = [];
    this.aliases = [];
    this.setAliases(roots.aliases ?? []);
    this.setExtraDirs(roots.extraDirs ?? []);
  }

  /** Agent 启动后才知道它那边的影子目录，届时设置。 */
  setAliases(aliases: readonly ExecutorPathAlias[]): void {
    this.aliases = aliases.filter((alias) => alias.from && path.isAbsolute(alias.to));
  }

  /** 任务运行中附加目录变化时更新。 */
  setExtraDirs(extraDirs: readonly string[]): void {
    this.extraDirs = extraDirs.filter((dir) => path.isAbsolute(dir)).map((dir) => path.resolve(dir));
    this.roots = [this.workingDir, ...this.extraDirs].map((dir) => realPathOrAncestor(dir));
  }

  /** 工作目录与附加目录(本机路径，未解析符号链接)。 */
  allRoots(): string[] {
    return [this.workingDir, ...this.extraDirs];
  }

  /** 影子路径映射回本机路径；不是影子路径时原样返回。 */
  mapAlias(input: string): string {
    for (const alias of this.aliases) {
      const rest = stripAliasPrefix(input, alias.from);
      if (rest !== null) return rest ? path.join(alias.to, ...rest.split('/')) : alias.to;
    }
    return input;
  }

  /** 命令文本里出现的影子目录前缀替换成本机目录(按完整路径段)。 */
  mapCommand(command: string): string {
    let next = command;
    for (const alias of this.aliases) {
      const from = alias.from.replace(/\/+$/, '');
      if (!from) continue;
      // 只在后面是路径边界时替换，避免误伤更长的同前缀路径。
      const pattern = new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/\\s'"\`;:|&)<>])`, 'g');
      next = next.replace(pattern, () => alias.to);
    }
    return next;
  }

  /** 把 Agent 给的路径解析成本机绝对路径(相对路径以 baseDir / 工作目录为基准)。 */
  resolve(input: string, baseDir = this.workingDir): string {
    if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
      throw new ExecutorPathError('path is empty or invalid');
    }
    const trimmed = input.startsWith('@') ? input.slice(1) : input;
    const expanded = trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(process.env.HOME ?? '', trimmed.slice(1))
      : trimmed;
    return path.resolve(this.mapAlias(baseDir), this.mapAlias(expanded));
  }

  /** 真实路径是否落在工作目录或附加目录内(防符号链接与 `..` 借道)。 */
  contains(absolutePath: string): boolean {
    const real = realPathOrAncestor(absolutePath);
    return this.roots.some((root) => isInside(real, root));
  }

  /**
   * 凭证类路径(与本机 harness 权限适配器同一份规则)。本机任务对这类路径是「每次都问」，
   * 执行器同样要求本机确认过才放行。
   */
  isSensitive(absolutePath: string): boolean {
    return isSensitiveCredentialPath(absolutePath) || isSensitiveCredentialPath(realPathOrAncestor(absolutePath));
  }
}
