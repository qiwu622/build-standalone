import {spawn} from 'node:child_process';
import {open,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {loadConfig,initStorage,readJSON,projectRoot} from '../src/storage.mjs';

const command=process.argv[2],demo=process.argv.includes('--demo');
if(!['start','stop','status'].includes(command))throw new Error('用法：node scripts/control.mjs start|stop|status [--demo]');
const config=await loadConfig({overrides:demo?{dataDir:'./demo-data'}:{}});
if(config.port===0)throw new Error('后台管理需要配置固定端口，不能使用 0');
const host=['0.0.0.0','::'].includes(config.host)?'127.0.0.1':config.host;
const base=`http://${host.includes(':')?'['+host+']':host}:${config.port}`;
async function status() {
  const lock=await readJSON(join(config.dataDir,'service.lock'),null);
  if(!lock)return null;
  const credentials=await readJSON(join(config.dataDir,'credentials.json'),null);
  if(!credentials)throw new Error('服务锁存在但缺少凭据，拒绝操作');
  const res=await fetch(base+'/admin/state',{headers:{authorization:'Bearer '+credentials.adminKey},signal:AbortSignal.timeout(2500)});
  if(!res.ok)throw new Error('该端口未通过本实例鉴权，拒绝操作');
  const state=await res.json();if(state.instanceId!==lock.instanceId)throw new Error('端口与数据目录中的实例不一致，拒绝操作');
  return {state,lock,credentials};
}
if(command==='status') {
  const value=await status();console.log(value?JSON.stringify({running:true,mode:value.state.mode,busy:value.state.busy,queued:value.state.queued,url:base}):'服务未运行');
}else if(command==='stop') {
  const value=await status();
  if(!value){console.log('服务未运行');process.exit(0);}
  const res=await fetch(base+'/admin/control/stop',{method:'POST',headers:{authorization:'Bearer '+value.credentials.adminKey,'content-type':'application/json'},body:JSON.stringify({instanceId:value.lock.instanceId}),signal:AbortSignal.timeout(3000)});
  if(!res.ok)throw new Error('服务拒绝停止请求');
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){if(!await readJSON(join(config.dataDir,'service.lock'),null)){console.log('本实例已停止');process.exit(0);}await new Promise(r=>setTimeout(r,200));}
  throw new Error('停止尚未完成；请检查本实例日志。没有按 PID 强杀进程。');
}else {
  if(await readJSON(join(config.dataDir,'service.lock'),null)){const value=await status();console.log('本实例已运行：'+base);process.exit(0);}
  await initStorage(config);await mkdir(join(config.dataDir,'logs'),{recursive:true});
  const output=await open(join(config.dataDir,'logs','service.log'),'a',0o600);
  const child=spawn(process.execPath,[join(projectRoot,'src','main.mjs'),...(demo?['--demo']:[])],{cwd:projectRoot,detached:true,windowsHide:true,stdio:['ignore',output.fd,output.fd],env:{...process.env,TMP:join(config.dataDir,'tmp'),TEMP:join(config.dataDir,'tmp'),TMPDIR:join(config.dataDir,'tmp')}});
  let spawnError;child.on('error',e=>{spawnError=e;});child.unref();await output.close();
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(spawnError)throw spawnError;try{if(await status()){console.log('本实例已启动：'+base);process.exit(0);}}catch{}await new Promise(r=>setTimeout(r,200));}
  throw new Error('启动未确认，请查看本实例 data/logs/service.log');
}
