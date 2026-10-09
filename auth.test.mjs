import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readAccounts,saveAccount,hiddenKey} from './auth.mjs';
test('bridge accounts are private and separate; saving preserves the other provider',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zcode-auth-')),path=join(dir,'accounts.json');
 try{
  await saveAccount(path,'zai','fixture-zai-key');await saveAccount(path,'bigmodel','fixture-bigmodel-key');
  assert.equal(readAccounts(path).zai.apiKey,'fixture-zai-key');
  assert.equal((await stat(path)).mode&0o777,0o600);
  await assert.rejects(saveAccount(path,'other','key'));
  await assert.rejects(saveAccount(path,'zai','bad key'));
  assert.equal(readAccounts(path).bigmodel.apiKey,'fixture-bigmodel-key');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('hidden key input does not echo and restores raw mode on success and cancellation',async()=>{
 const input=new PassThrough(),output=new PassThrough();let displayed='';output.on('data',d=>displayed+=d);
 input.isTTY=true;input.isRaw=false;input.setRawMode=value=>input.isRaw=value;
 let result=hiddenKey(input,output);input.write('fixture-secret\x7fX\r');
 assert.equal(await result,'fixture-secreX');assert.equal(input.isRaw,false);assert.doesNotMatch(displayed,/fixture/);
 result=hiddenKey(input,output);input.write('\x03');await assert.rejects(result,/cancelled/);assert.equal(input.isRaw,false);
});
test('fresh-home ACP initialization advertises terminal auth without ZCode or account',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zcode-fresh-'));
 const child=spawn(process.execPath,[new URL('./bridge.mjs',import.meta.url).pathname,'--acp'],{env:{...process.env,ZCODE_DATA_BASE_DIR:dir,ZCODE_RESOURCES:join(dir,'missing')},stdio:['pipe','pipe','pipe']});
 const responses=[];const pending=new Map();const rl=createInterface({input:child.stdout});
 rl.on('line',l=>{const m=JSON.parse(l);responses.push(m);pending.get(m.id)?.(m);});
 const request=(id,method,params={})=>new Promise(resolve=>{pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const timeout=setTimeout(()=>child.kill(),3000);
 try{
  const initialized=await request(1,'initialize',{protocolVersion:1});
  assert.equal(initialized.result.protocolVersion,1);assert.equal(initialized.result.authMethods[0].type,'terminal');
  const auth=await request(2,'authenticate',{methodId:'terminal_setup'});
  assert.equal(auth.error.code,-32000);assert.equal(auth.error.data.authMethods[0].args[0],'--setup');
 }finally{clearTimeout(timeout);child.stdin.end();child.kill();await rm(dir,{recursive:true,force:true});}
});
