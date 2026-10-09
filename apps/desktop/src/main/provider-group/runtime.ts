/**
 * 供应商组的运行期单例：组内电脑目录与分配器。设置页(IPC)与任务生命周期(register)共用同一份，
 * 这样设置页看到的「正在运行 / 冷却中」与实际分配一致。
 */
import { getReceivedShares } from '../device-link/providerShareGuest.js';
import { handleListDevices, defaultDeps as deviceDirectoryDeps } from '../device-link/ipc.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { isMobilePlatform } from '../device-link/controllerPlatform.js';
import { deviceName } from '../device-link/deviceName.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog.js';
import { listProviderGroupBindings } from './bindings.js';
import { createProviderGroupDirectory, type ProviderGroupDirectory } from './directory.js';
import { createProviderGroupRouter, type ProviderGroupRouter } from './router.js';
import { readProviderGroup } from './store.js';

let directory: ProviderGroupDirectory | null = null;
let router: ProviderGroupRouter | null = null;
let isTurnRunning: (sessionId: string) => boolean = () => false;

export function getProviderGroupDirectory(): ProviderGroupDirectory {
  directory ??= createProviderGroupDirectory({
    listLocalProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: false }),
    localDeviceName: () => deviceName(),
    listDevices: async () => (await handleListDevices(deviceDirectoryDeps())).devices,
    readDeviceProviders: (agentDeviceId) => readDeviceProviderViews(remoteBackgroundInvoke, agentDeviceId),
    listReceivedShares: () => getReceivedShares(),
    isMobilePlatform: (platform) => isMobilePlatform(platform),
    now: () => Date.now(),
  });
  return directory;
}

export function getProviderGroupRouter(): ProviderGroupRouter {
  router ??= createProviderGroupRouter({
    directory: getProviderGroupDirectory(),
    readGroup: readProviderGroup,
    listBindings: listProviderGroupBindings,
    isTurnRunning: (sessionId) => isTurnRunning(sessionId),
    now: () => Date.now(),
    random: () => Math.random(),
  });
  return router;
}

/** register 装配会话表后注入：分配器据此统计「正在运行」。 */
export function setProviderGroupTurnProbe(probe: (sessionId: string) => boolean): void {
  isTurnRunning = probe;
}
