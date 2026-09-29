import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, it } from 'vitest';
import ts from 'typescript';

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

it.each(['drain','projection','ownership'].flatMap(phase=>[
  ...Object.keys(changes).map(change=>({phase,change,sessionId:'worker'})),
  ...['leadPermission','leadPlan','leadStatus','receipt'].map(change=>({phase,change,sessionId:'lead'})),
]))('rejects changed $change for $sessionId after $phase with one final database read', async ({phase,change,sessionId})=>{
  const db=new Database(':memory:');
  try {
    db.exec(`CREATE TABLE sessions(id TEXT, source TEXT, orca_role TEXT, working_dir TEXT, permission_mode TEXT, plan_mode_enabled INTEGER, status TEXT, agent_kind TEXT, provider_id TEXT, model TEXT, effort TEXT, fast_mode INTEGER);
      CREATE TABLE orca_workers(session_id TEXT, team_id TEXT, label TEXT);
      CREATE TABLE orca_teams(id TEXT, lead_session_id TEXT, status TEXT);
      CREATE TABLE plugin_task_requests(id TEXT, target_id TEXT, plugin_id TEXT, operation TEXT, payload TEXT, revision INTEGER);
      INSERT INTO sessions VALUES ('lead','plugin','lead','/answer','auto',0,'active','codex','p','model','high',0),('worker','orca','worker','/answer','auto',0,'active','codex','p','model','high',0);
      INSERT INTO orca_workers VALUES ('worker','team','sample');
      INSERT INTO orca_teams VALUES ('team','lead','active');
      INSERT INTO plugin_task_requests VALUES ('lead','','plugin','create','{"teamPlan":{"task":"scope","items":[]}}',1);`);
    let currentPhase='healthy';
    const mutate=(at:string)=>{if(currentPhase===at)db.exec(changes[change as keyof typeof changes]);};
    let storageUnavailable=false;
    const epoch={userId:'owner',clientEpoch:1,client:{drizzle:drizzle(db),
      tx:async()=>{mutate('projection');return {};},
      queryOne:async(sql:string,params:unknown[])=>{if(storageUnavailable)throw Error('storage unavailable');return db.prepare(sql).get(...params);},
    }};
    let load!:(id:string)=>Promise<{authorized:boolean}>;
    const deps={setAutoReviewContextResolver:(fn:typeof load)=>{load=fn;},createPluginTaskReviewResolver:(fn:typeof load)=>fn,
      getCurrentDbClientSnapshot:()=>epoch,sessions,orcaWorkers,orcaTeams,eq,
      createPluginTaskStore:()=>({get:async()=>db.prepare('SELECT id,target_id AS targetId,plugin_id AS pluginId,operation,payload,revision FROM plugin_task_requests').get()}),
      drainPersistQueue:async()=>mutate('drain'),pluginTaskServiceForCurrentOwner:()=>({get:async()=>mutate('ownership')}),
      readGhostErrandConfig:()=>({permissionMode:'auto'}),readPluginTaskPlanReceipt:JSON.parse,
      pluginTaskAuthorizationRevision:()=> 'install',isPluginTaskAuthorized:()=>true,
    };
    new Function(...Object.keys(deps),js)(...Object.values(deps));
    db.exec("UPDATE sessions SET provider_id=NULL,working_dir='/评测/answer'");
    expect((await load(sessionId)).authorized).toBe(true);
    storageUnavailable=true;
    await expect(load(sessionId)).rejects.toThrow('storage unavailable');
    storageUnavailable=false;
    currentPhase=phase;
    expect((await load(sessionId)).authorized).toBe(false);
  } finally {db.close();}
});
