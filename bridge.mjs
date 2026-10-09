#!/usr/bin/env node
import { readAccounts, setup } from './auth.mjs';
import { convertPrompt } from './content.mjs';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const resources = process.env.ZCODE_RESOURCES || '/Applications/ZCode.app/Contents/Resources';
const builtinPath = resolve(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || `${resources}/config/provider/zcode-builtin.json`);
const userRoot = `${process.env.ZCODE_DATA_BASE_DIR || homedir()}/.zcode/v2`;
const legacyPath = process.env.ZCODE_BRIDGE_ACCOUNT_CONFIG || `${userRoot}/config.json`;
const bridgeAccountPath = process.env.ZCODE_BRIDGE_CREDENTIALS_FILE || `${userRoot}/t3-bridge-account.json`;
const authMethods = [{id:'terminal_setup',name:'Configure Coding Plan API key',type:'terminal',args:['--setup']}];
const cliPath = process.env.ZCODE_CLI_PATH || `${resources}/glm/zcode.cjs`;
const modes = ['build', 'edit', 'auto', 'yolo', 'plan'].map(id => ({id, name: ({build:'Supervised',edit:'Accept edits',auto:'Auto',yolo:'Full access',plan:'Plan'})[id]}));

// Read existing account configuration on demand. Credentials never enter ACP or logs.
function accounts() {
  const legacy = existsSync(legacyPath)?JSON.parse(readFileSync(legacyPath, 'utf8')):{};
  const release = existsSync(builtinPath)?JSON.parse(readFileSync(builtinPath, 'utf8')):{config:{providerConfigRules:{providerRules:[]}}};
  const own=readAccounts(bridgeAccountPath);
  const found = [];
  for (const family of ['zai', 'bigmodel']) {
    const source = own[family]?.apiKey?{enabled:true,options:own[family]}:legacy.provider?.[`builtin:${family}-coding-plan`];
    if (!source?.enabled || !source.options?.apiKey) continue;
    const providerId = `account:${family}-individual-coding-plan`;
    const rule = release.config.providerConfigRules.providerRules.find(x => x.providerId === providerId);
    if (rule) found.push({providerId, apiKey:source.options.apiKey, modelIds:rule.config.builtinModelIds, name:rule.providerName});
  }
  return {release, found};
}
function requireAccount() {
  if(!accounts().found.length){const e=new Error('Coding Plan authentication required. Run zcode-acp --setup.');e.code=-32000;e.data={authMethods};throw e;}
}
function modelCatalog() {
  const {release,found}=accounts();
  const available=found.length?found:release.config.providerConfigRules.providerRules.filter(r=>['account:zai-individual-coding-plan','account:bigmodel-individual-coding-plan'].includes(r.providerId)).map(r=>({providerId:r.providerId,modelIds:r.config.builtinModelIds,name:r.providerName}));
  return available.flatMap(a => a.modelIds.map(modelId => ({modelId:`${a.providerId}/${modelId}`,name:modelId,description:a.name}))); 
}
function defaultModel() {
  const models = modelCatalog();
  if (!models.length) throw new Error('No ZCode models discovered. Install ZCode Desktop or configure its resource paths.');
  return models.find(m => m.modelId.endsWith('/GLM-5.3-Flash'))?.modelId || models[0].modelId;
}
export function selection(modelId, reasoningLevel='high') {
  const models = modelCatalog();
  const target = modelId === 'grok-build' ? defaultModel() : modelId;
  if (!models.some(m => m.modelId === target)) throw new Error(`Model is not available in ZCode: ${target}`);
  const split = target.indexOf('/');
  return {providerId:target.slice(0,split),modelId:target.slice(split+1),options:{reasoningLevel}};
}
export function convertMcp(servers=[]) {
  return servers.map(s => s.type === 'http' || s.type === 'sse'
    ? {name:s.name,type:s.type,url:s.url,headers:s.headers || [],isolation:'session'}
    : {name:s.name,command:s.command,args:s.args || [],env:s.env || [],isolation:'session'});
}
export function permissionResult(options, outcome) {
  if (outcome?.outcome === 'selected') {
    const chosen = options.find(o => o.optionId === outcome.optionId);
    if (!chosen) throw new Error('Unknown permission option returned by ACP client');
    return chosen.response;
  }
  return {decision:'deny',reason:'Cancelled by ACP client'};
}
function kind(name='') {
  if (/bash|shell|exec/i.test(name)) return 'execute';
  if (/write|edit|patch/i.test(name)) return 'edit';
  if (/read|glob|grep|search/i.test(name)) return 'read';
  if (/fetch|browse/i.test(name)) return 'fetch';
  return 'other';
}
export class Bridge {
  constructor({input=process.stdin, output=process.stdout, error=process.stderr, argv=process.argv.slice(2)}={}) {
    this.output=output;this.error=error;this.argv=argv;this.sessions=new Map();this.pending=new Map();this.clientPending=new Map();this.nextId=0;this.closed=false;
    this.input=input;
  }
  emit(m) { if (!this.closed) this.output.write(`${JSON.stringify({jsonrpc:'2.0',...m})}\n`); }
  update(sessionId, update) { this.emit({method:'session/update',params:{sessionId,update}}); }
  clientRequest(method,params) {
    const id=`bridge-${++this.nextId}`;
    return new Promise((resolve,reject) => {this.clientPending.set(id,{resolve,reject});this.emit({id,method,params});});
  }
  request(method,params) {
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`ZCode ${method} timed out`));},120000);
      this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(`${JSON.stringify({id,method,params})}\n`);
    });
  }
  async startChild(cwd) {
    if (this.child) return;
    requireAccount();
    if (!existsSync(cliPath)) throw new Error(`ZCode CLI not found: ${cliPath}`);
    let version;
    try {version=(await promisify(execFile)(process.execPath,[cliPath,'--version'],{timeout:10000})).stdout;}
    catch {throw new Error('Could not check ZCode CLI version');}
    if(!/\b0\.16\.9\b/.test(version))throw new Error('This bridge supports ZCode CLI 0.16.9. Other versions require compatibility verification.');
    this.child=spawn(process.execPath,[cliPath,'app-server','--stdio'],{cwd,env:{...process.env,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:builtinPath,ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:`${userRoot}/provider_config.json`},stdio:['pipe','pipe','pipe']});
    // Native diagnostics can contain request headers. Do not forward them to T3.
    this.child.stderr.on('data',()=>{});
    this.child.on('error', e=>this.fail(e));
    this.child.on('exit',()=>{if(!this.closed)this.fail(new Error('ZCode app-server exited'));});
    createInterface({input:this.child.stdout}).on('line',line=>{
      try { const m=JSON.parse(line);void this.receiveNative(m).catch(e=>this.fail(e)); }
      catch { this.fail(new Error('Invalid JSON from ZCode app-server')); }
    });
    const {release,found}=accounts();
    if (!found.length) throw new Error('No enabled ZCode Coding Plan account');
    const revision=`zcode-builtin:${release.revision}:${createHash('sha256').update(builtinPath).digest('hex')}`;
    await this.request('provider/updateAccountConfig',{revision:`t3-bridge-${randomUUID()}`,basedOnZCodeBuiltinRevision:revision,
      providers:Object.fromEntries(found.map(a=>[a.providerId,{access:{type:'zhipu-account',entitled:true}}])),
      states:Object.fromEntries(found.map(a=>[a.providerId,{availability:'available',entitled:true,current:true}]))});
  }
  async receiveNative(m) {
    if (m.method && m.id !== undefined) {
      try {
        const result=await this.nativeRequest(m.method,m.params);
        this.child.stdin.write(`${JSON.stringify({id:m.id,result})}\n`);
      } catch(e) { this.child.stdin.write(`${JSON.stringify({id:m.id,error:{code:-32603,message:e.message}})}\n`); }
    } else if (m.id !== undefined) {
      const p=this.pending.get(m.id);if(!p)return;
      this.pending.delete(m.id);clearTimeout(p.timer);
      m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);
    } else if (m.method === 'session/event') this.nativeEvent(m.params);
  }
  async nativeRequest(method,p) {
    if(method==='session/requestRuntimePreferences') return {nativeSearchEnhancementsEnabled:true,memoryEnabled:false,askUserQuestionAutoResolutionEnabled:false};
    if(method==='interaction/requestProviderRuntimeHeaders') {
      const account=accounts().found.find(a=>a.providerId===p.providerId);
      return account?{headersApplied:true,requestAuth:{apiKey:account.apiKey}}:{headersApplied:false,errorMessage:'ZCode account is disconnected'};
    }
    if(method==='interaction/requestPermission') {
      const result=await this.clientRequest('session/request_permission',{
        sessionId:p.sessionId,toolCall:{toolCallId:p.toolCallId,title:p.toolName,status:'pending',kind:kind(p.toolName),rawInput:p.input},
        options:p.options.map(o=>({optionId:o.optionId,name:o.name,kind:['allow_once','allow_always','reject_once','reject_always'].includes(o.kind)?o.kind:(o.response.decision==='allow'?'allow_once':'reject_once')}))});
      return permissionResult(p.options,result.outcome);
    }
    // AskUserQuestion needs the richer elicitation protocol supported by newer clients.
    // Decline explicitly rather than silently inventing an answer.
    if(method==='interaction/requestUserInput') {
      this.update(p.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:`\nZCode needs your input: ${p.prompt || p.questions?.map(q=>q.question).join('\n') || 'Please reply in the next message.'}\n`}});
      return {action:'decline',reason:'Please ask the user in conversation; this bridge does not implement structured elicitation.'};
    }
    if(method==='interaction/requestOfficialMcpAuthHeaders') return {headersApplied:false,errorMessage:'Official MCP account authentication is not supported by this bridge'};
    throw new Error(`Unsupported ZCode host request: ${method}`);
  }
  nativeEvent(e) {
    const s=this.sessions.get(e.sessionId);if(!s)return;
    const p=e.payload || {};
    if(!s.active)return;
    if(e.type==='model.streaming' && p.delta) {
      if(p.kind==='text_delta'){s.text+=p.delta;this.update(e.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:p.delta}});}
      else if(p.kind==='reasoning_delta')this.update(e.sessionId,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:p.delta}});
    }
    if(e.type==='tool.updated' && p.toolCallId) {
      const previous=s.tools.get(p.toolCallId);
      if(p.kind==='scheduled') {
        s.tools.set(p.toolCallId,p);
        this.update(e.sessionId,{sessionUpdate:'tool_call',toolCallId:p.toolCallId,title:p.toolName,status:'pending',kind:kind(p.toolName),rawInput:p.input});
      } else if(p.kind==='started' || p.kind==='result' || p.kind==='error') {
        if(!previous){s.tools.set(p.toolCallId,p);this.update(e.sessionId,{sessionUpdate:'tool_call',toolCallId:p.toolCallId,title:p.toolName||'ZCode tool',status:'pending',kind:kind(p.toolName)});}
        const rawOutput=p.result || p.error;
        this.update(e.sessionId,{sessionUpdate:'tool_call_update',toolCallId:p.toolCallId,status:p.kind==='started'?'in_progress':p.kind==='error'||p.result?.isError?'failed':'completed',...(rawOutput?{rawOutput,content:[{type:'content',content:{type:'text',text:typeof rawOutput==='string'?rawOutput:JSON.stringify(rawOutput)}}]}:{})});
      }
    }
    if(e.type==='turn.completed'||e.type==='turn.failed') {
      // Input IDs prevent late background turns from settling a newer prompt.
      if(p.inputId && p.inputId!==s.inputId)return;
      const active=s.active;s.active=null;
      if(e.type==='turn.failed')active.reject(new Error(p.error?.underlyingErrorMessage || p.error?.message || 'ZCode turn failed'));
      else {
        if(!s.text && p.response)this.update(e.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:p.response}});
        active.resolve({stopReason:p.resultType==='cancelled'?'cancelled':'end_turn'});
      }
    }
  }
  setup(s) {
    return {models:{currentModelId:s.modelId,availableModels:modelCatalog()},modes:{currentModeId:s.mode,availableModes:modes},_meta:{t3SessionLoadReady:'replay_idle'}};
  }
  launchMode() {
    if(this.argv.includes('--always-approve'))return 'yolo';
    const value=this.argv[this.argv.indexOf('--permission-mode')+1];
    return ({acceptEdits:'edit',auto:'auto',default:'build'})[value] || 'build';
  }
  session(id) {const s=this.sessions.get(id);if(!s)throw new Error(`Unknown ZCode session: ${id}`);return s;}
  async handle(method,p={}) {
    if(method==='initialize') {
      const models=modelCatalog();
      return {protocolVersion:1,agentInfo:{name:'zcode-t3-bridge',title:'ZCode',version:'0.3.0'},authMethods:this.argv.includes('--legacy-grok')?[{id:'cached_token',name:'Existing ZCode Coding Plan'}]:authMethods,
        agentCapabilities:{loadSession:true,promptCapabilities:{image:true,audio:false,embeddedContext:true},mcpCapabilities:{http:true,sse:true},sessionCapabilities:{}},
        _meta:{...(models.length?{modelState:{currentModelId:defaultModel(),availableModels:models}}:{}),availableCommands:[{name:'compact',description:'Compact the ZCode conversation'}]}};
    }
    if(method==='authenticate') {
      if(!['cached_token','terminal_setup'].includes(p.methodId)){const e=new Error('Unknown authentication method');e.code=-32602;throw e;}
      requireAccount();return {};
    }
    if(method==='session/new'||method==='session/load') {
      await this.startChild(p.cwd);
      const workspace={workspaceKey:p.cwd,workspacePath:p.cwd};
      const mcpServers=convertMcp(p.mcpServers);
      const snap=method==='session/new'?await this.request('session/create',{workspace,mode:this.launchMode(),model:selection(defaultModel()),mcpServers}):await this.request('session/resume',{sessionId:p.sessionId,workspace,mcpServers});
      const id=snap.session.sessionId;
      const current=snap.settings.model.current;
      const s={mode:this.launchMode(),modelId:current?`${current.providerId}/${current.modelId}`:defaultModel(),reasoningLevel:current?.options?.reasoningLevel||'high',active:null,tools:new Map(),text:''};
      this.sessions.set(id,s);
      await this.request('session/setMode',{sessionId:id,mode:s.mode});
      await this.request('session/subscribe',{sessionId:id,deliveryKind:'desktop-continuous'});
      return {...(method==='session/new'?{sessionId:id}:{}),...this.setup(s)};
    }
    if(method==='session/set_model') {
      const s=this.session(p.sessionId);const model=selection(p.modelId,p._meta?.reasoningEffort||s.reasoningLevel);
      await this.request('session/setModel',{sessionId:p.sessionId,model,persistAsWorkspaceLastUsed:false});s.modelId=p.modelId;s.reasoningLevel=model.options.reasoningLevel;
      return {};
    }
    if(method==='session/set_mode') {
      if(!modes.some(m=>m.id===p.modeId))throw new Error(`Unsupported ZCode mode: ${p.modeId}`);
      await this.request('session/setMode',{sessionId:p.sessionId,mode:p.modeId});this.session(p.sessionId).mode=p.modeId;return {};
    }
    if(method==='session/prompt') {
      const s=this.session(p.sessionId);if(s.active)throw new Error('ZCode session already has an active prompt');
      const blocks=p.prompt || [];
      const input=await convertPrompt(blocks,{stagingDir:`${userRoot}/t3-bridge-attachments`});
      if(s.active)throw new Error('ZCode session already has an active prompt');
      s.text='';s.tools.clear();s.inputId=randomUUID();
      const done=new Promise((resolve,reject)=>{s.active={resolve,reject};});
      // Attach a rejection handler before session/send completes; a failure event can arrive first.
      done.catch(()=>{});
      try {await this.request('session/send',{sessionId:p.sessionId,inputId:s.inputId,modelSelection:selection(s.modelId,s.reasoningLevel),...input});}
      catch(e){s.active?.reject(e);s.active=null;}
      return await done;
    }
    if(method==='session/cancel') {await this.request('session/stop',{sessionId:p.sessionId});return {};}
    if(method==='session/close') {throw new Error('Session deletion is not exposed by this bridge');}
    const e=new Error(`Unsupported ACP method: ${method}`);e.code=-32601;throw e;
  }
  fail(error) {
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
    for(const p of this.clientPending.values())p.reject(error);this.clientPending.clear();
    for(const s of this.sessions.values()){s.active?.reject(error);s.active=null;}
  }
  close() {
    if(this.closed)return;this.closed=true;
    this.fail(new Error('ACP client disconnected'));this.input.destroy();
    this.child?.kill();
    const timer=setTimeout(()=>this.child?.kill('SIGKILL'),3000);timer.unref();
  }
  run() {
    createInterface({input:this.input}).on('line',line=>{
      let m;try{m=JSON.parse(line);}catch{this.emit({id:null,error:{code:-32700,message:'Invalid JSON'}});return;}
      if(m.method) {
        void this.handle(m.method,m.params).then(result=>{if(m.id!==undefined)this.emit({id:m.id,result});},e=>{if(m.id!==undefined)this.emit({id:m.id,error:{code:e.code||-32603,message:e.message,...(e.data?{data:e.data}:{})}});});
      } else if(m.id!==undefined){const p=this.clientPending.get(m.id);if(p){this.clientPending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}
    }).on('close',()=>this.close());
    process.on('SIGTERM',()=>this.close());process.on('SIGINT',()=>this.close());
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {
  const legacyGrok=process.argv.includes('--legacy-grok');
  const args=process.argv.slice(2).filter(a=>a!=='--legacy-grok');
  if(Number(process.versions.node.split('.')[0])<24){console.error('ZCode ACP bridge requires Node.js 24 or newer.');process.exit(1);}
  if(args.includes('--version'))console.log(legacyGrok?'ZCode ACP bridge (legacy Grok compatibility probe)':'zcode-t3-bridge 0.3.0');
  else if(args.includes('--bridge-version'))console.log('zcode-t3-bridge 0.3.0');
  else if(args.includes('--setup')) {
    try {if(!existsSync(builtinPath))throw new Error('ZCode builtin provider configuration is missing. Install ZCode Desktop or configure its resource paths.');await setup({path:bridgeAccountPath,connected:()=>accounts().found.length>0,cliPath});}
    catch(e){console.error(e.message);process.exitCode=1;}
  }
  else if(args.includes('--help'))console.log('ZCode ACP bridge\n\nUsage: zcode-acp --setup\n       zcode-acp --acp\n       zcode-acp models\n       zcode-acp --version\n\nRequires Node.js 24+ and an installed, configured ZCode Desktop.\nSee README.md for setup and current limitations.');
  else if(args[0]==='models') {
    try{const models=modelCatalog();console.log(models.length?'You are logged in to ZCode.':'Not logged in to ZCode.');for(const m of models)console.log(`- ${m.modelId}${m.modelId===defaultModel()?' (default)':''}`);}catch{console.log('Not logged in to ZCode.');process.exitCode=1;}
  } else if(args[0]==='inspect')console.log(JSON.stringify({skills:[]}));
  else if(args[0]==='update'){console.error('Update ZCode through its desktop app; bridge updates are manual.');process.exitCode=1;}
  else if(!args.length || args.includes('agent') || args[0]==='--acp')new Bridge().run();
  else {console.error('Unsupported bridge command');process.exitCode=1;}
}
