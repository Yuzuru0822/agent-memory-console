// Real child-process lifecycle test. Node.exe is a harmless stand-in; this is NOT a Claude integration test.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { ConsoleService } = require('../dist-electron/electron/service');
const { Processes } = require('../dist-electron/electron/processes');
const { createAdapters } = require('../dist-electron/electron/adapters');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) { if(predicate()) return; await pause(40); }
  throw new Error('Timed out waiting for child process');
}
(async()=>{
  if(process.platform!=='win32') throw new Error('This smoke test requires Windows and Node.exe.');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-console-process-test-'));
  const service=new ConsoleService(path.join(root,'data'),createAdapters(path.join(root,'home'),path.join(root,'local')));
  const manager=new Processes(service);
  // nvm commonly exposes node.exe through a junction; bind the actual binary.
  const executable=fs.realpathSync(process.execPath);
  let other;
  try {
    service.bind('claude','executable',executable);
    service.bind('claude','workspace',root);
    manager.launch('claude','process.stdout.write("helper-output\\n"); 6 * 7');
    assert.ok(manager.snapshot().claude.pid);
    await until(()=>!manager.snapshot().claude.running);
    assert.equal(manager.snapshot().claude.exitCode,0);
    assert.match(manager.snapshot().claude.output,/helper-output/);
    assert.match(manager.snapshot().claude.output,/42/);
    other=spawn(executable,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
    await new Promise((resolve,reject)=>{other.once('spawn',resolve);other.once('error',reject);});
    manager.launch('claude','console.log("WAITING"); setInterval(()=>{},1000)');
    await until(()=>manager.snapshot().claude.output.includes('WAITING'));
    assert.equal(manager.snapshot().claude.running,true);
    assert.throws(()=>manager.stop('trae'),/没有可停止/);
    manager.stop('claude');
    await until(()=>!manager.snapshot().claude.running);
    assert.equal(manager.active().length,0);
    assert.doesNotThrow(()=>process.kill(other.pid,0),'stopping the owned process must not stop another process');
    assert.equal(service.verifyAudit().valid,true);
    console.log('PASS process: actual Node.exe helper, stdin/output, PID/running, exit code, stop owned child, unrelated helper remains alive, audit chain. No vendor Agent launched.');
  } finally {
    for(const id of manager.active()) manager.stop(id);
    if(other && other.exitCode===null) { other.kill(); await Promise.race([new Promise(resolve=>other.once('exit',resolve)),pause(2000)]); }
    const tempRoot=path.resolve(os.tmpdir());
    const target=path.resolve(root);
    if(path.dirname(target)!==tempRoot || !path.basename(target).startsWith('agent-console-process-test-')) throw new Error('Refusing unsafe test cleanup');
    fs.rmSync(target,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
