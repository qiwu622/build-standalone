import {join} from 'node:path';
import {loadConfig,initStorage,readJSON,atomicJSON,AccountStore,acquireLock} from './storage.mjs';
import {BuildAccountPool} from './build-pool.mjs';
import {ExtensionBridge} from './extension-bridge.mjs';
import {BuildExecutor,DemoExecutor} from './executor.mjs';
import {CallLog} from './log.mjs';
import {createService} from './server.mjs';

const demo=process.argv.includes('--demo');
const config=await loadConfig({overrides:demo?{dataDir:'./demo-data'}:{}});
// All runtime temporary writes stay in this instance's configured data tree.
process.env.TEMP=process.env.TMP=process.env.TMPDIR=join(config.dataDir,'tmp');
const credentials=await initStorage(config);
if(process.argv.includes('--init')){console.log('初始化完成；独立凭据文件：'+join(config.dataDir,'credentials.json'));process.exit(0);}
const unlock=await acquireLock(config.dataDir);
let service,stopping=false,writes=Promise.resolve();
const stop=async()=>{if(stopping)return;stopping=true;try{await service?.close();await writes;}finally{await unlock();process.exit(0);}};
try {
  const store=await new AccountStore(config).load(),log=new CallLog(config);
  const state=await readJSON(join(config.dataDir,'pool.json'),{});
  const pool=new BuildAccountPool({state,save:()=>{const snapshot=structuredClone(state);writes=writes.catch(()=>{}).then(()=>atomicJSON(join(config.dataDir,'pool.json'),snapshot));return writes;}});
  await pool.sync(store.accounts);
  const browsers=new ExtensionBridge({store,pool});
  const executor=demo?new DemoExecutor():new BuildExecutor({config,browsers,pool,store,log});
  service=createService({config,credentials,store,pool,browsers,executor,log,demo,instanceId:unlock.instanceId,onShutdown:stop});
  await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(config.port,config.host,resolve);});
  const address=service.server.address();
  console.log(`Build Standalone [${demo?'DEMO：不会调用 Google':'LIVE：请单独完成本机 Google 验收'}] http://${config.host}:${address.port}`);
  console.log('凭据保存在 '+join(config.dataDir,'credentials.json')+'；不要公开此文件。Ctrl+C 停止。');
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}catch(e){await service?.close().catch(()=>{});await unlock();console.error(e.message);process.exitCode=1;}
