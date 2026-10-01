import type { SessionStatusInfo } from '@/lib/makerChatStore';
import { getWorkerProjectionSnapshot } from '../hooks/workerProjectionStore';

/**
 * Whether an Orca Lead still has Workers on its task.
 *
 * A Lead turn that only dispatched work is not the team's completion: the Lead
 * runs again when the Worker reports arrive, and that turn's done is the one to
 * announce. Mirrors Main's Agent Island deferral and the sidebar's running roll-up.
 */
export function hasActiveOrcaWorker(
  leadSessionId: string,
  statusMap: ReadonlyMap<string, SessionStatusInfo>,
): boolean {
  return getWorkerProjectionSnapshot(leadSessionId).workers.some(
    (worker) => worker.status === 'running' || statusMap.get(worker.sessionId)?.isRunning === true,
  );
}
