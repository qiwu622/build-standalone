import {readFile,writeFile,mkdir,rename,lstat,open,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {error} from './errors.mjs';

export const projectRoot = fileURLToPath(new URL('../',import.meta.url));
export async function readJSON(file,fallback) {
  try { return JSON.parse(await readFile(file,'utf8')); }
  catch(e) { if(e.code==='ENOENT')return fallback; throw e; }
}
export async function atomicJSON(file,value) {
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  try { await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'}); await rename(temp,file); }
  finally { await rm(temp,{force:true}); }
}
export async function loadConfig({file=process.env.BUILD_CONFIG||join(projectRoot,'config.json'),overrides={}}={}) {
  const raw=await readJSON(file,{});
  const config={host:'127.0.0.1',port:8787,publicOrigin:'',dataDir:'./data',browserPath:'',headless:true,requestTimeoutMs:0,queueTimeoutMs:0,streamHeartbeatMs:15000,maxQueue:8,maxBodyBytes:8*1024*1024,...raw,...overrides};
  config.dataDir=resolve(projectRoot,config.dataDir);
  if(!Number.isInteger(config.port)||config.port<0||config.port>65535)throw error('port 必须为 0–65535');
  for(const key of ['requestTimeoutMs','queueTimeoutMs'])if(!Number.isInteger(config[key])||config[key]<0||config[key]>2147483647)throw error(key+' 必须为非负毫秒数；0 表示不限制');
  if(!Number.isInteger(config.streamHeartbeatMs)||config.streamHeartbeatMs<10||config.streamHeartbeatMs>60000)throw error('streamHeartbeatMs 无效');
  if(!Number.isInteger(config.maxBodyBytes)||config.maxBodyBytes<1024||config.maxBodyBytes>16*1024*1024)throw error('maxBodyBytes 无效');
  if(!Number.isInteger(config.maxQueue)||config.maxQueue<0||config.maxQueue>100)throw error('maxQueue 无效');
  if(typeof config.headless!=='boolean')throw error('headless 必须为布尔值');
  if(config.publicOrigin){const u=new URL(config.publicOrigin);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.origin!==config.publicOrigin)throw error('publicOrigin 必须为不带路径的 HTTP(S) Origin');}
  if(config.browserPath&&!isAbsolute(config.browserPath))throw error('browserPath 必须为绝对路径');
  return config;
}
export async function initStorage(config) {
  await mkdir(config.dataDir,{recursive:true,mode:0o700});
  if((await lstat(config.dataDir)).isSymbolicLink())throw error('数据目录不能是符号链接');
  for(const dir of ['profiles','context','tmp','logs'])await mkdir(join(config.dataDir,dir),{recursive:true,mode:0o700});
  const file=join(config.dataDir,'credentials.json');
  let credentials=await readJSON(file,null);
  if(!credentials) {
    credentials={apiKey:'build_'+randomBytes(32).toString('hex'),adminKey:'admin_'+randomBytes(32).toString('hex')};
    try { await writeFile(file,JSON.stringify(credentials,null,2)+'\n',{mode:0o600,flag:'wx'}); }
    catch(e){if(e.code!=='EEXIST')throw e;credentials=await readJSON(file,null);}
  }
  if(!credentials||['apiKey','adminKey'].some(k=>typeof credentials[k]!=='string'||credentials[k].length<32)||credentials.apiKey===credentials.adminKey)throw error('credentials.json 无效，请修复独立凭据文件');
  return credentials;
}
export async function acquireLock(dataDir) {
  const file=join(dataDir,'service.lock');
  let handle;const instanceId=randomUUID();
  try {handle=await open(file,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,instanceId}));}
  catch(e){if(e.code==='EEXIST')throw error('数据目录已有服务锁；确认旧进程已退出后才能手动移除 service.lock',409);throw e;}
  const release=async()=>{await handle.close();await rm(file,{force:true});};release.instanceId=instanceId;return release;
}
export async function recoverDeadServiceLock(dataDir,{alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}}={}){
  const file=join(dataDir,'service.lock'),lock=await readJSON(file,null);
  if(!lock)return false;
  if(!Number.isSafeInteger(lock.pid)||lock.pid<1||typeof lock.instanceId!=='string')throw error('服务锁格式无效，请检查 service.lock');
  if(alive(lock.pid))return false;
  // Serialize recovery attempts, then recheck before removing only a dead lock.
  const guard=await open(join(dataDir,'service-recovery.lock'),'wx',0o600);
  try{
    const current=await readJSON(file,null);
    if(current?.instanceId===lock.instanceId&&current.pid===lock.pid&&!alive(current.pid)){
      await rename(file,join(dataDir,'service-stale-'+randomUUID()+'.json'));return true;
    }
    return false;
  }finally{await guard.close();await rm(join(dataDir,'service-recovery.lock'),{force:true});}
}
export async function profilePath(config,id) {
  if(!/^acct_[a-f0-9]{32}$/.test(id))throw error('无效账号 ID');
  const base=join(config.dataDir,'profiles'),target=join(base,id),rel=relative(base,target);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw error('资料路径越界');
  await mkdir(target,{recursive:true,mode:0o700});
  for(const dir of [base,target])if((await lstat(dir)).isSymbolicLink())throw error('浏览器资料目录不能是符号链接');
  return target;
}
export class AccountStore {
  constructor(config){this.file=join(config.dataDir,'accounts.json');this.accounts=[];this.chain=Promise.resolve();}
  async load(){this.accounts=await readJSON(this.file,[]);if(!Array.isArray(this.accounts))throw error('accounts.json 无效');return this;}
  async save(){const snapshot=structuredClone(this.accounts);this.chain=this.chain.catch(()=>{}).then(()=>atomicJSON(this.file,snapshot));return this.chain;}
  async add({email,appURL,id='acct_'+randomBytes(16).toString('hex'),authUser='0',transport}) {
    if(this.accounts.some(a=>a.email.toLowerCase()===email.toLowerCase()&&a.id!==id))throw error('该 Google 账号已导入，请使用重新登录',409);
    const account={id,email,name:email,auth_user:authUser,appURL,enabled:true,...(transport?{transport}:{})};
    const index=this.accounts.findIndex(a=>a.id===id);
    if(index<0)this.accounts.push(account);else this.accounts[index]=account;
    await this.save();return account;
  }
  async enabled(id,value){const a=this.accounts.find(a=>a.id===id);if(!a)throw error('账号不存在',404);a.enabled=value;await this.save();}
}
