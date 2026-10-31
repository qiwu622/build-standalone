import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {projectRoot,loadConfig,initStorage,AccountStore} from '../src/storage.mjs';
import {BuildAccountPool} from '../src/build-pool.mjs';
import {CallLog} from '../src/log.mjs';
import {createService} from '../src/server.mjs';
import {DemoExecutor} from '../src/executor.mjs';
export async function tempDir(t,beforeRemove=async()=>{}){
  const base=join(projectRoot,'work','tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'case-'));
  t.after(async()=>{await beforeRemove();const rel=relative(base,dir);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Unsafe test cleanup');await rm(dir,{recursive:true,force:true,maxRetries:5});});return dir;
}
export async function fixture(t,{executor=new DemoExecutor(),...overrides}={}){
  let service;const dataDir=await tempDir(t,()=>service?.close()),config=await loadConfig({file:join(dataDir,'config.json'),overrides:{dataDir,port:0,requestTimeoutMs:2000,...overrides}});
  const credentials=await initStorage(config),store=await new AccountStore(config).load(),pool=new BuildAccountPool(),log=new CallLog(config);
  service=createService({config,credentials,store,pool,log,executor,demo:true});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+service.server.address().port;
  const call=(path,body,{key=credentials.apiKey,headers={}}={})=>fetch(url+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+key,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {config,credentials,store,pool,log,service,url,call};
}
export const body={model:'gemini-4-argon-low',messages:[{role:'system',content:'system'},{role:'user',content:'测试你好 😀'}]};
