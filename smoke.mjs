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
try{
 const info=await c.req('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'bridge-smoke',version:'1'}});
 assert.equal(info.agentInfo.title,'ZCode');assert.equal(info.agentCapabilities.loadSession,true);
 await c.req('authenticate',{methodId:'cached_token'});
 const created=await c.req('session/new',{cwd,mcpServers:[]});sessionId=created.sessionId;
 let result=await c.req('session/prompt',{sessionId,prompt:[{type:'text',text:'Remember the secret word ORBIT. Reply with exactly ZCODE_BRIDGE_OK. Do not use tools.'}]});
 assert.equal(result.stopReason,'end_turn');assert.match(c.text(),/ZCODE_BRIDGE_OK/);console.log('PASS streaming prompt');
 c.p.kill();c=connect();await c.req('initialize',{protocolVersion:1,clientCapabilities:{}});await c.req('authenticate',{methodId:'cached_token'});await c.req('session/load',{sessionId,cwd,mcpServers:[]});
 await c.req('session/prompt',{sessionId,prompt:[{type:'text',text:'What secret word did I ask you to remember? Reply with the word only. Do not use tools.'}]});
 assert.match(c.text(),/ORBIT/);console.log('PASS process restart and native session resume');
 c.reset();const before=permissionCount;
 await c.req('session/prompt',{sessionId,prompt:[{type:'text',text:'Use Bash to run the exact shell command: printf approved > approved.txt . Then read approved.txt and report its contents. Do not use another tool to create the file.'}]});
 assert.equal(readFileSync(join(cwd,'approved.txt'),'utf8'),'approved');assert.ok(permissionCount>before);assert.ok(c.tools()>0);console.log('PASS tool execution and approval');
 permissionAction='deny';c.reset();const denialBefore=permissionCount;
 await c.req('session/prompt',{sessionId,prompt:[{type:'text',text:'Use Bash to run: printf denied > denied.txt . If permission is denied, stop immediately and say permission denied. Do not try any other tool or command.'}]});
 assert.ok(permissionCount>denialBefore);assert.equal(existsSync(join(cwd,'denied.txt')),false);console.log('PASS permission denial prevents command');
 permissionAction='allow';c.reset();
 const running=c.req('session/prompt',{sessionId,prompt:[{type:'text',text:'Use Bash to run sleep 30 and then say finished.'}]});
 await new Promise(resolve=>setTimeout(resolve,1500));c.write({method:'session/cancel',params:{sessionId}});
 result=await running;assert.equal(result.stopReason,'cancelled');console.log('PASS cancellation');
 console.log(JSON.stringify({cwd,sessionId,permissionCount}));
}finally{c.p.kill();}
