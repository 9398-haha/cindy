import { and, asc, eq, gt, or, getTableColumns, sql } from 'drizzle-orm';
import { PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS } from '../../shared/pluginTasks.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { pluginTaskRequests } from '../localDb/schema.js';
import type { PluginTaskStore } from './pluginTaskService.js';
import { PluginTaskError } from './pluginTaskService.js';

/** Captures the DB handle once, so a delayed operation never switches accounts. */
export function createPluginTaskStore(db: DbClient): PluginTaskStore {
  const table = pluginTaskRequests;
  return {
    get: async (id) => {
      // Do not transfer oversized legacy payloads to Main for each Auto action.
      const [row] = await db.drizzle.select({ ...getTableColumns(table),
        payload: sql<string>`CASE WHEN length(${table.payload}) <= ${PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS} THEN ${table.payload} ELSE NULL END`,
      }).from(table).where(eq(table.id, id)).limit(1);
      if (row && (typeof row.payload !== 'string' || row.payload.length > PLUGIN_TASK_RECEIPT_MAX_JSON_CHARS))
        throw new PluginTaskError('INVALID_REQUEST', 'Task receipt exceeds the supported size');
      return row;
    },
    find: async (pluginId, operation, targetId, requestKey) =>
      (
        await db.drizzle
          .select()
          .from(table)
          .where(
            and(
              eq(table.pluginId, pluginId),
              eq(table.operation, operation as 'create' | 'send'),
              eq(table.targetId, targetId),
              eq(table.requestKey, requestKey),
            ),
          )
          .limit(1)
      )[0],
    list: async (pluginId, operation, targetId, after, limit) => {
      const scope = and(
        eq(table.pluginId, pluginId),
        eq(table.operation, operation as 'create' | 'send'),
        targetId === null ? undefined : eq(table.targetId, targetId),
      );
      // Keep the existing opaque receipt-ID cursor, resolving its ordering key
      // within the same plugin and target without loading its payload.
      const [cursor] = after ? await db.drizzle.select({ createdAt: table.createdAt })
        .from(table).where(and(scope, eq(table.id, after))).limit(1) : [];
      if (after && !cursor) throw new PluginTaskError('INVALID_REQUEST', 'Invalid task cursor');
      return db.drizzle
        .select()
        .from(table)
        .where(
          and(
            scope,
            cursor ? or(gt(table.createdAt, cursor.createdAt),
              and(eq(table.createdAt, cursor.createdAt), gt(table.id, after))) : undefined,
          ),
        )
        .orderBy(asc(table.createdAt), asc(table.id))
        .limit(limit);
    },
    forSession: (taskId) =>
      db.drizzle
        .select()
        .from(table)
        .where(and(eq(table.operation, 'send'), eq(table.targetId, taskId))),
    insert: async (row) => {
      await db.drizzle.insert(table).values(row);
    },
    save: async (row) => {
      const result = await db.drizzle
        .update(table)
        .set({ payload: row.payload, revision: row.revision + 1 })
        .where(and(eq(table.id, row.id), eq(table.revision, row.revision)))
        .returning({ id: table.id });
      if (!result.length) throw new Error('Plugin task receipt revision conflict');
    },
  };
}
