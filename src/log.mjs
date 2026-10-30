import {appendFile,readFile,stat,rename} from 'node:fs/promises';
import {join} from 'node:path';
const allowed=['event','requestId','model','accountId','status','durationMs','stage','contextMode','thinkingLevel','googleThinkingLevel','upstreamModel','code','cleanupCode','queueMs','message','submitted','method','authUser','planTier','errorCategory'];
export class CallLog {
  constructor(config){this.file=join(config.dataDir,'logs','calls.jsonl');this.chain=Promise.resolve();}
  record(input){
    const row={at:new Date().toISOString()};
    for(const k of allowed)if(['string','number','boolean'].includes(typeof input[k]))row[k]=typeof input[k]==='string'?input[k].slice(0,200):input[k];
    this.chain=this.chain.catch(()=>{}).then(async()=>{
      if((await stat(this.file).catch(()=>({size:0}))).size>2*1024*1024)await rename(this.file,this.file+'.1');
      await appendFile(this.file,JSON.stringify(row)+'\n',{mode:0o600});
    });return this.chain;
  }
  async recent(){await this.chain;try{return (await readFile(this.file,'utf8')).trim().split('\n').slice(-100).reverse().map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
}
