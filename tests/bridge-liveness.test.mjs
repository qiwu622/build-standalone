import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeClient} from '../extensions/build-browser-bridge/client.mjs';

test('a hung Chrome command releases the stale local connection so saved-project recovery can run',async t=>{
 const target='https://aistudio.google.com/apps/test?authuser=0';
 let detached=0,commands=0,exchanges=0;
 const chrome={tabs:{get:async()=>({url:target})},debugger:{sendCommand:()=>{commands++;return new Promise(()=>{});},detach:async()=>{detached++;}}};
 const client=new BridgeClient({chrome});
 const session={tabId:1,base:'http://127.0.0.1:18787',token:'test',email:'test@example.invalid',target,events:[],closed:false};client.links.set(1,session);
 client.post=async(_base,path)=>{
  if(path==='/bridge/disconnect')return {};
  exchanges++;return {commands:[{id:'hung',method:'Runtime.evaluate',params:{expression:'1'},deadline:Date.now()+40}]};
 };
 t.after(()=>client.disconnect(1));
 let timer;
 const finished=await Promise.race([client.loop(session).then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),400);})]);clearTimeout(timer);
 assert.equal(finished,true,'command deadline must also be enforced in the browser connector');
 assert.equal(client.links.size,0);assert.equal(session.closed,true);assert.equal(session.token,'');
 assert.equal(commands,1,'never replay a browser command that may already have run');assert.equal(exchanges,1);assert.equal(detached,1);
 assert.match(client.lastError,/超时|失效/);
});

test('a tab lookup resolving after expiry cannot submit delayed input or another command',async()=>{
 const target='https://aistudio.google.com/apps/test?authuser=0';let resolveTab,sends=0;
 const chrome={tabs:{get:()=>new Promise(r=>{resolveTab=r;})},debugger:{sendCommand:async()=>{sends++;}}};
 const client=new BridgeClient({chrome}),session={tabId:1,target};
 await assert.rejects(client.command(session,{id:'late',method:'Input.insertText',params:{text:'DO_NOT_SEND'},deadline:Date.now()+30}),e=>e.code==='browser_command_timeout');
 resolveTab({url:target});await new Promise(r=>setTimeout(r,0));
 assert.equal(sends,0);
});
