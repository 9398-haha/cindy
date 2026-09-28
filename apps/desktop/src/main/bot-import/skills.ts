import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fingerprint, inside, readImportFile, readImportTree, type ImportReadBudget } from './files.js';
import { CompanionImportError, object, string, type ImportItem, type ImportSource } from './types.js';

/** Discovery roots are derived on the host from the selected source, never from IPC paths. */
interface SkillRoot { directory: string; links: 'any' | string[]; bundled?: boolean }
const ignored = new Set(['.git', '.github', '.hub', '.archive', '_archive', '.venv', 'venv', 'node_modules', 'site-packages', '__pycache__', '.tox', '.nox', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];

/** Resolve only path configuration; never expand credentials into public names. */
function sourcePath(value: string, base: string, home: string, env: NodeJS.ProcessEnv) {
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, a, b) => env[a ?? b] ?? match);
  return path.resolve(base, expanded === '~' ? home : expanded.startsWith('~/') ? path.join(home, expanded.slice(2)) : expanded);
}

async function readJson(file: string, budget: ImportReadBudget): Promise<Record<string, unknown>> {
  try {
    // Native package managers may symlink the manifest itself. Preserve that
    // discovery behavior while bounding the resolved file before allocation.
    const real = await fs.realpath(file);
    return object(JSON.parse((await readImportFile(path.dirname(real), real, budget)).bytes.toString('utf8')));
  }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') || error instanceof SyntaxError) return {}; throw error; }
}

