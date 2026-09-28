import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import type Database from 'better-sqlite3';

/** Foreign SQLite reads stay off Electron main and include committed WAL content. */
const { database, storeKey, agentId, defaultAgent, modulePath } = workerData as {
  database: string; storeKey: string; agentId: string; defaultAgent: boolean; modulePath: string;
};
let db: Database.Database | undefined;
try {
  const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
  const loaded = require(modulePath) as typeof Database | { default: typeof Database };
  const Constructor = 'default' in loaded ? loaded.default : loaded;
  db = new Constructor(database, { readonly: true, fileMustExist: true, timeout: 5000 });
  const rows = db.prepare(`SELECT job_json, state_json FROM cron_jobs
    WHERE store_key = ? AND (COALESCE(agent_id, owner_agent_id) = ?
      OR (? = 1 AND COALESCE(agent_id, owner_agent_id) IS NULL))
    ORDER BY sort_order`).iterate(storeKey, agentId, defaultAgent ? 1 : 0) as Iterable<{ job_json: string; state_json: string }>;
  const jobs: Array<Record<string, unknown>> = [];
  let bytes = 0;
  for (const row of rows) {
    // Account for retained row/object overhead too, including empty JSON rows.
    // Check before parsing or retaining this row, never materialize the result set.
    bytes += Buffer.byteLength(row.job_json) + Buffer.byteLength(row.state_json) + 256;
    if (bytes > 16 * 1024 * 1024) throw new Error('limit');
    jobs.push({ ...JSON.parse(row.job_json), state: JSON.parse(row.state_json) });
  }
  parentPort?.postMessage({ ok: true, jobs });
} catch {
  // SQL errors may include source paths/content; only a stable code crosses back.
  parentPort?.postMessage({ ok: false });
} finally { db?.close(); }
