import {randomBytes} from 'node:crypto';
import {AppError} from './errors.mjs';
import {documentNamePattern} from '../extensions/build-browser-bridge/document-reader.mjs';

export function documentOutput(nonce=randomBytes(12).toString('hex')){
  const name=`__bridge_reply_${nonce}.txt`;
  if(!documentNamePattern.test(name))throw new Error('Invalid output document name');
  return {name,instruction:`Output delivery: write the complete answer into the UTF-8 project file ${name} using Build's file-writing tool. The file body is the API reply: preserve the requested text, Markdown, JSON, whitespace and external-client tool protocol exactly. Do not summarize, add a receipt, or put the answer only in chat. Only this output file may be created or edited. Do not run commands, install packages, search, deploy, or execute external-client tools. When client tools are requested, write their protocol as text for that client to execute. Finish after saving the complete document; no verification code is required. The attachment and inline preset still define the conversation and answer content.`};
}

export class BuildDocumentOutput {
  constructor(worker){this.worker=worker;}
  async prepare(send,sid,document){
    // Dedicated connector command also rejects old extensions BEFORE generation.
    await send('Build.beginDocument',{name:document.name},sid);
    if(!this.worker.contextTransport)throw new AppError('抗截断需要项目文件管理器',502,'document_transport_missing');
    await this.clear(send,sid,{cancel:true});
  }
  async clear(send,sid,{cancel=false}={}){
    return this.worker.contextTransport.clear(send,sid,{cancel,allowDirty:false,managedPattern:documentNamePattern});
  }
  async read(send,sid,document){
    this.worker.aborted(this.worker.current);
    const result=await send('Build.readDocument',{name:document.name},sid);
    if(result.pending)return null;
    if(typeof result.text!=='string'||!result.text.trim())throw new AppError('Google 没有写入完整回复文档；未自动重发',502,'document_output_missing');
    return result.text;
  }
}
