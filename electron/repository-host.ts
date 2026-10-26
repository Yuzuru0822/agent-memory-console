import { Worker } from "node:worker_threads";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentId, Snapshot } from "../src/shared";
import type { RepositoryAutomation, RepositoryProgress, RepositorySnapshot, RepositoryPlan, RepositoryResolution, JunctionView } from "../src/repository-types";
import type { RepositoryTaskStatus } from "../src/task-types";
import type { RepositoryEvent, RepositoryReply, RepositoryRequest, RepositoryMethod } from "./repository-worker-types";
import { ConsoleService } from "./service";

const defaults: RepositoryAutomation = {enabled:false,intervalSeconds:60,cleanupEnabled:false,retentionDays:30,minBackups:20};
const labels: Partial<Record<RepositoryMethod,string>> = {choose:"初始化仓库",members:"保存纳管选择",memoryFolder:"检查记忆目录",preview:"预览双向同步",apply:"执行双向同步",commit:"保存 Git 版本",cleanup:"清理备份",linkPreview:"预览技能连接",linkApply:"连接技能仓库",unlink:"恢复技能目录"};
type Pending = {resolve:(value:any)=>void;reject:(error:Error)=>void;auditError?:Error;canContinue?:()=>boolean};

/** Persistent worker owns plans, file scans and Git. Electron never waits synchronously. */
export class RepositoryHost {
  private worker: Worker;
  private pending = new Map<string,Pending>();
  private tail = Promise.resolve();
  private active?: {id:string;method:RepositoryMethod};
  private progressValue?: RepositoryProgress;
  private failed?: Error;
  private disposed = false;
  private cachedSnapshot?: RepositorySnapshot;
  private snapshotAt = 0;
  private snapshotConfig = "";
  private snapshotPromise?: Promise<RepositorySnapshot>;
  private cachedConsole?: Snapshot;
  private consolePromise?: Promise<Snapshot>;
  private cachedTask?: RepositoryTaskStatus;

