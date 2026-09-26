import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolvePluginWorkerDirectory } from '../pluginWorkerDirectory.js';

describe('plugin Worker directory authorization', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
  it('allows the task and its real children, configured or picked roots, without granting Library', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(),'plugin-dirs-'))); roots.push(root);
    const dirs = ['task','task/child','task-other','configured','picked','library'];
    for (const dir of dirs) await mkdir(path.join(root,dir),{recursive:true});
    const input = {leadDirectory:path.join(root,'task'),configuredDirectory:path.join(root,'configured'),isPickedDirectory:(dir:string)=>dir===path.join(root,'picked'),assertCurrent:()=>{}};
    for (const dir of ['task','task/child','configured','picked']) expect(await resolvePluginWorkerDirectory({...input,requested:path.join(root,dir)})).toBe(path.join(root,dir));
    for (const dir of ['task-other','library']) await expect(resolvePluginWorkerDirectory({...input,requested:path.join(root,dir)})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(resolvePluginWorkerDirectory({...input,requested:path.join(root,'task','..','library')})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await symlink(path.join(root,'library'),path.join(root,'task','escape'),'junction');
    await expect(resolvePluginWorkerDirectory({...input,requested:path.join(root,'task','escape')})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(resolvePluginWorkerDirectory({...input,isPickedDirectory:()=>false,requested:path.join(root,'picked')})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  });
  it('rechecks ownership after asynchronous resolution', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(),'plugin-owner-'))); roots.push(root);
    const assertCurrent = vi.fn().mockImplementationOnce(()=>{}).mockImplementation(()=>{throw Error('Account changed');});
    await expect(resolvePluginWorkerDirectory({requested:root,leadDirectory:root,isPickedDirectory:()=>false,assertCurrent})).rejects.toThrow('Account changed');
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
});
