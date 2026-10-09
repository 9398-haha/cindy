/**
 * 供应商组设置的 IPC：只接受本机应用窗口，不经设备互联代理(组是这台电脑上的设置)。
 */
import { ipcMain } from 'electron';

import {
  PROVIDER_GROUP_IPC,
  isProviderGroupProviderId,
  normalizeProviderGroupConfig,
  type ProviderGroupCommand,
  type ProviderGroupConfig,
} from '../../shared/providerGroup.js';
import { broadcast } from '../device-link/index.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { ProviderGroupDirectory } from './directory.js';
import type { ProviderGroupRouter } from './router.js';
import { getProviderGroupDirectory, getProviderGroupRouter } from './runtime.js';
import { readProviderGroup, writeProviderGroup } from './store.js';

const log = createLogger('provider-group');

export interface ProviderGroupCommandDeps {
  router: ProviderGroupRouter;
  directory: ProviderGroupDirectory;
  readGroup(providerId: string): ProviderGroupConfig | null;
  writeGroup(providerId: string, config: unknown): Promise<ProviderGroupConfig | null>;
  changed(providerId: string): void;
}

export function parseProviderGroupCommand(raw: unknown): ProviderGroupCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'command required');
  const value = raw as Record<string, unknown>;
  if (!isProviderGroupProviderId(value.providerId)) throwIpcError('INVALID_PARAMS', 'providerId required');
  const providerId = value.providerId as string;
  switch (value.action) {
    case 'get':
    case 'candidates':
    case 'delete':
      return { action: value.action, providerId };
    case 'save': {
      if (!value.config || typeof value.config !== 'object') throwIpcError('INVALID_PARAMS', 'config required');
      return { action: 'save', providerId, config: value.config as ProviderGroupConfig };
    }
    default:
      throwIpcError('INVALID_PARAMS', 'unknown provider group action');
  }
}

/** 业务体(依赖注入，单测直接调)。 */
export async function executeProviderGroupCommand(deps: ProviderGroupCommandDeps, command: ProviderGroupCommand) {
  const { providerId } = command;
  switch (command.action) {
    case 'get':
      return deps.router.view(providerId);
    case 'candidates':
      return deps.directory.listCandidates(providerId, deps.readGroup(providerId));
    case 'delete':
      await deps.writeGroup(providerId, null);
      deps.changed(providerId);
      return deps.router.view(providerId);
    case 'save': {
      const next = normalizeProviderGroupConfig(command.config, providerId);
      if (next) {
        // 新加入的电脑必须是这台电脑已经能用的同一个供应商(§3)，不能凭渲染端点名加入。
        const previous = new Set(deps.readGroup(providerId)?.members.map((m) => m.key) ?? []);
        const added = next.members.filter((m) => m.kind !== 'local' && !previous.has(m.key));
        if (added.length > 0) {
          const candidates = await deps.directory.listCandidates(providerId, deps.readGroup(providerId));
          const allowed = new Set(candidates.filter((c) => !c.blocked).map((c) => c.key));
          const rejected = added.filter((m) => !allowed.has(m.key));
          if (rejected.length > 0) {
            throwIpcError('PRECONDITION_FAILED', 'Only the same provider that this computer can already use can join the group');
          }
          // 显示名以目录为准，渲染端给的只是快照。
          const labels = new Map(candidates.map((c) => [c.key, c.label]));
          for (const member of next.members) {
            const label = labels.get(member.key);
            if (label) member.label = label;
          }
        }
      }
      await deps.writeGroup(providerId, next);
      deps.changed(providerId);
      return deps.router.view(providerId);
    }
  }
}

export function registerProviderGroupIpc(): void {
  const deps: ProviderGroupCommandDeps = {
    router: getProviderGroupRouter(),
    directory: getProviderGroupDirectory(),
    readGroup: readProviderGroup,
    writeGroup: writeProviderGroup,
    changed: (providerId) => {
      try {
        broadcast(PROVIDER_GROUP_IPC.CHANGED, { providerId });
      } catch (error) {
        log.warn('provider group broadcast failed', { error: String(error) });
      }
    },
  };
  ipcMain.handle(PROVIDER_GROUP_IPC.COMMAND, async (event, raw: unknown) => {
    if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'Provider groups are local only');
    assertTrustedAppRendererEvent(event);
    return executeProviderGroupCommand(deps, parseProviderGroupCommand(raw));
  });
}
