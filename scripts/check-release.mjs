import {readdir,readFile,lstat} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

export const releaseEntries=['src','public','scripts','tests','extensions','docs','licenses','install.cmd','start.cmd','update.cmd','package.json','package-lock.json','manifest.json','config.example.json','README.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore'];
const forbiddenPath=/(?:^|\/)(?:node_modules|data|private|diagnostics|\.git|\.env(?:\..*)?|config\.json|accounts\.json|credentials\.json|cookies?\.json|pool-state\.json|browser-profile[^/]*|_bg_disasm|pool-share[^/]*|native-cache[^/]*|botguard[^/]*|waa[^/]*|proof-server[^/]*|[^/]+\.(?:pem|key|pfx|p12|wasm|node|exe|dll|bin|heapsnapshot|zip|tgz|log|jsonl))(?:\/|$)/i;
const secrets=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,/\bAIza[A-Za-z0-9_-]{30,}\b/,/(?:__Secure-1PSID(?:TS)?|SAPISID)\s*[=:]\s*["']?[A-Za-z0-9_./=-]{30,}/];
export async function auditRelease(root){
 root=resolve(root);const paths=[],failures=[];
 async function walk(path){
  const name=relative(root,path).replaceAll('\\','/'),stat=await lstat(path);
  if(stat.isSymbolicLink()||forbiddenPath.test(name)){failures.push(name+': forbidden release path');return;}
  if(stat.isDirectory()){for(const entry of await readdir(path))await walk(join(path,entry));return;}
  if(!stat.isFile()||stat.size>2*1024*1024){failures.push(name+': unexpected artifact');return;}
  const bytes=await readFile(path);if(bytes.includes(0)){failures.push(name+': binary file');return;}
  const text=bytes.toString('utf8');if(secrets.some(pattern=>pattern.test(text)))failures.push(name+': credential-like material');
  paths.push(name);
 }
 for(const entry of releaseEntries)await walk(join(root,entry));
 if(failures.length)throw new Error(failures.join('\n'));
 return {files:paths.length,paths:paths.sort(),googleCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await auditRelease(process.argv[2]||fileURLToPath(new URL('..',import.meta.url)));
 console.log(JSON.stringify({files:result.files,status:'passed',googleCalls:0}));
}
