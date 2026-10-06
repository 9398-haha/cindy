/**
 * 设备托管会话(StartSessionOptions.deviceHosted)的共用部分：Agent 在本机运行，任务、项目
 * 文件与命令在同账号另一台电脑上，工具经本机 loopback 隧道回到那台电脑执行。
 */
import type { DeviceHostedSession, PiExtraSpawnConfig } from '../base-agent.js';

/** 交给 Pi 内 cindy-bridge 的托管配置(隧道地址、令牌、真实工作目录)。 */
export const DEVICE_HOSTED_PI_ENV = 'CINDY_PI_HOSTED';

export function deviceHostedPiEnvValue(hosted: DeviceHostedSession): string {
  return JSON.stringify({
    url: hosted.tunnelUrl,
    token: hosted.tunnelToken,
    cwd: hosted.workingDir,
    platform: hosted.platform,
    shell: hosted.shell,
    ...(hosted.mirrorRoot ? { mirrorRoot: hosted.mirrorRoot } : {}),
  });
}

/** 隧道上某个 MCP 服务的地址。 */
export function deviceHostedMcpUrl(hosted: DeviceHostedSession, name: string): string {
  return `${hosted.tunnelUrl.replace(/\/+$/, '')}/mcp/${encodeURIComponent(name)}`;
}

/** Pi 的 MCP 桥配置：全部指向隧道，令牌是本任务的隧道令牌。 */
export function deviceHostedPiMcpBridge(hosted: DeviceHostedSession): NonNullable<PiExtraSpawnConfig['mcpBridge']> {
  return {
    token: hosted.tunnelToken,
    servers: hosted.mcpServers.map((name) => ({ name, url: deviceHostedMcpUrl(hosted, name) })),
  };
}

/** 设备托管时顶替 Claude Code 自带文件与命令工具的 Cindy MCP 服务名。 */
export const DEVICE_HOSTED_EXEC_MCP_SERVER = 'cindy_exec';
/** 顶替的工具名(与自带工具同名)。 */
export const DEVICE_HOSTED_EXEC_TOOL_NAMES = ['Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit'] as const;
/** 设备托管时关掉的 Claude Code 自带工具：它们只能操作本机，项目不在这里。 */
export const DEVICE_HOSTED_DISALLOWED_CLAUDE_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Glob', 'Grep', 'LS', 'PowerShell', 'EnterWorktree', 'ExitWorktree',
] as const;

const EXEC_PREFIX = `mcp__${DEVICE_HOSTED_EXEC_MCP_SERVER}__`;

/** `mcp__cindy_exec__Bash` → `Bash`；不是顶替工具时返回 null。 */
export function deviceHostedBuiltinToolName(toolName: string): string | null {
  if (!toolName.startsWith(EXEC_PREFIX)) return null;
  const name = toolName.slice(EXEC_PREFIX.length);
  return (DEVICE_HOSTED_EXEC_TOOL_NAMES as readonly string[]).includes(name) ? name : null;
}

/** `Bash` → `mcp__cindy_exec__Bash`。 */
export function deviceHostedExecToolName(builtin: string): string {
  return `${EXEC_PREFIX}${builtin}`;
}

/**
 * 给模型的环境说明：项目在哪台电脑、哪个目录，工具在哪执行。只陈述事实，让模型使用真实路径。
 */
export function deviceHostedEnvironmentNote(hosted: DeviceHostedSession, localWorkingDir: string): string {
  const lines = [
    '# Where this task runs',
    `The project lives on the user's computer at \`${hosted.workingDir}\` (${hosted.platform}, shell: ${hosted.shell}${hosted.osVersion ? `, ${hosted.osVersion}` : ''}).`,
    `Every file and shell tool operates on that computer. Use paths under \`${hosted.workingDir}\`; relative paths resolve against it.`,
    `The local working directory \`${localWorkingDir}\` only holds a copy of the project instructions; do not use it.`,
  ];
  if (hosted.extraDirs.length || hosted.writableDirs.length) {
    lines.push(`Additional directories on that computer: ${[...new Set([...hosted.extraDirs, ...hosted.writableDirs])].map((dir) => `\`${dir}\``).join(', ')}.`);
  }
  lines.push(`Is a git repository: ${hosted.isGitRepo ? 'yes' : 'no'}.`);
  if (hosted.personalInstructions?.trim()) {
    lines.push('', "# The user's personal instructions (from their computer)", hosted.personalInstructions.trim());
  }
  return lines.join('\n');
}

/** Claude Code 版：说明文件与命令工具由 Cindy 工具顶替。 */
export function deviceHostedClaudeNote(hosted: DeviceHostedSession, localWorkingDir: string): string {
  const tools = DEVICE_HOSTED_EXEC_TOOL_NAMES.map((name) => deviceHostedExecToolName(name)).join(', ');
  return [
    deviceHostedEnvironmentNote(hosted, localWorkingDir),
    `File and shell tools are provided as ${tools}. Use them wherever these instructions mention Bash, Read, Write, Edit or NotebookEdit; search files with Bash (rg, find).`,
  ].join('\n');
}

/**
 * 子代理的工具限制(设备托管)。本机任务里 Claude Code 按子代理定义收窄自带工具；顶替成 Cindy
 * 工具后 SDK 不再按名字收窄(MCP 工具一律放行)，这里按同样的定义判一次：
 *  - 自带的只读子代理(Explore / Plan)不能写文件；
 *  - 自定义子代理写了 tools 时只能用列出的工具，写了 disallowedTools 时不能用列出的工具。
 * 不认识的子代理不额外限制(与本机一致：没有定义就继承全部工具)。
 */
export interface DeviceHostedAgentToolRule {
  tools?: string[];
  disallowedTools?: string[];
}

const READ_ONLY_BUILTIN_AGENTS: Record<string, DeviceHostedAgentToolRule> = {
  Explore: { disallowedTools: ['Write', 'Edit', 'NotebookEdit'] },
  Plan: { disallowedTools: ['Write', 'Edit', 'NotebookEdit'] },
};

/** 子代理定义文件(Markdown + frontmatter)里的名字与工具规则；没有 frontmatter 时返回 null。 */
export function parseClaudeAgentToolRule(markdown: string): { name: string; rule: DeviceHostedAgentToolRule } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].trim());
  }
  const name = fields.get('name')?.replace(/^["']|["']$/g, '');
  if (!name) return null;
  const list = (value: string | undefined) => value
    ?.replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  const tools = list(fields.get('tools'));
  const disallowedTools = list(fields.get('disallowedTools') ?? fields.get('disallowed-tools'));
  return {
    name,
    rule: {
      ...(tools && tools.length ? { tools } : {}),
      ...(disallowedTools && disallowedTools.length ? { disallowedTools } : {}),
    },
  };
}

/** 子代理能否用某个顶替工具(自带工具名)。BashOutput / KillShell 跟随 Bash。 */
export function deviceHostedSubagentAllows(
  agentType: string,
  builtin: string,
  customRules: ReadonlyMap<string, DeviceHostedAgentToolRule>,
): boolean {
  const rule = customRules.get(agentType) ?? READ_ONLY_BUILTIN_AGENTS[agentType];
  if (!rule) return true;
  const name = builtin === 'BashOutput' || builtin === 'KillShell' ? 'Bash' : builtin;
  const matches = (entry: string) => entry === name || entry === builtin || entry === deviceHostedExecToolName(builtin)
    || entry.startsWith(`${name}(`);
  if (rule.disallowedTools?.some(matches)) return false;
  if (rule.tools && !rule.tools.some((entry) => entry === '*' || matches(entry))) return false;
  return true;
}
