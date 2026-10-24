/* Actual main/preload with isolated data. Scheduler, vendor bridge and tray transport
 * use fixtures; no vendor UIA, user preferences or real system tray is operated. */
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const project = path.resolve(__dirname, '..');
  const fixture = path.resolve(project, '../../work', `tasks-runtime-${Date.now()}`);
  const data = path.join(fixture, 'data');
  const home = path.join(fixture, 'home');
  fs.mkdirSync(home, {recursive:true});
  const app = await electron.launch({args:[project],env:{...process.env,CONSOLE_DEV:'',CONSOLE_TEST_DATA:data,CONSOLE_TEST_HOME:home},timeout:60000});
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.agent-card');
    await page.evaluate(() => window.consoleApi.taskPause(null));
    await app.evaluate(({ dialog, nativeImage }, {project,fixture}) => {
      const req = process.mainModule.require.bind(process.mainModule);
      const p = req('node:path');
      const s = global.__tasksRuntime = { repos:0,rewards:0,balances:0,hold:false,release:null,active:false,menu:[],failTray:false,cancelSave:true,savePath:p.join(fixture,'tasks.csv'),dialogs:[] };
      req(p.join(project,'dist-electron/electron/repository-service.js')).RepositoryService.prototype.tick = async function() {
        s.repos++; if(s.hold) await new Promise(resolve => {s.release=resolve;});
      };
      req(p.join(project,'dist-electron/electron/rewards-service.js')).RewardsService.prototype.tick = async function(){s.rewards++;};
      req(p.join(project,'dist-electron/electron/rewards-balance.js')).RewardsBalanceService.prototype.tick = async function(){s.balances++;};
      req(p.join(project,'dist-electron/electron/processes.js')).Processes.prototype.active = function(){return s.active?[{id:'fixture'}]:[];};
      dialog.showMessageBox = async (...args) => {s.dialogs.push(args.at(-1).message);return {response:0,checkboxChecked:false};};
      dialog.showSaveDialog = async () => ({canceled:s.cancelSave,filePath:s.savePath});
      const Tray = req(p.join(project,'dist-electron/electron/task-tray.js')).TaskTray;
      const enable = Tray.prototype.enable;
      Tray.prototype.enable = function(paused) {
        this.runtime = {
          createImage: png => nativeImage.createFromBuffer(png),
          createTray: () => {
            if(s.failTray) throw new Error('fixture tray unavailable');
            s.trayDestroyed=false;
            return {on(){},removeAllListeners(){},setToolTip(){},setContextMenu(menu){s.menu=menu;},isDestroyed(){return s.trayDestroyed;},destroy(){s.trayDestroyed=true;}};
          }, buildMenu: entries => entries
        };
        return enable.call(this,paused);
      };
    },{project,fixture});
    const counters = () => app.evaluate(() => {const s=global.__tasksRuntime;return [s.repos,s.rewards,s.balances];});
    const waitMain = async predicate => {
      const deadline=Date.now()+12000;
      while(Date.now()<deadline){if(await app.evaluate(predicate))return;await pause(100);}
      throw new Error('Timed out waiting for isolated scheduler');
    };
    await pause(5500);
    assert.deepEqual(await counters(),[0,0,0],'global pause blocks every automatic stage');
    await app.evaluate(() => {global.__tasksRuntime.hold=true;});
    await page.evaluate(() => window.consoleApi.taskResume());
    await waitMain(() => !!global.__tasksRuntime.release);
    await page.evaluate(() => window.consoleApi.taskPause(null));
    await app.evaluate(() => {const s=global.__tasksRuntime;s.hold=false;s.release();s.release=null;});
    await pause(300);
    assert.deepEqual(await counters(),[1,0,0],'pause during repository stage blocks following claim and balance stages');
    assert.equal((await page.evaluate(() => window.consoleApi.taskControlsSnapshot())).runtime.busy,false);
    await page.evaluate(() => window.consoleApi.taskResume());
    await waitMain(() => global.__tasksRuntime.balances>0);
    const snapshot=await page.evaluate(() => window.consoleApi.taskCenterSnapshot());
    assert.equal(snapshot.tasks.length,20);
    assert.equal(snapshot.controls.closeToTray,false);
    assert.ok(snapshot.tasks.every(task=>!task.enabled),'resume cannot enable unconfigured tasks');
    // Cancel app.quit() with a tracked process; the next timer round must still run.
    const beforeQuit=(await counters())[0];
    await app.evaluate(({app}) => {global.__tasksRuntime.active=true;app.quit();});
    await waitMain(() => global.__tasksRuntime.dialogs.includes('仍有控制台启动的进程'));
    await app.evaluate(() => {global.__tasksRuntime.active=false;});
    await waitMain(() => global.__tasksRuntime.repos>0 && global.__tasksRuntime.balances===global.__tasksRuntime.repos-1);
    await pause(5500);
    assert.ok((await counters())[0]>beforeQuit,'cancelled quit preserves periodic timer');
    await page.evaluate(() => window.consoleApi.taskPause(null));
    // Real IPC validates reports and uses the isolated save dialog; cancellation writes nothing.
    await page.evaluate(() => window.consoleApi.taskReport('tasks'));
    assert.equal(fs.existsSync(path.join(fixture,'tasks.csv')),false);
    await app.evaluate(() => {global.__tasksRuntime.cancelSave=false;});
    await page.evaluate(() => window.consoleApi.taskReport('tasks'));
    const report=fs.readFileSync(path.join(fixture,'tasks.csv'),'utf8');
    assert.ok(report.startsWith('\uFEFF'));
    assert.equal(report.trim().split('\n').length,21);
    assert.ok(!report.includes(fixture),'reports exclude local paths');
    await app.evaluate(() => {global.__tasksRuntime.savePath=global.__tasksRuntime.savePath.replace('tasks.csv','balances.csv');});
    await page.evaluate(() => window.consoleApi.taskReport('balances'));
    assert.ok(fs.readFileSync(path.join(fixture,'balances.csv'),'utf8').includes('sampled_at'));
    assert.ok(await page.evaluate(async()=>{try{await window.consoleApi.taskReport('invalid');return false;}catch{return true;}}));
    await app.evaluate(() => {global.__tasksRuntime.savePath=global.__tasksRuntime.savePath.replace('balances.csv','must-not-write.md');});
    assert.ok(await page.evaluate(async()=>{try{await window.consoleApi.taskReport('tasks');return false;}catch{return true;}}));
    assert.equal(fs.existsSync(path.join(fixture,'must-not-write.md')),false);
    // Exercise main close policy through a fixture tray transport, not the user's tray.
    await page.evaluate(() => window.consoleApi.taskTray(true));
    assert.equal((await page.evaluate(() => window.consoleApi.taskControlsSnapshot())).runtime.trayAvailable,true);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
    assert.equal((await page.evaluate(() => window.consoleApi.taskControlsSnapshot())).runtime.windowVisible,false);
    await app.evaluate(() => global.__tasksRuntime.menu.find(entry=>entry.label==='打开控制台').click());
    assert.equal((await page.evaluate(() => window.consoleApi.taskControlsSnapshot())).runtime.windowVisible,true);
    await app.evaluate(() => global.__tasksRuntime.menu.find(entry=>entry.label==='恢复自动任务').click());
    await pause(200);
    assert.equal((await page.evaluate(() => window.consoleApi.taskControlsSnapshot())).controls.paused,false);
    await page.evaluate(() => window.consoleApi.taskPause(15));
    await app.evaluate(({BrowserWindow}) => {BrowserWindow.getAllWindows()[0].close();global.__tasksRuntime.trayDestroyed=true;});
    await waitMain(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible());
    assert.equal((await page.evaluate(() => window.consoleApi.taskControlsSnapshot())).runtime.trayAvailable,false,'lost tray must restore hidden window');
    await page.evaluate(() => window.consoleApi.taskTray(false));
    await app.evaluate(() => {global.__tasksRuntime.failTray=true;});
    assert.ok(await page.evaluate(async()=>{try{await window.consoleApi.taskTray(true);return false;}catch{return true;}}));
    const control=await page.evaluate(()=>window.consoleApi.taskControlsSnapshot());
    assert.equal(control.controls.closeToTray,false);
    assert.equal(control.runtime.trayAvailable,false);
    assert.equal(control.runtime.windowVisible,true);
    const persisted=JSON.parse(fs.readFileSync(path.join(data,'console-data/task-controls.json'),'utf8'));
    assert.equal(persisted.paused,true);
    assert.ok(persisted.pauseUntil);
    console.log('PASS tasks runtime: actual fixed IPC, 20 tasks, persistent pause, between-stage pause gate, resume grants preserved, cancelled quit timer, CSV cancel/save/validation, native PNG decoding, fixture tray close/show/pause and failure fallback. No real tray or vendor UIA invoked.');
  } finally {await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