  constructor(private readonly service: ConsoleService, workerFile = path.join(__dirname,"repository-worker.js")) {
    this.worker = new Worker(workerFile, {workerData: service.workerContext()});
    this.worker.on("message", (reply: RepositoryReply | RepositoryEvent) => this.receive(reply));
    this.worker.on("error", error => this.fail(error));
    this.worker.on("exit", code => {
      if (!this.disposed) this.fail(new Error(`仓库后台线程已退出（${code}），请重启控制台并核对最近操作；不会自动重试写入`));
    });
  }
  get backgroundBusy():boolean {return !!this.active;}
  get healthy():boolean {return !this.failed && !this.disposed;}
  assertHealthy():void {if (!this.healthy) throw this.failed || new Error("仓库后台线程已关闭，请重启控制台");}
  get running(): boolean { return !!this.active && (this.active.method === "tick" ? this.progressValue?.id === this.active.id && this.progressValue.state === "running" : !["snapshot","consoleSnapshot","review","linkReview","unlinkReview"].includes(this.active.method)); }
  progress(): RepositoryProgress | undefined { return this.progressValue && {...this.progressValue}; }
  private fail(error: Error) {
    this.failed = new Error(`仓库后台线程不可用，请重启控制台并核对最近操作；不会自动重试写入。${error.message}`);
    if (!this.disposed) {
      if (!this.progressValue || this.progressValue.state !== "running") this.startProgress(crypto.randomUUID(),"仓库后台线程");
      this.progressValue = {...this.progressValue!,state:"failed",phase:"后台任务失败",message:this.failed.message,updatedAt:new Date().toISOString()};
    }
    for (const pending of this.pending.values()) pending.reject(this.failed);
    this.pending.clear();
  }
  private receive(reply: RepositoryReply | RepositoryEvent) {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    if (reply.kind === "audit") {
      let success = false;
      try { this.service.audit(reply.action,reply.detail); success=true; } catch(error) {pending.auditError = error instanceof Error ? error : new Error(String(error));}
      const ack = new Int32Array(reply.ack); Atomics.store(ack,0,success?1:-1); Atomics.notify(ack,0);
      return;
    }
    if (reply.kind === "continue") {
      let allowed = false;
      try {allowed = pending.canContinue?.() === true;} catch { /* Fail closed on pause-state errors. */ }
      const ack = new Int32Array(reply.ack); Atomics.store(ack,0,allowed?1:-1); Atomics.notify(ack,0);
      return;
    }
    if (reply.kind === "progress") {
      if (this.active?.method === "tick" && this.progressValue?.id !== reply.id) this.startProgress(reply.id,"自动同步与清理");
      if (this.progressValue?.id === reply.id) this.progressValue = {...this.progressValue,completed:undefined,total:undefined,currentFile:undefined,message:undefined,...reply.progress,updatedAt:new Date().toISOString()};
      return;
    }
    if (reply.config) this.service.config = reply.config;
    this.cachedTask = reply.task;
    this.pending.delete(reply.id);
    const error = pending.auditError || (reply.error ? new Error(reply.error) : undefined);
    if (error) pending.reject(error); else pending.resolve(reply.value);
  }
  private startProgress(id:string,operation:string) {
    const now = new Date().toISOString();
    this.progressValue = {id,operation,phase:"准备任务",state:"running",startedAt:now,updatedAt:now};
  }
  private call<T>(method:RepositoryMethod,args:any[] = [],canContinue?:()=>boolean): Promise<T> {
    const operation = this.tail.then(async () => {
      if (this.disposed || this.failed) throw this.failed || new Error("仓库后台线程已关闭");
      const id = crypto.randomUUID(); this.active = {id,method};
      const label = labels[method];
      if (label) this.startProgress(id,label);
      try {
        const value = await new Promise<T>((resolve,reject) => {
          this.pending.set(id,{resolve,reject,canContinue});
          const request:RepositoryRequest = {id,method,args,config:this.service.config};
          try {this.worker.postMessage(request);} catch(error) {this.pending.delete(id);reject(error);}
        });
        if (this.progressValue?.id === id) {
          const automaticIssue = method === "tick" && (this.cachedTask?.issue || this.cachedTask?.error);
          this.progressValue = {...this.progressValue,state:automaticIssue?"failed":"completed",phase:automaticIssue?"自动任务需要处理":"完成",message:automaticIssue?this.cachedTask?.lastMessage || this.cachedTask?.error:method === "apply" ? `已同步 ${value} 个文件并保存 Git 版本` : undefined,updatedAt:new Date().toISOString()};
        }
        if (!["snapshot","consoleSnapshot","review","linkReview","unlinkReview"].includes(method) && (method !== "tick" || this.progressValue?.id === id)) this.snapshotAt = 0;
        return value;
      } catch(error) {
        if (this.progressValue?.id === id) this.progressValue = {...this.progressValue,state:"failed",phase:"任务失败",message:error instanceof Error ? error.message : String(error),updatedAt:new Date().toISOString()};
        throw error;
      } finally {this.active = undefined;}
    });
    this.tail = operation.then(()=>{},()=>{});
    return operation;
  }
  private fallback(): RepositorySnapshot {
    const config = this.service.config.repository;
    return {root:config?.root,git:this.cachedSnapshot?.git,history:this.cachedSnapshot?.history || [],automation:config?.automation || {...defaults},
      running:this.running,error:this.failed?.message,lastRun:this.cachedTask?.lastRun,lastMessage:this.cachedTask?.lastMessage,backupCount:this.cachedSnapshot?.backupCount || 0,
      members:this.service.adapters.map(agent=>({id:agent.id,name:agent.name,selected:!!config?.agentIds.includes(agent.id),
        memoryPath:config?.memoryFolders[agent.id] || this.service.settings(agent.id).memory,skillsPath:this.service.settings(agent.id).skills,
        linked:this.cachedSnapshot?.members.find(item=>item.id === agent.id)?.linked || false}))};
  }
  async snapshot(fresh = true): Promise<RepositorySnapshot> {
    if (this.active || this.failed) return {...(this.cachedSnapshot || this.fallback()),running:this.running,error:this.failed?.message || this.cachedSnapshot?.error};
    const config = JSON.stringify(this.service.config);
    if (!fresh && this.cachedSnapshot && this.snapshotConfig === config && Date.now()-this.snapshotAt<15000) return {...this.cachedSnapshot,running:false};
    if (!this.snapshotPromise) this.snapshotPromise = this.call<RepositorySnapshot>("snapshot").then(value=>{this.cachedSnapshot=value;this.snapshotAt=Date.now();this.snapshotConfig=config;return value;}).finally(()=>{this.snapshotPromise=undefined;});
    return this.snapshotPromise;
  }
  async consoleSnapshot(processes:Parameters<ConsoleService["snapshot"]>[0] = {}):Promise<Snapshot> {
    if (this.active && this.cachedConsole) return {...this.cachedConsole,agents:this.cachedConsole.agents.map(agent=>({...agent,process:processes[agent.id] || {running:false,output:""}}))};
    if (!this.consolePromise) this.consolePromise = this.call<Snapshot>("consoleSnapshot",[processes]).then(value=>{this.cachedConsole=value;return value;}).finally(()=>{this.consolePromise=undefined;});
    return this.consolePromise;
  }
  taskStatus(now=Date.now()):RepositoryTaskStatus {
    const config=this.service.config.repository;
    const result:RepositoryTaskStatus = {...this.cachedTask,configured:!!config,syncEnabled:!!config?.automation.enabled,cleanupEnabled:!!config?.automation.cleanupEnabled,running:this.running,intervalSeconds:config?.automation.intervalSeconds || defaults.intervalSeconds};
    if (result.previewUntil && Date.parse(result.previewUntil)<=now) delete result.previewUntil;
    if (this.failed) {result.issue="error";result.error=this.failed.message;}
    return result;
  }
  choose(selected:string) {return this.call<void>("choose",[selected]);}
  members(ids:AgentId[]) {return this.call<void>("members",[ids]);}
  memoryFolder(id:AgentId,selected:string) {return this.call<void>("memoryFolder",[id,selected]);}
  preview() {return this.call<RepositoryPlan>("preview");}
  review(id:string) {return this.call<RepositoryPlan>("review",[id]);}
  cancelPreview() {return this.call<void>("cancelPreview");}
  apply(id:string,choices:Record<string,RepositoryResolution>) {return this.call<number>("apply",[id,choices]);}
  commit() {return this.call<string>("commit");}
  automation(options:RepositoryAutomation) {return this.call<void>("automation",[options]);}
  cleanup() {return this.call<number>("cleanup");}
  linkPreview(id:AgentId) {return this.call<JunctionView>("linkPreview",[id]);}
  linkReview(id:string) {return this.call<JunctionView>("linkReview",[id]);}
  linkApply(id:string,choices:Record<string,"agent"|"repository">) {return this.call<string>("linkApply",[id,choices]);}
  unlinkReview(id:AgentId) {return this.call<{source:string;target:string;backupPath:string;repositoryBackupPath?:string}>("unlinkReview",[id]);}
  unlink(id:AgentId) {return this.call<void>("unlink",[id]);}
  async tick(now:number,canContinue:()=>boolean) {
    const config=this.service.config.repository, task=this.taskStatus(now);
    if (!canContinue() || !config || !config.automation.enabled && !config.automation.cleanupEnabled ||
      task.previewUntil && Date.parse(task.previewUntil)>now || task.nextCheck && Date.parse(task.nextCheck)>now) return;
    await this.call<void>("tick",[now],canContinue);
  }
  async dispose() {this.disposed=true;this.fail(new Error("仓库后台线程已关闭"));await this.worker.terminate();}
}
