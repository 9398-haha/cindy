import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, it } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { createPluginTaskStore } from '../pluginTaskStore.js';

it('pages by creation time and ID without losing later records with smaller UUIDs', async () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(`CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, plugin_id TEXT,
      operation TEXT, target_id TEXT, request_key TEXT, fingerprint TEXT, payload TEXT,
      revision INTEGER, created_at INTEGER)`);
    const store = createPluginTaskStore({ drizzle: drizzle(sqlite) } as unknown as DbClient);
    const add = sqlite.prepare('INSERT INTO plugin_task_requests VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)');
    for (const operation of ['create', 'send']) {
      const prefix = operation + '-';
      const target = operation === 'send' ? 'task' : null;
      const insert = (id: string, time: number, plugin = 'p') => add.run(prefix + id, plugin, operation, 'task', id, 'h', '{}', time);
      insert('z', 1);insert('y', 1);
      expect((await store.list('p', operation, target, '', 1)).map(r => r.id)).toEqual([prefix + 'y']);
      expect((await store.list('p', operation, target, prefix + 'y', 1)).map(r => r.id)).toEqual([prefix + 'z']);
      insert('a', 2);insert('b', 3, 'other');
      expect((await store.list('p', operation, target, prefix + 'z', 10)).map(r => r.id)).toEqual([prefix + 'a']);
      await expect(store.list('other', operation, target, prefix + 'z', 10)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(store.list('p', operation, 'different', prefix + 'z', 10)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
  } finally { sqlite.close(); }
});
