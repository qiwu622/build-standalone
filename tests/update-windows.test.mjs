import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tempDir} from './helpers.mjs';
import {projectRoot} from '../src/storage.mjs';

const exec=promisify(execFile),windows=process.platform==='win32';
async function release(root,{version='0.4.0',failStart=false,failTests=false}={}){
  for(const dir of ['src','scripts'])await mkdir(join(root,dir),{recursive:true});
  const pkg={name:'build-standalone',version,type:'module',scripts:{test:`node -e "process.exit(${failTests?1:0})"`}};
  await writeFile(join(root,'package.json'),JSON.stringify(pkg));
  await writeFile(join(root,'package-lock.json'),JSON.stringify({name:pkg.name,version,lockfileVersion:3,packages:{'':{name:pkg.name,version}}}));
  await writeFile(join(root,'src/main.mjs'),`// synthetic release ${version}\n`);
  await writeFile(join(root,'scripts/start-windows.ps1'),"Write-Host 'SYNTHETIC_START'\n");
  await writeFile(join(root,'scripts/config-path.mjs'),`import {fileURLToPath} from 'node:url'; console.log(fileURLToPath(new URL('../data',import.meta.url)));`);
  await writeFile(join(root,'scripts/control.mjs'),`
    import fs from 'node:fs';
    const file=new URL('../data/state.json',import.meta.url),command=process.argv[2];
    let state=JSON.parse(fs.readFileSync(file));
    if(command==='status')console.log(state.running?JSON.stringify(state):'stopped');
    else if(command==='stop'){if(process.argv.includes('--if-idle')&&(state.busy||state.queued))process.exit(4);state.running=false;fs.writeFileSync(file,JSON.stringify(state));}
    else if(command==='start'){if(${failStart})process.exit(5);state.running=true;fs.writeFileSync(file,JSON.stringify(state));}
  `);
}
async function fixture(t,options={}){
  const base=await tempDir(t),target=join(base,'项目 旧版'),source=join(base,'新版 source');
  await release(target);await release(source,{version:'0.5.0',...options});
  await mkdir(join(target,'data'));await writeFile(join(target,'config.json'),' {"dataDir":"./data","port":18789} \n');
  await writeFile(join(target,'data/credentials.json'),'PRIVATE_SYNTHETIC_KEEP');
  await writeFile(join(target,'data/accounts.json'),'PRIVATE_ACCOUNTS_KEEP');
  await writeFile(join(target,'data/bridge-grants.json'),'PRIVATE_GRANTS_KEEP');
  await writeFile(join(target,'data/state.json'),JSON.stringify({running:true,busy:false,queued:0,url:'http://127.0.0.1:18789'}));
  const run=()=>exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(projectRoot,'scripts/update.ps1'),'-TargetDirectory',target,'-SourceDirectory',source,'-NoOpen'],{cwd:projectRoot,windowsHide:true,timeout:60000,env:{...process.env,BUILD_CONFIG:'',npm_config_update_notifier:'false'},maxBuffer:2*1024*1024});
  return {target,source,run};
}
test('Windows updater stages, checks, backs up and restarts while retaining private data and exact config',{skip:!windows},async t=>{
  const f=await fixture(t),config=await readFile(join(f.target,'config.json'),'utf8');
  const result=await f.run();assert.match(result.stdout,/更新完成/);
  assert.equal(JSON.parse(await readFile(join(f.target,'package.json'))).version,'0.5.0');
  assert.equal(await readFile(join(f.target,'config.json'),'utf8'),config);
  for(const [name,value] of [['credentials.json','PRIVATE_SYNTHETIC_KEEP'],['accounts.json','PRIVATE_ACCOUNTS_KEEP'],['bridge-grants.json','PRIVATE_GRANTS_KEEP']])assert.equal(await readFile(join(f.target,'data',name),'utf8'),value);
  const receipt=JSON.parse(await readFile(join(f.target,'work/last-update.json')));
  assert.equal(JSON.parse(await readFile(join(receipt.backup,'package.json'))).version,'0.4.0');
  assert.equal(JSON.parse(await readFile(join(f.target,'data/state.json'))).running,true);
  assert.ok(!(await readdir(f.source)).includes('node_modules'));
});
test('Windows updater restores old source after candidate startup failure',{skip:!windows},async t=>{
  const f=await fixture(t,{failStart:true});
  await assert.rejects(f.run(),e=>/旧版已恢复/.test(e.stdout));
  assert.equal(JSON.parse(await readFile(join(f.target,'package.json'))).version,'0.4.0');
  assert.equal(JSON.parse(await readFile(join(f.target,'data/state.json'))).running,true);
  assert.equal(await readFile(join(f.target,'data/credentials.json'),'utf8'),'PRIVATE_SYNTHETIC_KEEP');
});
test('Windows updater refuses active calls and rejects failing staged tests before replacing source',{skip:!windows},async t=>{
  const f=await fixture(t,{failTests:true});
  const stateFile=join(f.target,'data/state.json'),state=JSON.parse(await readFile(stateFile));
  await writeFile(stateFile,JSON.stringify({...state,busy:true}));
  await assert.rejects(f.run(),e=>/有请求执行或排队/.test(e.stderr));
  await writeFile(stateFile,JSON.stringify(state));
  await assert.rejects(f.run(),e=>/新版自动测试失败/.test(e.stderr));
  assert.equal(JSON.parse(await readFile(join(f.target,'package.json'))).version,'0.4.0');
  assert.equal(JSON.parse(await readFile(stateFile)).running,true);
});
