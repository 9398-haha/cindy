import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, it } from 'vitest';
import ts from 'typescript';
import { readAutoReviewProjectionTransaction, type StoredAutoReviewProjection } from '../../localDb/autoReviewProjection.js';

const sessions = sqliteTable('sessions', {
  id:text('id'),source:text('source'),orcaRole:text('orca_role'),workingDir:text('working_dir'),
  permissionMode:text('permission_mode'),planModeEnabled:integer('plan_mode_enabled',{mode:'boolean'}),
  status:text('status'),agentKind:text('agent_kind'),providerId:text('provider_id'),model:text('model'),
  effort:text('effort'),fastMode:integer('fast_mode',{mode:'boolean'}),
});
const orcaWorkers = sqliteTable('orca_workers',{sessionId:text('session_id'),teamId:text('team_id'),label:text('label')});
const orcaTeams = sqliteTable('orca_teams',{id:text('id'),leadSessionId:text('lead_session_id'),status:text('status')});
const source=readFileSync(new URL('../register.ts',import.meta.url),'utf8');
const start=source.indexOf('  setAutoReviewContextResolver(createPluginTaskReviewResolver(async sessionId => {');
const block=source.slice(start,source.indexOf('\n  }));',start)+7);
const js=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const changes = {
  workerPermission: "UPDATE sessions SET permission_mode='default' WHERE id='worker'",
  workerPlan: "UPDATE sessions SET plan_mode_enabled=1 WHERE id='worker'",
  workerStatus: "UPDATE sessions SET status='archived' WHERE id='worker'",
  directory: "UPDATE sessions SET working_dir='/other' WHERE id='worker'",
  route: "UPDATE sessions SET model='other' WHERE id='worker'",
  leadPermission: "UPDATE sessions SET permission_mode='default' WHERE id='lead'",
  leadPlan: "UPDATE sessions SET plan_mode_enabled=1 WHERE id='lead'",
  leadStatus: "UPDATE sessions SET status='archived' WHERE id='lead'",
  team: "UPDATE orca_teams SET status='archived'",
  label: "UPDATE orca_workers SET label='other'",
  unlink: "DELETE FROM orca_workers",
  receipt: "UPDATE plugin_task_requests SET payload='{}', revision=2",
};

