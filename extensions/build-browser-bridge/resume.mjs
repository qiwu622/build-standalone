import {localBase,project} from './protocol.mjs';

export class ResumeConnections {
  constructor({chrome,client,now=Date.now}){Object.assign(this,{chrome,client,now});this.running=null;this.delays=new Map();this.notices=[];this.writes=Promise.resolve();}
  async entries(){const v=await this.chrome.storage.local.get('buildConnections');return v.buildConnections||[];}
  edit(fn){this.writes=this.writes.catch(()=>{}).then(async()=>{const items=await this.entries();await this.chrome.storage.local.set({buildConnections:fn(items)});});return this.writes;}
  remember(item){if(!item.resumeKey)return;return this.edit(items=>[...items.filter(x=>x.base!==item.base||x.email.toLowerCase()!==item.email.toLowerCase()),item]);}
  forget(base,email){return this.edit(items=>items.filter(x=>x.base!==base||x.email.toLowerCase()!==email.toLowerCase()));}
  restore(base,options={}){
    if(this.running)return this.running;
    this.running=this.run(base,options).finally(()=>{this.running=null;});return this.running;
  }
  async run(base,{force=false}={}){
    const entries=await this.entries();this.notices=[];
    for(const saved of entries){
      if(base&&saved.base!==base)continue;
      const id=saved.base+'|'+saved.email.toLowerCase();
      if([...this.client.links.values()].some(s=>s.base===saved.base&&s.email.toLowerCase()===saved.email.toLowerCase()))continue;
      if(!force&&(this.delays.get(id)||0)>this.now())continue;
      try{
        localBase(saved.base);const target=project(saved.target);
        const state=await this.client.post(saved.base,'/bridge/resume-check',{resumeKey:saved.resumeKey});
        if(state.connected)continue;
        if(state.account.email.toLowerCase()!==saved.email.toLowerCase()||project(state.account.appURL).url!==target.url)throw new Error('保存的账号或项目发生变化，请重新接入');
        const tabs=await this.chrome.tabs.query({url:['https://aistudio.google.com/*','https://ai.studio/*']});
        let tab=tabs.find(t=>{try{return project(t.url).url===target.url;}catch{return false;}});
        if(!tab)tab=await this.chrome.tabs.create({url:target.url+'&hl=en',active:false});
        await this.client.connect({base:saved.base,resumeKey:saved.resumeKey,tabId:tab.id,expectedEmail:saved.email});
        this.delays.delete(id);this.notices.push({email:saved.email,message:'已自动恢复专用项目连接'});
      }catch(e){
        this.delays.set(id,this.now()+60000);
        if(e.code==='resume_invalid')await this.forget(saved.base,saved.email);
        this.notices.push({email:saved.email,message:e.message});
      }
    }
    return {saved:entries.length,notices:this.notices};
  }
}
