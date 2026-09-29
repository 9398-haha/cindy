import { getDbClient } from './localDb/client/current.js';
import type { DbClient } from './localDb/client/DbClient.js';
import { botTaskResultKey, readBotCollaborationMeta, readBotTaskResults, taskResultClientIdForInput, type BotCollaborationMeta } from '../shared/botCollaboration.js';

/** Called inside the durable message FIFO. Never changes receipts, order or execution. */
export async function readTaskResultsForReply(
  sessionId: string, replyClientId: string, inputClientIds: readonly string[],
  db: Pick<DbClient, 'queryOne' | 'query'> = getDbClient(),
): Promise<BotCollaborationMeta[]> {
  const receiptIds = [...new Set(inputClientIds.flatMap(id => {
    const receipt = taskResultClientIdForInput(id);
    return receipt ? [receipt] : [];
  }))];
  if (!receiptIds.length) return [];
  // Only canonical teammate conversations participate; ordinary tasks/group lanes do not.
  const reply = await db.queryOne<{ botId: string; content: string; agentMeta: string | null }>(`
    SELECT b.bot_id AS botId, m.content, m.agent_meta AS agentMeta
    FROM messages m JOIN sessions s ON s.id = m.session_id
    JOIN bot_session_links b ON b.session_id = s.id
    WHERE m.session_id = ? AND m.client_id = ? AND m.role = 'assistant'
      AND m.rewind_at IS NULL AND s.source = 'bot' AND b.role IN ('canonical', 'history')
      AND NOT EXISTS (SELECT 1 FROM messages later WHERE later.session_id = m.session_id
        AND later.rewind_at IS NULL AND later.role IN ('tool_use', 'tool_result')
        AND (later.created_at > m.created_at OR (later.created_at = m.created_at AND later.rowid > m.rowid)))
  `, [sessionId, replyClientId]);
  if (!reply) return [];
  let meta: Record<string, unknown>;
  let content: unknown;
  try { meta = JSON.parse(reply.agentMeta ?? '{}'); content = JSON.parse(reply.content); } catch { return []; }
  if (typeof content !== 'string' || !content.trim() || meta.assistantPhase === 'commentary'
    || meta.parentUuid || meta.botPrivateReply || meta.botCollaboration || meta.botDirectMessage) return [];
  // A replayed seal may carry only part of the consumed inputs. Preserve its existing attachments.
  const results = meta.turnCompleted === true ? readBotTaskResults(meta.botTaskResults) : [];
  const attached = new Set(results.map(botTaskResultKey));
  for (const receiptId of receiptIds) {
    const row = await db.queryOne<{ agentMeta: string }>(`
      SELECT agent_meta AS agentMeta FROM messages
      WHERE session_id = ? AND client_id = ? AND role = 'assistant' AND rewind_at IS NULL
    `, [sessionId, receiptId]);
    if (!row) continue;
    let card: BotCollaborationMeta | null;
    try { card = readBotCollaborationMeta(JSON.parse(row.agentMeta).botCollaboration); } catch { continue; }
    if (card?.role !== 'delegation-result' || !card.result || card.parentSessionId !== sessionId
      || card.fromBotId !== reply.botId || botTaskResultKey(card) !== receiptId) continue;
    // Retry/replayed wakes cannot attach the same execution to a second unrelated reply.
    // Guard JSON at the function argument: WHERE evaluation order must not let an unrelated
    // corrupt history row (or a legacy scalar attachment) abort this new reply's association.
    const existing = await db.queryOne<{ found: number }>(`
      WITH historic_replies AS (
        SELECT CASE WHEN json_valid(agent_meta) THEN agent_meta ELSE '{}' END AS meta
        FROM messages
        WHERE session_id = ? AND client_id != ? AND role = 'assistant' AND rewind_at IS NULL
      )
      SELECT 1 AS found FROM historic_replies, json_each(meta, '$.botTaskResults') r
      WHERE json_extract(meta, '$.turnCompleted') = 1
        AND json_extract(CASE WHEN r.type = 'object' THEN r.value ELSE '{}' END, '$.delegationId') = ?
        AND json_extract(CASE WHEN r.type = 'object' THEN r.value ELSE '{}' END, '$.result.runSequence') = ?
      LIMIT 1
    `, [sessionId, replyClientId, card.delegationId, card.result.runSequence]);
    if (!existing && !attached.has(receiptId)) {
      results.push(card);
      attached.add(receiptId);
    }
  }
  return results;
}
