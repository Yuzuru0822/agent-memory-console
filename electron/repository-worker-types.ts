import type { Config } from "../src/shared";
import type { RepositoryProgress } from "../src/repository-types";
import type { RepositoryTaskStatus } from "../src/task-types";

export type RepositoryMethod = "snapshot" | "consoleSnapshot" | "choose" | "members" | "memoryFolder" | "preview" | "review" | "cancelPreview" | "apply" | "commit" | "automation" | "cleanup" | "linkPreview" | "linkReview" | "linkApply" | "unlinkReview" | "unlink" | "tick";
export interface RepositoryRequest {id:string;method:RepositoryMethod;args:any[];config:Config}
export interface RepositoryReply {kind:"result";id:string;value?:unknown;error?:string;config?:Config;task:RepositoryTaskStatus}
export type RepositoryEvent = {kind:"audit";id:string;action:string;detail:string;ack:SharedArrayBuffer} |
  {kind:"continue";id:string;ack:SharedArrayBuffer} |
  {kind:"progress";id:string;progress:Pick<RepositoryProgress,"phase"|"completed"|"total"|"currentFile"|"message">};
