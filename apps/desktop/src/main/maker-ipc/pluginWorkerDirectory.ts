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
  // Stored Host roots are canonical identities, not aliases to resolve into new grants.
  const sameDirectory = (a: string, b: string) => isPathInsideDir(a, b) && isPathInsideDir(b, a);
  const unchangedRoot = async (stored: string) => {
    const current = await realpath(stored);
    return sameDirectory(stored, current) ? current : null;
  };
  let allowed = false;
  if (input.leadDirectory) {
    const lead = await unchangedRoot(input.leadDirectory);
    allowed = lead !== null && isPathInsideDir(lead, resolved);
  }
  if (!allowed && input.configuredDirectory) {
    const configured = await unchangedRoot(input.configuredDirectory);
    allowed = configured !== null && sameDirectory(configured, resolved);
  }
  // Pick grants are exact-directory grants, not permission for an arbitrary Library root.
  if (!allowed) allowed = input.isPickedDirectory(resolved);
  input.assertCurrent();
  if (!allowed) throw deny();
  return resolved;
}
