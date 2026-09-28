import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

type Projection = {
  pluginRoot: string;
  skills: { name: string; description: string; path: string; filePath: string }[];
};
type Entry = {
  revision: number;
  loadedRevision: number;
  stamp: string;
  watchers: FSWatcher[];
  value?: Projection;
  loading?: Promise<Projection>;
};
// Only small runtime projections are retained, never the complete source list.
// This bounds idle watcher handles across owners/bots without limiting Skills.
const entries = new Map<string, Entry>();
const MAX_CACHED_ROOTS = 32;
// Writer ownership outlives LRU entries: an evicted build can still rename its
// staged catalog. Queue replacements per root until that build has fully settled.
// Only pending work is retained here; idle roots still use the bounded LRU above.
const writers = new Map<string, Promise<Projection>>();

export function invalidateBotSkillRuntime(root: string): void {
  const entry = entries.get(path.resolve(root));
  if (entry) entry.revision++;
}

function discard(root: string, entry: Entry) {
  if (entries.get(root) === entry) entries.delete(root);
  for (const watcher of entry.watchers) watcher.close();
  entry.watchers = [];
  entry.revision++;
}

/** Constant-size directory identity checks also detect delete/recreate and moves. */
async function sourceStamp(root: string): Promise<string> {
  const [parent, skills] = await Promise.all([
    fs.stat(root).catch(() => null), fs.stat(path.join(root, 'skills')).catch(() => null),
  ]);
  return `${parent?.dev}:${parent?.ino}/${skills?.dev}:${skills?.ino}:${skills?.mtimeMs}:${skills?.ctimeMs}`;
}

/** Rebuild once per mutation, share concurrent hydrations, observe external edits. */
export async function cachedBotSkillRuntime(root: string, build: () => Promise<Projection>): Promise<Projection> {
  root = path.resolve(root);
  const stamp = await sourceStamp(root);
  let entry = entries.get(root);
  if (!entry) {
    entry = { revision: 0, loadedRevision: -1, stamp: '', watchers: [] };
    entries.set(root, entry);
  }
  if (entry.stamp !== stamp || !entry.watchers.length) {
    // Reattach on directory replacement without forking an in-flight build.
    // Its revision loop incorporates mutations before publishing the result.
    entry.stamp = stamp;
    entry.revision++;
    for (const watcher of entry.watchers) watcher.close();
    entry.watchers = [];
    const observed = entry;
    try {
      // Do not watch the whole profile/workdir or generated catalog. The parent
      // watcher covers a missing/replaced skills directory; recursive watching
      // catches SKILL.md edits that do not change the directory timestamps.
      observed.watchers.push(watch(root, { persistent: false }, (_event, filename) => {
        if (!filename || filename.toString() === 'skills') observed.revision++;
      }));
      try {
        observed.watchers.push(watch(path.join(root, 'skills'), { recursive: true, persistent: false }, (_event, filename) => {
          // Script outputs/venv caches do not alter the Skill metadata index.
          if (!filename || /^[^/\\]+(?:[/\\]skill\.md)?$/i.test(filename.toString())) observed.revision++;
        }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const watcher of observed.watchers) watcher.on('error', () => {
        for (const handle of observed.watchers) handle.close();
        observed.watchers = [];
        observed.revision++;
      });
    } catch {
      // Unwatchable roots/platforms must stay fresh, never silently cache forever.
      for (const watcher of observed.watchers) watcher.close();
      observed.watchers = [];
    }
  }
  // LRU eviction closes native handles; it does not remove any saved catalog.
  entries.delete(root);
  entries.set(root, entry);
  while (entries.size > MAX_CACHED_ROOTS) {
    const [oldRoot, oldEntry] = entries.entries().next().value!;
    discard(oldRoot, oldEntry);
  }
  const current = entry;
  if (current.loading) return structuredClone(await current.loading);
  if (current.watchers.length && current.value && current.loadedRevision === current.revision) {
    // Generated files are disposable: deleting them must rebuild the catalog.
    const present = current.value.pluginRoot === root || await Promise.all([
      fs.access(path.join(current.value.pluginRoot, 'catalog.jsonl')),
      fs.access(current.value.skills[0].filePath),
    ]).then(() => true, () => false);
    // Eviction may happen while checking generated files. Rejoin the active
    // entry rather than enqueueing work from a now-discarded cache entry.
    if (entries.get(root) !== current) return cachedBotSkillRuntime(root, build);
    if (present && current.loadedRevision === current.revision) return structuredClone(current.value);
    if (!present) current.revision++;
  }
  // Another hydration may have started rebuilding during the artifact check.
  if (current.loading) return structuredClone(await current.loading);
  const previous = writers.get(root);
  const loading = (async () => {
    // A failed predecessor has already cleaned up its staging files; it must
    // neither poison this retry nor race its final writes against this build.
    await previous?.catch(() => undefined);
    let value: Projection;
    let revision: number;
    do {
      revision = current.revision;
      value = await build();
    } while (revision !== current.revision && entries.get(root) === current);
    current.value = value;
    current.loadedRevision = revision;
    return structuredClone(value);
  })();
  current.loading = loading;
  writers.set(root, loading);
  try { return await loading; }
  catch (error) { discard(root, current); throw error; }
  finally {
    if (writers.get(root) === loading) writers.delete(root);
    current.loading = undefined;
  }
}
