import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionResult, convertMcp } from './bridge.mjs';
test('permission choices preserve native response; cancellation denies',()=>{
 const options=[{optionId:'once',response:{decision:'allow'}},{optionId:'deny',response:{decision:'deny',reason:'No'}}];
 assert.deepEqual(permissionResult(options,{outcome:'selected',optionId:'deny'}),options[1].response);
 assert.deepEqual(permissionResult(options,{outcome:'selected',optionId:'once'}),options[0].response);
 assert.equal(permissionResult(options,{outcome:'cancelled'}).decision,'deny');
 assert.throws(()=>permissionResult(options,{outcome:'selected',optionId:'invented'}));
});
test('MCP bridge retains transport and credentials while enforcing session isolation',()=>{
 assert.deepEqual(convertMcp([{name:'t3',type:'http',url:'http://localhost/mcp',headers:[{name:'Authorization',value:'test-token'}]}]),[{name:'t3',type:'http',url:'http://localhost/mcp',headers:[{name:'Authorization',value:'test-token'}],isolation:'session'}]);
 assert.deepEqual(convertMcp([{name:'local',command:'node',args:['server.mjs'],env:[]}])[0].args,['server.mjs']);
});
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const bridgePath=new URL('./bridge.mjs',import.meta.url);
test('ACP process terminates when its client disconnects',async()=>{
 const child=spawn(process.execPath,[bridgePath.pathname],{stdio:['pipe','pipe','pipe']});
 const exited=once(child,'exit');
 child.stdin.end();
 const timeout=setTimeout(()=>child.kill('SIGKILL'),2000);
 try {const [code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);}finally{clearTimeout(timeout);}
});
test('an unsupported CLI probe exits instead of waiting on ACP stdin',async()=>{
 const child=spawn(process.execPath,[bridgePath.pathname,'unsupported-probe'],{stdio:['pipe','pipe','pipe']});
 const exited=once(child,'exit');
 const timeout=setTimeout(()=>child.kill('SIGKILL'),2000);
 try {const [code,signal]=await exited;assert.equal(code,1);assert.equal(signal,null);}finally{clearTimeout(timeout);}
});
test('generic and legacy version probes work through an executable symlink',async()=>{
 const {mkdtemp,symlink,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {execFile}=await import('node:child_process');
 const {promisify}=await import('node:util');
 const dir=await mkdtemp(join(tmpdir(),'zcode-bin-'));
 try {
  const executable=join(dir,'zcode-acp');await symlink(bridgePath.pathname,executable);
  const run=promisify(execFile);
  assert.match((await run(process.execPath,[executable,'--version'])).stdout,/0\.3\.0/);
  assert.match((await run(process.execPath,[executable,'--legacy-grok','--version'])).stdout,/legacy Grok/);
  assert.match((await run(process.execPath,[executable,'--help'])).stdout,/Usage:/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
