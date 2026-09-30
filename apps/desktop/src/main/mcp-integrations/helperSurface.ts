import type { DbClient } from '../localDb/client/DbClient.js';

/**
 * Either legacy ownership signal is enough to keep a caller on the Bot surface.
 * Requiring both lets a partial Bot record fall through to the full default
 * surface, which includes Session control and history.
 */
export function classifyHelperSurface(
  source: string | null | undefined,
  hasBotLink: boolean,
): 'bot' | 'default' {
  return source === 'bot' || hasBotLink ? 'bot' : 'default';
}

/** Reuse the helper's existing runtime gate; plugin tasks need Orca, not account-wide helper tools. */
export async function resolveHelperSurface(
  db: Pick<DbClient, 'queryOne'>,
  sessionId: string,
): Promise<'bot' | 'default' | 'restricted'> {
  const row = await db.queryOne<{ source: string; botId: string | null; pluginOwned: number }>(
    `SELECT s.source AS source, b.bot_id AS botId,
       EXISTS (
         SELECT 1 FROM plugin_task_requests p
          WHERE p.operation = 'create' AND p.id IN (s.id, t.lead_session_id)
            AND CASE WHEN json_valid(p.payload) THEN
              CASE WHEN json_type(p.payload) = 'object'
                     AND json_type(p.payload, '$.ownershipRevoked') = 'true'
                   THEN 0 ELSE 1 END
              ELSE 1 END = 1
       ) AS pluginOwned
       FROM sessions s
       LEFT JOIN bot_session_links b ON b.session_id = s.id
       LEFT JOIN orca_workers w ON w.session_id = s.id
       LEFT JOIN orca_teams t ON t.id = w.team_id
      WHERE s.id = ? LIMIT 1`,
    [sessionId],
  );
  // Retained Workers inherit the Lead's receipt even after the team ends.
  // Only explicit ownership revocation restores the user's ordinary surface.
  // Bad receipts stay restricted; legacy plugin-source tasks have no receipt.
  if (!row || row.pluginOwned) return 'restricted';
  return classifyHelperSurface(row.source, Boolean(row.botId));
}
