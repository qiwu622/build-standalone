import {createInterface} from 'node:readline/promises';
import {join} from 'node:path';
import {loadConfig,initStorage,AccountStore,acquireLock,readJSON,atomicJSON} from '../src/storage.mjs';
import {BrowserManager} from '../src/browser.mjs';
import {BuildAccountPool} from '../src/build-pool.mjs';
const config=await loadConfig();
process.env.TEMP=process.env.TMP=process.env.TMPDIR=join(config.dataDir,'tmp');
await initStorage(config);const unlock=await acquireLock(config.dataDir);
const store=await new AccountStore(config).load(),browsers=new BrowserManager(config,store);
const readline=createInterface({input:process.stdin,output:process.stdout});
let closed=false;
async function close(){if(closed)return;closed=true;readline.close();await browsers.close();await unlock();}
process.on('SIGINT',()=>void close().finally(()=>process.exit(130)));
process.on('SIGTERM',()=>void close().finally(()=>process.exit(143)));
try {
  const arg=process.argv.indexOf('--account'),id=arg>=0?process.argv[arg+1]:undefined;
  const login=await browsers.beginLogin(id);console.log(login.message);
  console.log('此命令不自动发送生成请求。确认专用项目页面已加载后按 Enter；输入 q 取消。');
  while(!closed){
    const answer=await readline.question('完成登录后按 Enter > ');if(answer.trim().toLowerCase()==='q')break;
    try {
      const account=await browsers.finishLogin(),state=await readJSON(join(config.dataDir,'pool.json'),{});
      const pool=new BuildAccountPool({state,save:()=>atomicJSON(join(config.dataDir,'pool.json'),state)});
      await pool.sync(store.accounts);await pool.imported(account.id);
      console.log('导入完成：'+account.email+' ('+account.id+')；尚未验证模型生成。');break;
    }catch(e){console.error(e.message);if(!browsers.login)break;}
  }
}catch(e){console.error(e.message);process.exitCode=1;}finally{await close();}
