import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {auditRelease,releaseEntries} from '../scripts/check-release.mjs';
import {tempDir} from './helpers.mjs';

async function fixture(t){
 const root=await tempDir(t);
 for(const entry of releaseEntries){const path=join(root,entry);if(['src','public','scripts','tests','extensions','docs','licenses'].includes(entry))await mkdir(path);else await writeFile(path,'example\n');}
 return root;
}
test('release audit rejects forbidden runtime/experiment artifacts inside allowed directories',async t=>{
 for(const file of ['pool-share-experiment.mjs','payload.wasm','session.pem','accounts.json']){
  const root=await fixture(t);await writeFile(join(root,'src',file),'fixture');
  await assert.rejects(auditRelease(root),/forbidden release path/);
 }
});
test('release audit rejects credential-shaped material without printing its value',async t=>{
 const root=await fixture(t),value='ghp_'+'x'.repeat(40);await writeFile(join(root,'src','example.mjs'),'const secret="'+value+'";');
 await assert.rejects(auditRelease(root),e=>e.message.includes('credential-like material')&&!e.message.includes(value));
});
test('release audit excludes local runtime folders and accepts only public source entries',async t=>{
 const root=await fixture(t);await mkdir(join(root,'data'));await writeFile(join(root,'data','credentials.json'),'private test fixture');
 const result=await auditRelease(root);assert.ok(result.paths.every(path=>!path.startsWith('data/')));assert.equal(result.googleCalls,0);
});