function fixture() {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, orca_role TEXT, working_dir TEXT, permission_mode TEXT, plan_mode_enabled INTEGER, status TEXT, agent_kind TEXT, provider_id TEXT, model TEXT, effort TEXT, fast_mode INTEGER, cleared_at INTEGER);
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT, client_id TEXT, role TEXT, content TEXT, created_at INTEGER, agent_meta TEXT, rewind_at INTEGER);
      CREATE TABLE orca_workers(session_id TEXT, team_id TEXT, label TEXT);
      CREATE TABLE orca_teams(id TEXT, lead_session_id TEXT, status TEXT);
      CREATE TABLE plugin_task_requests(id TEXT, target_id TEXT, plugin_id TEXT, operation TEXT, payload TEXT, revision INTEGER);
      INSERT INTO sessions VALUES ('lead','plugin','lead','/answer','auto',0,'active','codex','p','model','high',0,NULL),('worker','orca','worker','/answer','auto',0,'active','codex','p','model','high',0,NULL);
      INSERT INTO orca_workers VALUES ('worker','team','sample');
      INSERT INTO orca_teams VALUES ('team','lead','active');
      INSERT INTO plugin_task_requests VALUES ('lead','','plugin','create','{"teamPlan":{"task":"scope","items":[]}}',1);`);
  db.exec(readFileSync(new URL('../../../../drizzle/0122_auto_review_projections.sql', import.meta.url), 'utf8'));
  const companion = readFileSync(new URL('../../../../drizzle/scripts/0122_auto_review_projections.ts', import.meta.url), 'utf8');
  const module = { exports: {} as { run: (db: Database.Database) => void } };
  new Function('module', companion)(module);
  module.exports.run(db);
  const control = { phase: '', mutate: () => {}, storageUnavailable: false };
  const mutate=(at:string)=>{if(control.phase===at)control.mutate();};
  const epoch={userId:'owner',clientEpoch:1,client:{drizzle:drizzle(db),
    tx:async(_name:string,args:unknown)=>{const projection=readAutoReviewProjectionTransaction(db,args);mutate('projection');return projection;},
    queryOne:async(sql:string,params:unknown[])=>{if(control.storageUnavailable)throw Error('storage unavailable');return db.prepare(sql).get(...params);},
  }};
  let load!:(id:string)=>Promise<{authorized:boolean;projection:StoredAutoReviewProjection}>;
  const deps={setAutoReviewContextResolver:(fn:typeof load)=>{load=fn;},createPluginTaskReviewResolver:(fn:typeof load)=>fn,
    getCurrentDbClientSnapshot:()=>epoch,sessions,orcaWorkers,orcaTeams,eq,
    createPluginTaskStore:()=>({get:async()=>db.prepare('SELECT id,target_id AS targetId,plugin_id AS pluginId,operation,payload,revision FROM plugin_task_requests').get()}),
    drainPersistQueue:async()=>mutate('drain'),pluginTaskServiceForCurrentOwner:()=>({get:async()=>mutate('ownership')}),
    readGhostErrandConfig:()=>({permissionMode:'auto'}),readPluginTaskPlanReceipt:JSON.parse,
    pluginTaskAuthorizationRevision:()=> 'install',isPluginTaskAuthorized:()=>true,
  };
  new Function(...Object.keys(deps),js)(...Object.values(deps));
  return {db,control,load};
}

it.each(['drain','projection','ownership'].flatMap(phase=>[
  ...Object.keys(changes).map(change=>({phase,change,sessionId:'worker'})),
  ...['leadPermission','leadPlan','leadStatus','receipt'].map(change=>({phase,change,sessionId:'lead'})),
]))('rejects changed $change for $sessionId after $phase with one final database read', async ({phase,change,sessionId})=>{
  const {db,control,load}=fixture();
  try {
    db.exec("UPDATE sessions SET provider_id=NULL,working_dir='/评测/answer'");
    expect((await load(sessionId)).authorized).toBe(true);
    control.storageUnavailable=true;
    await expect(load(sessionId)).rejects.toThrow('storage unavailable');
    control.storageUnavailable=false;
    control.phase=phase;
    control.mutate=()=>db.exec(changes[change as keyof typeof changes]);
    expect((await load(sessionId)).authorized).toBe(false);
  } finally {db.close();}
});

it.each(['drain','projection','ownership'].flatMap(phase =>
  [{sessionId:'worker',writer:'lead'},{sessionId:'worker',writer:'worker'},{sessionId:'lead',writer:'lead'}].flatMap(pair =>
    ['insert','edit','delete','rewind','clear'].map(operation => ({phase,...pair,operation})),
  ),
))('rechecks $writer $operation evidence for $sessionId after $phase', async ({phase,sessionId,writer,operation}) => {
  const {db,control,load}=fixture();
  const add = (id:string, text:string, at:number) => db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,NULL)').run(
    id,writer,id,'user',JSON.stringify({text}),at,JSON.stringify({delivery:'turn',autoReviewUserText:text}),
  );
  try {
    add('grant','allow publishing',1);
    const before=await load(sessionId);
    expect(before.authorized).toBe(true);
    expect(JSON.stringify(before.projection.reviewIntent)).toContain('allow publishing');
    control.phase=phase;
    control.mutate=()=>{
      if(operation==='insert') add('restriction','never publish',2);
      if(operation==='edit') db.prepare('UPDATE messages SET content=?,agent_meta=? WHERE id=?').run(
        JSON.stringify({text:'never publish'}),JSON.stringify({delivery:'turn',autoReviewUserText:'never publish'}),'grant');
      if(operation==='delete') db.prepare('DELETE FROM messages WHERE id=?').run('grant');
      if(operation==='rewind') db.prepare('UPDATE messages SET rewind_at=2 WHERE id=?').run('grant');
      if(operation==='clear') db.prepare('UPDATE sessions SET cleared_at=1 WHERE id=?').run(writer);
    };
    const result=await load(sessionId);
    const current=readAutoReviewProjectionTransaction(db,{sessionId,leadId:'lead'});
    expect(current.revision).toBeGreaterThan(before.projection.revision);
    expect(result.authorized).toBe(phase==='drain');
    expect(result.projection.revision).toBe(phase==='drain'?current.revision:before.projection.revision);
    // A subsequent request can read the new evidence; rejection does not poison the task.
    control.phase='';
    expect((await load(sessionId)).projection).toEqual(current);
    expect((await load(sessionId)).authorized).toBe(true);
  } finally {db.close();}
});
