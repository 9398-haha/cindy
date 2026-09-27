import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideDir } from '../cindy-brain/dirDeposit.js';
import { PluginTaskError } from './pluginTaskService.js';

/** Plans describe work; only host directory facts authorize it. */
export async function resolvePluginWorkerDirectory(input: {
  requested: string;
  leadDirectory?: string;
  configuredDirectory?: string;
  isPickedDirectory: (directory: string) => boolean;
  assertCurrent: () => void;
}): Promise<string> {
  const deny = () => new PluginTaskError('PERMISSION_DENIED', 'Worker directory is outside the plugin task scope');
  if (!path.isAbsolute(input.requested) || input.requested.includes('\0')) throw deny();
  input.assertCurrent();
  const resolved = await realpath(input.requested);
  if (!(await stat(resolved)).isDirectory()) throw deny();
  let allowed = false;
  if (input.leadDirectory) allowed = isPathInsideDir(await realpath(input.leadDirectory), resolved);
  if (!allowed && input.configuredDirectory) {
    const configured = await realpath(input.configuredDirectory);
    allowed = isPathInsideDir(configured, resolved) && isPathInsideDir(resolved, configured);
  }
  // Pick grants are exact-directory grants, not permission for an arbitrary Library root.
  if (!allowed) allowed = input.isPickedDirectory(resolved);
  input.assertCurrent();
  if (!allowed) throw deny();
  return resolved;
}
