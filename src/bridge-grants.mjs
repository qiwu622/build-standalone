import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {readJSON,atomicJSON} from './storage.mjs';
import {error} from './errors.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
// Only hashes are kept on disk. A grant can reconnect one account/project;
// it never authorizes account creation, API calls, or administration.
export class BridgeGrants {
  constructor(dataDir){this.file=dataDir&&join(dataDir,'bridge-grants.json');this.items=[];this.chain=Promise.resolve();this.ready=this.file?readJSON(this.file,[]).then(v=>{this.items=v;}):Promise.resolve();}
  save(){const snapshot=structuredClone(this.items);this.chain=this.chain.then(()=>this.file?atomicJSON(this.file,snapshot):undefined);return this.chain;}
  async issue(account,origin=''){
    await this.ready;const key=randomBytes(32).toString('hex');
    this.items=this.items.filter(x=>x.accountId!==account.id);
    this.items.push({hash:digest(key),accountId:account.id,email:account.email.toLowerCase(),appURL:account.appURL,origin});
    await this.save();return key;
  }
  async check(key,accounts,origin=''){
    await this.ready;
    const grant=typeof key==='string'&&/^[a-f0-9]{64}$/.test(key)&&this.items.find(x=>x.hash===digest(key)&&x.origin===origin);
    const account=grant&&accounts.find(a=>a.id===grant.accountId&&a.email.toLowerCase()===grant.email&&a.appURL===grant.appURL);
    if(!account)throw error('自动连接授权已失效，请在管理页重新接入一次',401,'resume_invalid');
    if(account.enabled===false)throw error('此账号已停用',409,'account_disabled');
    return account;
  }
  async revoke(id){await this.ready;this.items=this.items.filter(x=>x.accountId!==id);await this.save();}
}
