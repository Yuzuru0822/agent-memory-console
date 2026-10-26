import { parentPort, workerData } from "node:worker_threads";
import { ConsoleService } from "./service";
import { RepositoryService } from "./repository-service";
import type { RepositoryRequest, RepositoryReply, RepositoryEvent } from "./repository-worker-types";

if (!parentPort) throw new Error("仓库后台线程未连接");
const port = parentPort;
const service = new ConsoleService(workerData.storage, workerData.adapters, workerData.protectedRoots);
let current = "";
const send = (message: RepositoryReply | RepositoryEvent) => port.postMessage(message);
// The main thread remains the only audit writer, including while task pause or
// incoming bridge messages append their own records during a long sync.
function hostDecision(event: Omit<Extract<RepositoryEvent,{kind:"audit"}>,"id"|"ack"> | {kind:"continue"}) {
  const ack = new SharedArrayBuffer(4), status = new Int32Array(ack);
  send({...event,id:current,ack});
  if (Atomics.wait(status,0,0,30000) === "timed-out") throw new Error("主进程未确认后台操作，已停止后续步骤");
  return Atomics.load(status,0) === 1;
}
service.audit = (action, detail) => {
  if (!hostDecision({kind:"audit",action,detail})) throw new Error("活动台账写入失败，已停止后续操作");
};
const repository = new RepositoryService(service, progress => send({kind:"progress", id:current, progress}));
let queue = Promise.resolve();
port.on("message", (request: RepositoryRequest) => {
  queue = queue.then(async () => {
    current = request.id;
    service.config = request.config;
    const before = JSON.stringify(service.config);
    let value: unknown, error: string | undefined;
    try {
      const args = request.args;
      switch (request.method) {
        case "snapshot": value = await repository.snapshot(); break;
        case "consoleSnapshot": value = service.snapshot(args[0]); break;
        case "choose": value = await repository.choose(args[0]); break;
        case "members": value = repository.members(args[0]); break;
        case "memoryFolder": value = repository.memoryFolder(args[0],args[1]); break;
        case "preview": value = await repository.preview(); break;
        case "review": value = repository.review(args[0]); break;
        case "cancelPreview": value = repository.cancelPreview(args[0]); break;
        case "apply": value = await repository.apply(args[0],args[1]); break;
        case "commit": value = await repository.commit(); break;
        case "automation": value = repository.automation(args[0]); break;
        case "cleanup": value = repository.cleanup(args[0]); break;
        case "linkPreview": value = repository.linkPreview(args[0]); break;
        case "linkReview": value = repository.linkReview(args[0]); break;
        case "linkApply": value = await repository.linkApply(args[0],args[1]); break;
        case "unlinkReview": value = repository.unlinkReview(args[0]); break;
        case "unlink": value = await repository.unlink(args[0]); break;
        case "tick": {
          const canContinue = () => hostDecision({kind:"continue"});
          if (canContinue()) value = await repository.tick(args[0], canContinue);
          break;
        }
        default: throw new Error("未知仓库后台操作");
      }
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    const changed = JSON.stringify(service.config) !== before;
    send({kind:"result", id:request.id, value, error, config:changed ? service.config : undefined,
      task: repository.taskStatus()});
    current = "";
  }).catch(error => { throw error; });
});
