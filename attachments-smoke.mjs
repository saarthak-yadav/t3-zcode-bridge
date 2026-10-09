import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync,readFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const bridge=fileURLToPath(new URL('./bridge.mjs',import.meta.url));
const cwd=mkdtempSync(join(tmpdir(),'zcode-t3-test-'));
let permissionAction='allow',permissionCount=0;
function connect(){
 const p=spawn(process.execPath,[bridge,'--permission-mode','default','agent','stdio'],{stdio:['pipe','pipe','pipe']});
 let id=0;const pending=new Map();let text='',toolCalls=0;
 p.stderr.on('data',()=>{});
 const write=x=>p.stdin.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
 createInterface({input:p.stdout}).on('line',l=>{
  const m=JSON.parse(l);
  if(m.method==='session/request_permission'){
   permissionCount++;const o=m.params.options.find(o=>o.kind===(permissionAction==='allow'?'allow_once':'reject_once'));
   write({id:m.id,result:{outcome:o?{outcome:'selected',optionId:o.optionId}:{outcome:'cancelled'}}});
  }else if(m.method==='session/update'){
   const u=m.params.update;if(u.sessionUpdate==='agent_message_chunk')text+=u.content.text;if(u.sessionUpdate==='tool_call')toolCalls++;
  }else if(m.id!==undefined){const q=pending.get(m.id);if(q){pending.delete(m.id);clearTimeout(q.timer);m.error?q.reject(new Error(m.error.message)):q.resolve(m.result);}}
 });
 p.on('exit',()=>{for(const q of pending.values()){clearTimeout(q.timer);q.reject(new Error('Bridge exited'));}});
 function req(method,params){return new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error(method+' timed out'));},90000);pending.set(n,{resolve,reject,timer});write({id:n,method,params});});}
 return {p,req,write,text:()=>text,tools:()=>toolCalls,reset:()=>{text='';toolCalls=0;}};
}
let c=connect();let sessionId;
try {
 const info=await c.req('initialize',{protocolVersion:1,clientCapabilities:{}});
 assert.equal(info.agentCapabilities.promptCapabilities.image,true);
 assert.equal(info.agentCapabilities.promptCapabilities.embeddedContext,true);
 await c.req('authenticate',{methodId:'cached_token'});
 sessionId=(await c.req('session/new',{cwd,mcpServers:[]})).sessionId;
 const image=readFileSync(new URL('./fixtures/vision.png',import.meta.url)).toString('base64');
 await c.req('session/prompt',{sessionId,prompt:[{type:'text',text:'Inspect the attached image. What shapes, colors, and number are shown? Do not guess or create files.'},{type:'image',mimeType:'image/png',data:image}]});
 console.log('IMAGE RESPONSE:',c.text());assert.match(c.text(),/red/i);assert.match(c.text(),/blue/i);assert.match(c.text(),/742/);console.log('PASS image comprehension');
 c.reset();
 await c.req('session/prompt',{sessionId,prompt:[{type:'text',text:'Read both attached resources. Reply with their two verification codes.'},{type:'resource',resource:{uri:'file:///supplied-context.txt',mimeType:'text/plain',text:'The text verification code is TEXT-614.'}},{type:'resource',resource:{uri:'file:///report.pdf',mimeType:'application/pdf',blob:readFileSync(new URL('./fixtures/report.pdf',import.meta.url)).toString('base64')}}]});
 console.log('DOCUMENT RESPONSE:',c.text());assert.match(c.text(),/TEXT-614/);assert.match(c.text(),/PAPER-928/);console.log('PASS embedded text and PDF comprehension');
 c.reset();
 await c.req('session/prompt',{sessionId,prompt:[{type:'text',text:'Read the attached CSV using file tools if needed. Reply with its verification code.'},{type:'resource',resource:{uri:'custom:///data.csv',mimeType:'text/csv',blob:Buffer.from('key,value\nverification,FILE-385\n').toString('base64')}}]});
 console.log('FILE RESPONSE:',c.text());assert.match(c.text(),/FILE-385/);console.log('PASS staged file comprehension');
 console.log(JSON.stringify({cwd,sessionId}));
} finally {c.p.kill();}
