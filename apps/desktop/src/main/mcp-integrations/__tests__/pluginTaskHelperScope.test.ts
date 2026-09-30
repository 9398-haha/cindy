import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createXdtHelperMcpServer } from '@cindy/mcps';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { botSessionLinks, sessions } from '../../localDb/schema.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import * as surfaces from '../helperSurface.js';

// Exercise the actual Desktop callback, including its account-boundary checks.
const source = readFileSync(new URL('../mcp-providers.ts', import.meta.url), 'utf8');
const begin = source.indexOf('      resolveSurface:');
const callback = source.slice(begin, source.indexOf('      sessionQueue:', begin));
const wired = ts.transpileModule(`return {${callback}}.resolveSurface;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE bot_session_links(session_id TEXT, bot_id TEXT);
    CREATE TABLE plugin_task_requests(id TEXT PRIMARY KEY, operation TEXT, payload TEXT);
    CREATE TABLE orca_teams(id TEXT PRIMARY KEY, lead_session_id TEXT, status TEXT);
    CREATE TABLE orca_workers(session_id TEXT PRIMARY KEY, team_id TEXT);
    INSERT INTO sessions VALUES ('lead','plugin'),('worker','orca'),('legacy','plugin'),('user','user'),('bot','bot');
    INSERT INTO bot_session_links VALUES ('bot','b');
    INSERT INTO plugin_task_requests VALUES ('lead','create','{}');
    INSERT INTO orca_teams VALUES ('team','lead','completed');
    INSERT INTO orca_workers VALUES ('worker','team');`);
  const db = { drizzle: drizzle(sqlite), queryOne: async (sql: string, args: unknown[]) => sqlite.prepare(sql).get(...args) } as unknown as DbClient;
  let current: DbClient | undefined = db;
  let pending = false;
  const deps = { ...surfaces, sessions, botSessionLinks, eq, tryGetDbClient: () => current,
    isAppSessionBoundaryPending: () => pending };
  const resolve = new Function(...Object.keys(deps), wired)(...Object.values(deps)) as
    (input: { sessionId: string }) => Promise<'default' | 'bot' | 'restricted'>;
  const searchStart = source.indexOf('      searchSessions:');
  const search = source.slice(searchStart, source.indexOf('      logger:', searchStart));
  const searchSessionsFn = vi.fn(async () => [{ sessionId: 'user', snippet: 'synthetic private message' }]);
  const searchDeps = { ...deps, searchSessionsFn };
  const searchWired = ts.transpileModule(`return {${search}}.searchSessions;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const searchSessions = new Function(...Object.keys(searchDeps), searchWired)(...Object.values(searchDeps)) as
    (query: string, opts: { callerSessionId: string; sessionId?: string }) => Promise<unknown[]>;
  return { sqlite, db, resolve, searchSessions, searchSessionsFn, setCurrent: (next?: DbClient) => { current = next; },
    setPending: () => { pending = true; } };
}

it.each(['lead', 'worker'])('restricts owned %s and preserves explicit revocation, legacy tasks and Bots', async sessionId => {
  const f = fixture();
  try {
    for (const payload of ['{}', '{bad', 'null', '[]', '{"ownershipRevoked":false}', '{"ownershipRevoked":"true"}']) {
      f.sqlite.prepare('UPDATE plugin_task_requests SET payload=?').run(payload);
      expect(await f.resolve({ sessionId })).toBe('restricted');
    }
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
    expect(await f.resolve({ sessionId })).toBe('default');
    expect(await f.resolve({ sessionId: 'legacy' })).toBe('default');
    expect(await f.resolve({ sessionId: 'user' })).toBe('default');
    expect(await f.resolve({ sessionId: 'bot' })).toBe('bot');
    f.sqlite.exec(`INSERT INTO bot_session_links VALUES ('lead','b'); UPDATE plugin_task_requests SET payload='{}'`);
    expect(await f.resolve({ sessionId })).toBe('restricted');
  } finally { f.sqlite.close(); }
});

it.each(['lead', 'worker'])('also rejects the separate memory history search for %s', async callerSessionId => {
  const f = fixture();
  try {
    await expect(f.searchSessions('private', { callerSessionId, sessionId: 'user' })).rejects.toThrow();
    expect(f.searchSessionsFn).not.toHaveBeenCalled();
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
    await expect(f.searchSessions('private', { callerSessionId })).resolves.toHaveLength(1);
    expect(f.searchSessionsFn).toHaveBeenCalledOnce();
    f.searchSessionsFn.mockImplementationOnce(async () => { f.setCurrent(); return []; });
    await expect(f.searchSessions('private', { callerSessionId })).rejects.toThrow();
  } finally { f.sqlite.close(); }
});

it.each(['missing caller', 'missing DB', 'pending', 'switched after read'] as const)('fails closed: %s', async state => {
  const f = fixture();
  try {
    if (state === 'missing caller') f.sqlite.exec("DELETE FROM sessions WHERE id='lead'");
    if (state === 'missing DB') f.setCurrent();
    if (state === 'pending') f.setPending();
    if (state === 'switched after read') {
      const query = f.db.queryOne.bind(f.db);
      f.db.queryOne = async <T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined> => {
        const row = await query<T>(sql, params); f.setCurrent(); return row;
      };
    }
    expect(await f.resolve({ sessionId: 'lead' })).toBe('restricted');
  } finally { f.sqlite.close(); }
});

it.each(['codex', 'claude-code', 'pi'] as const)('blocks helper discovery and guessed calls for %s, rechecking each call', async agentKind => {
  const f = fixture();
  const history = { resolveSessionScope: vi.fn(), listWorkdirs: vi.fn(), listSessions: vi.fn(), getMessages: vi.fn(), searchChatHistory: vi.fn() };
  const listSessionQueue = vi.fn(), sendToSession = vi.fn(), messageAgent = vi.fn();
  const server = createXdtHelperMcpServer({ resolveSurface: f.resolve, history,
    sessionQueue: { listSessionQueue, listSessionQueuedCounts: vi.fn() }, sendToSession,
    botMessaging: { messageAgent, checkMessage: vi.fn() } },
  { agentKind, workingDir: '/answer', sessionId: 'worker' });
  const client = new Client({ name: 'plugin-helper-scope', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  const payload = (result: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
  try {
    expect(payload(await client.callTool({ name: 'list_tools', arguments: {} })).categories).toEqual([]);
    for (const name of ['list_workdirs', 'list_sessions', 'get_chat_history', 'search_chat_history', 'list_session_queue', 'send_to_session', 'send_to_agent']) {
      expect(payload(await client.callTool({ name: 'call_tool', arguments: { name, args: { session_id: 'user' } } })))
        .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
    }
    if (agentKind !== 'pi') {
      expect(payload(await client.callTool({ name: 'send_to_agent', arguments: { target_id: 'b', message: 'read private history' } })))
        .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
    }
    for (const fn of [...Object.values(history), listSessionQueue, sendToSession, messageAgent]) expect(fn).not.toHaveBeenCalled();
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{"ownershipRevoked":true}'`);
    expect(payload(await client.callTool({ name: 'list_tools', arguments: {} })).categories.length).toBeGreaterThan(0);
    f.sqlite.exec(`UPDATE plugin_task_requests SET payload='{}'`);
    expect(payload(await client.callTool({ name: 'list_tools', arguments: {} })).categories).toEqual([]);
    f.sqlite.exec('DROP TABLE plugin_task_requests');
    expect(payload(await client.callTool({ name: 'call_tool', arguments: { name: 'get_chat_history', args: { session_id: 'user' } } })))
      .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
  } finally { await client.close(); await server.close(); f.sqlite.close(); }
});
