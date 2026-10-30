import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tempDir} from './helpers.mjs';
import {BridgeGrants} from '../src/bridge-grants.mjs';
import {ResumeConnections} from '../extensions/build-browser-bridge/resume.mjs';

test('resume grants survive restart, bind account/project/origin, and are revocable',async t=>{
  const dataDir=await tempDir(t),a={id:'a',email:'test@example.invalid',appURL:'https://aistudio.google.com/apps/test?authuser=0'},origin='chrome-extension://'+'a'.repeat(32);
  const first=new BridgeGrants(dataDir),key=await first.issue(a,origin);
  assert.ok(!(await readFile(join(dataDir,'bridge-grants.json'),'utf8')).includes(key));
  const restarted=new BridgeGrants(dataDir);assert.equal((await restarted.check(key,[a],origin)).id,'a');
  await assert.rejects(restarted.check(key,[a],'chrome-extension://'+'b'.repeat(32)),e=>e.code==='resume_invalid');
  await assert.rejects(restarted.check(key,[{...a,appURL:a.appURL+'other'}],origin),e=>e.code==='resume_invalid');
  await assert.rejects(restarted.check(key,[{...a,enabled:false}],origin),e=>e.code==='account_disabled');
  await restarted.revoke('a');await assert.rejects(new BridgeGrants(dataDir).check(key,[a],origin),e=>e.code==='resume_invalid');
});

test('startup reuses the saved project, waits for editor readiness and never creates a project or generates',async()=>{
  const saved={base:'http://127.0.0.1:18787',email:'test@example.invalid',target:'https://aistudio.google.com/apps/test?authuser=0',resumeKey:'a'.repeat(64)};
  const data={buildConnections:[saved]},tabs=[{id:12,url:saved.target}],calls=[];
  const chrome={storage:{local:{get:async key=>({[key]:data[key]}),set:async v=>Object.assign(data,v)}},tabs:{query:async()=>tabs,create:async()=>assert.fail('existing tab must be reused')}};
  const client={links:new Map(),post:async(_b,path)=>{assert.equal(path,'/bridge/resume-check');return {connected:false,account:{email:saved.email,appURL:saved.target}};},connect:async args=>{calls.push(args);client.links.set(args.tabId,{base:args.base,email:saved.email});}};
  const restore=new ResumeConnections({chrome,client});await Promise.all([restore.restore(),restore.restore()]);
  assert.equal(calls.length,1);assert.equal(calls[0].tabId,12);assert.equal(calls[0].resumeKey,saved.resumeKey);assert.equal(calls[0].code,undefined);
  await restore.restore();assert.equal(calls.length,1);
  await restore.forget(saved.base,saved.email);assert.equal(data.buildConnections.length,0);
});

test('offline service does not open browser tabs; invalid grant is removed instead of endlessly retried',async()=>{
  const item={base:'http://localhost:18787',email:'test@example.invalid',target:'https://aistudio.google.com/apps/test?authuser=0',resumeKey:'b'.repeat(64)},data={buildConnections:[item]};
  let code;
  const chrome={storage:{local:{get:async key=>({[key]:data[key]}),set:async v=>Object.assign(data,v)}},tabs:{query:async()=>assert.fail('no tab work while unavailable')}};
  const client={links:new Map(),post:async()=>{throw Object.assign(new Error('unavailable'),{code});}};
  const restore=new ResumeConnections({chrome,client});await restore.restore();assert.equal(data.buildConnections.length,1);
  code='resume_invalid';await restore.restore(undefined,{force:true});assert.equal(data.buildConnections.length,0);
});
