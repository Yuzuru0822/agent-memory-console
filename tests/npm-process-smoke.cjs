// Exercise the legacy npm process route with a harmless local JS fixture, never a vendor task.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ConsoleService } = require('../dist-electron/electron/service');
const { Processes } = require('../dist-electron/electron/processes');
const { createAdapters } = require('../dist-electron/electron/adapters');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-console-npm-process-'));
  const prefix=path.join(root,'npm prefix & spaces');
  const pkg=path.join(prefix,'node_modules','@anthropic-ai','claude-code');
  fs.mkdirSync(pkg,{recursive:true});
  fs.writeFileSync(path.join(prefix,'claude.cmd'),'@echo SHOULD NEVER RUN & exit 99');
  fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@anthropic-ai/claude-code',version:'1.0.0',bin:{claude:'cli.js'}}));
  fs.writeFileSync(path.join(pkg,'cli.js'),`let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),input,options:process.env.NODE_OPTIONS??null,nodePath:process.env.NODE_PATH??null,electron:process.env.ELECTRON_RUN_AS_NODE??null})));`);
  const adapters=createAdapters(path.join(root,'home'),path.join(root,'local'));
  adapters.find(a=>a.id==='claude').npmDiscovery={prefixes:[prefix],nodeCandidates:[fs.realpathSync(process.execPath)]};
  const service=new ConsoleService(path.join(root,'data'),adapters);
  const manager=new Processes(service);
  const keys=['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    service.bind('claude','executable',path.join(prefix,'claude.cmd'));
    service.bind('claude','workspace',root);
    process.env.NODE_OPTIONS='--require ./must-never-load.cjs';
    process.env.NODE_PATH=path.join(root,'injected');
    process.env.ELECTRON_RUN_AS_NODE='1';
    const prompt='literal & echo untouched | > < %PATH% $() "quotes"';
    manager.launch('claude',prompt);
    const deadline=Date.now()+10000;
    while(manager.snapshot().claude.running && Date.now()<deadline) await pause(40);
    const state=manager.snapshot().claude;
    assert.equal(state.running,false);
    assert.equal(state.exitCode,0);
    const result=JSON.parse(state.output.trim());
    assert.deepEqual(result.args,['-p']);
    assert.equal(result.input,prompt+'\n');
    assert.equal(result.options,null);assert.equal(result.nodePath,null);assert.equal(result.electron,null);
    assert.equal(service.verifyAudit().valid,true);
    console.log('PASS npm process: real Node + fixture cli.js, literal stdin, fixed args, no shell/shim execution, startup-hook environment removed, exit/output/audit. No vendor task launched.');
  } finally {
    for(const key of keys) {if(saved[key]===undefined) delete process.env[key];else process.env[key]=saved[key];}
    for(const id of manager.active()) manager.stop(id);
    if(path.dirname(root)!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith('agent-console-npm-process-')) throw new Error('Unsafe cleanup target');
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
