import {describe, it, expect} from 'vitest';
import {pluginWorkerCompletedAt} from '../pluginWorkerCompletion.js';
import {readFileSync} from 'node:fs';
import Database from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {and, desc, eq, inArray, isNull, sql} from 'drizzle-orm';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import ts from 'typescript';
const final = {status:'idle',working:false,queued:0,paused:false,startedAt:100,endedAt:200,anchor:{role:'assistant',createdAt:190,agentMeta:'{"turnCompleted":true}'}};
describe('released Worker completion',()=>{
 it('recovers a released final turn from host metadata',()=>expect(pluginWorkerCompletedAt(final)).toBe(200));
 it.each([{working:true},{queued:1},{paused:true},{status:'error'},{startedAt:210},{clearedAt:195},{anchor:{...final.anchor,role:'user'}},{anchor:{...final.anchor,agentMeta:'{}'}},{anchor:{...final.anchor,agentMeta:'{"turnCompleted":false}'}},{anchor:{...final.anchor,agentMeta:'{"turnCompleted":true,"parentUuid":"child"}'}}])('does not infer completion from idle or old/report text: %j',patch=>expect(pluginWorkerCompletedAt({...final,...patch})).toBeNull());
});

it.each(['assistant', 'user'])('uses insertion order for same-millisecond latest %s evidence', async latest => {
 const sqlite = new Database(':memory:');
 try {
  sqlite.exec('CREATE TABLE sessions(id TEXT, active_turn_started_at INTEGER, last_turn_ended_at INTEGER, cleared_at INTEGER); CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, created_at INTEGER, agent_meta TEXT, rewind_at INTEGER);');
  const sessions = sqliteTable('sessions', {id:text('id'),activeTurnStartedAt:integer('active_turn_started_at'),lastTurnEndedAt:integer('last_turn_ended_at'),clearedAt:integer('cleared_at')});
  const messages = sqliteTable('messages', {id:text('id'),sessionId:text('session_id'),role:text('role'),createdAt:integer('created_at'),agentMeta:text('agent_meta'),rewindAt:integer('rewind_at')});
  sqlite.prepare('INSERT INTO sessions VALUES (?, 100, 200, NULL)').run('worker');
  const insert = sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, 190, ?, ?)');
  insert.run('z-old', 'worker', latest === 'user' ? 'assistant' : 'user', '{"turnCompleted":true}', null);
  insert.run('a-new', 'worker', latest, '{"turnCompleted":true}', null);
  insert.run('other', 'other-worker', 'user', '{}', null);
  insert.run('child', 'worker', 'user', '{"parentUuid":"child"}', null);
  insert.run('rewound', 'worker', 'user', '{}', 195);
  const epoch = {client:{drizzle:drizzle(sqlite)}};
  const source = readFileSync(new URL('../register.ts',import.meta.url),'utf8');
  const start = source.indexOf('  const readPluginWorkerCompletion =');
  const code = source.slice(start, source.indexOf('  const handlePluginTask =',start));
  const deps = {sessions,messages,and,desc,eq,inArray,isNull,sql,pluginWorkerCompletedAt,getCurrentDbClientSnapshot:()=>epoch,createOrcaDiagnosticsDeps:()=>({getWorkerFlowStatus:async()=>({isWorking:false,queuedCount:0,queuePaused:false})})};
  const read = new Function(...Object.keys(deps),ts.transpileModule(`${code}\nreturn readPluginWorkerCompletion;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(deps));
  expect((await read(epoch,'worker','idle')).completedAt).toBe(latest === 'assistant' ? 200 : null);
 } finally {sqlite.close();}
});