/** Locate the installed package through its executable; don't run source code during discovery. */
async function openClawInstall(env: NodeJS.ProcessEnv, budget: ImportReadBudget): Promise<string | undefined> {
  const candidates = (env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(dir => [path.join(dir, 'openclaw'), path.join(dir, 'node_modules', 'openclaw', 'package.json')]);
  for (const candidate of candidates) {
    let real: string;
    try { real = await fs.realpath(candidate); } catch { continue; }
    let dir = path.dirname(real);
    for (let depth = 0; depth < 5; depth++) {
      if ((await readJson(path.join(dir, 'package.json'), budget)).name === 'openclaw') return dir;
      const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
    }
  }
}

async function rootsFor(source: ImportSource, values: Record<string, unknown>, home: string, env: NodeJS.ProcessEnv, budget: ImportReadBudget): Promise<SkillRoot[]> {
  const config = object(values.skills);
  const resolve = (v: string) => sourcePath(v, source.root, home, env);
  if (source.kind === 'hermes') return [path.join(source.root, 'skills'), ...strings(config.external_dirs).map(resolve)].map(directory => ({ directory, links: 'any' }));
  const load = object(config.load);
  const trusted = await Promise.all(strings(load.allowSymlinkTargets).map(async v => fs.realpath(resolve(v)).catch(() => resolve(v))));
  const roots: SkillRoot[] = [
    { directory: path.join(source.workspace, 'skills'), links: trusted },
    { directory: path.join(source.workspace, '.agents', 'skills'), links: trusted },
    ...(path.resolve(source.root) === path.join(home, '.openclaw') ? [{ directory: path.join(home, '.agents', 'skills'), links: 'any' as const }] : []),
    { directory: path.join(source.root, 'skills'), links: 'any' },
    { directory: path.join(source.root, 'agents', source.agentId, 'agent', 'workshop-skills'), links: trusted },
  ];
  const install = await openClawInstall(env, budget);
  if (install) roots.push({ directory: path.join(install, 'skills'), links: trusted, bundled: true });
  for (const directory of strings(load.extraDirs).map(resolve)) roots.push({ directory, links: trusted });
  // A plugin's manifest declares its skill roots. Disabled plugins stay out of the catalog.
  const plugins = object(values.plugins);
  if (plugins.enabled !== false) {
    const locations = [...strings(object(plugins.load).paths).map(resolve),
      ...Object.values(object(plugins.installs)).flatMap(value => string(object(value).installPath) ? [resolve(string(object(value).installPath))] : [])];
    for (const parent of [path.join(source.root, 'extensions'), ...(install ? [path.join(install, 'extensions')] : [])]) {
      try { for (const entry of await fs.readdir(parent, { withFileTypes: true })) if (entry.isDirectory()) locations.push(path.join(parent, entry.name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (const location of new Set(locations)) {
      const manifest = await readJson(path.join(location, 'openclaw.plugin.json'), budget);
      const id = string(manifest.id) || path.basename(location);
      if (object(object(plugins.entries)[id]).enabled === false || strings(plugins.deny).includes(id)) continue;
      if (Array.isArray(plugins.allow) && !strings(plugins.allow).includes(id)) continue;
      for (const folder of strings(manifest.skills)) {
        const directory = path.resolve(location, folder);
        if (inside(location, directory)) roots.push({ directory, links: trusted });
      }
    }
  }
  return roots;
}

/** Follow native precedence by declared name; grouped layouts stop at a skill entrypoint. */
export async function discoverImportSkills(source: ImportSource, values: Record<string, unknown>, home: string, env: NodeJS.ProcessEnv, budget: ImportReadBudget, used = new Set<string>()): Promise<ImportItem[]> {
  const items: ImportItem[] = [];
  const names = new Set<string>();
  const visited = new Set<string>();
  const config = object(values.skills);
  const disabled = new Set(strings(config.disabled));
  const platformDisabled = object(config.platform_disabled);
  for (const name of strings(platformDisabled.cli)) disabled.add(name);
  for (const root of await rootsFor(source, values, home, env, budget)) {
    let realRoot: string;
    try { realRoot = await fs.realpath(root.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    async function visit(directory: string, depth: number): Promise<void> {
      const real = await fs.realpath(directory);
      if (visited.has(real)) return;
      if (root.links !== 'any' && !inside(realRoot, real) && !root.links.some(allowed => inside(allowed, real))) return;
      visited.add(real);
      let manifest;
      try { manifest = await readImportFile(real, path.join(real, 'SKILL.md'), budget); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          const name = path.basename(directory);
          items.push({ view: { id: `skill-${fingerprint(real).slice(0, 20)}`, category: 'skills', name, selected: true }, sourceDirectory: real,
            filesComplete: false, captureIssue: error instanceof CompanionImportError ? error.code : 'IMPORT_ITEM_FAILED' });
          return;
        }
      }
      if (manifest?.bytes.toString('utf8').trim()) {
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(manifest.bytes.toString('utf8'));
        let info: Record<string, unknown> = {};
        try { if (front) info = object(yaml.load(front[1]!)); } catch { /* Keep the original file for native loader diagnostics. */ }
        const name = string(info.name) || path.basename(directory);
        if (names.has(name)) return;
        if (root.bundled && Array.isArray(config.allowBundled) && !strings(config.allowBundled).includes(name)) return;
        names.add(name);
        const metadata = object(object(info.metadata).openclaw ?? object(info.metadata).clawdbot ?? object(info.metadata).hermes);
        const settings = object(object(config.entries)[string(metadata.skillKey) || name]);
        const enabled = source.kind === 'hermes' ? !disabled.has(name) : settings.enabled !== false;
        const item: ImportItem = { view: { id: `skill-${fingerprint(name).slice(0, 20)}`, category: 'skills', name,
          description: string(info.description).slice(0, 280), selected: true, enabled },
          sourceDirectory: real, sourceAlias: path.basename(directory), files: [manifest], filesComplete: false };
        {
          item.env = Object.fromEntries(Object.entries(object(settings.env)).filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string')) as Record<string, string>;
          const primary = string(metadata.primaryEnv);
          if (typeof settings.apiKey === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(primary)) item.env[primary] = settings.apiKey;
          else if (settings.apiKey) {
            item.view.issues = ['MISSING_ENVIRONMENT_REFERENCE'];
            item.credential = { format: 'source-skill-auth', value: { apiKey: settings.apiKey } };
          }
        }
        if (used.has(name) || used.has(path.basename(directory))) {
          try {
            item.files = [manifest, ...await readImportTree(real, name => name !== 'SKILL.md', budget)];
            item.filesComplete = true;
          } catch (error) { item.captureIssue = error instanceof CompanionImportError ? error.code : 'IMPORT_ITEM_FAILED'; }
        }
        items.push(item); return;
      }
      if (source.kind === 'openclaw' && depth >= 6) return;
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (ignored.has(entry.name) || entry.name.startsWith('.')) continue;
        const child = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(child, depth + 1);
        else if (entry.isSymbolicLink()) {
          try { if ((await fs.stat(child)).isDirectory()) await visit(child, depth + 1); }
          catch (error) { if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        }
      }
    }
    await visit(root.directory, 0);
  }
  return items;
}
