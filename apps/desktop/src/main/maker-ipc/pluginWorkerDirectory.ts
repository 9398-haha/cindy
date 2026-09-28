import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideDir } from '../cindy-brain/dirDeposit.js';
import { PluginTaskError } from './pluginTaskService.js';

function localDirectory(directory: string): string {
  // Preserve the supported local-drive long-path spelling, never UNC devices.
  if (process.platform === 'win32') directory = directory.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, '');
  // Reject UNC, Win32 device and NT namespace paths before filesystem APIs can
  // open an SMB/WebDAV connection (including slash/mixed-separator spellings).
  if (!path.isAbsolute(directory) || directory.includes('\0') || /^(?:[\\/]{2}|[\\/]\?\?[\\/])/.test(directory)) {
    throw new PluginTaskError('PERMISSION_DENIED', 'Plugin task directory must be a local absolute path');
  }
  return path.normalize(directory);
}

/** Plans describe work; only host directory facts authorize it. */
export async function resolvePluginWorkerDirectory(input: {
  requested: string;
  leadDirectory?: string;
  configuredDirectory?: string;
  isPickedDirectory: (directory: string) => boolean;
  assertCurrent: () => void;
}): Promise<string> {
  const deny = () => new PluginTaskError('PERMISSION_DENIED', 'Worker directory is outside the plugin task scope');
  const candidate = localDirectory(input.requested);
  input.assertCurrent();
  const sameDirectory = (a: string, b: string) => isPathInsideDir(a, b) && isPathInsideDir(b, a);
  const localRoot = (root: string | undefined) => {
    return root ? localDirectory(root) : undefined;
  };
  const leadRoot = localRoot(input.leadDirectory);
  const configuredRoot = localRoot(input.configuredDirectory);
  if (!(leadRoot && isPathInsideDir(leadRoot, candidate))
      && !(configuredRoot && sameDirectory(configuredRoot, candidate))
      && !input.isPickedDirectory(candidate)) throw deny();
  const resolved = localDirectory(await realpath(candidate));
  if (!(await stat(resolved)).isDirectory()) throw deny();
  // Stored Host roots are canonical identities, not aliases to resolve into new grants.
  const unchangedRoot = async (stored: string) => {
    const current = localDirectory(await realpath(stored));
    return sameDirectory(stored, current) ? current : null;
  };
  let allowed = false;
  if (leadRoot && isPathInsideDir(leadRoot, candidate)) {
    const lead = await unchangedRoot(leadRoot);
    allowed = lead !== null && isPathInsideDir(lead, resolved);
  }
  if (!allowed && configuredRoot && sameDirectory(configuredRoot, candidate)) {
    const configured = await unchangedRoot(configuredRoot);
    allowed = configured !== null && sameDirectory(configured, resolved);
  }
  // Pick grants are exact-directory grants, not permission for an arbitrary Library root.
  if (!allowed) allowed = input.isPickedDirectory(resolved);
  input.assertCurrent();
  if (!allowed) throw deny();
  return resolved;
}
