import test from "node:test";
import assert from "node:assert/strict";
import { createSecretCodec } from "../electron/private-store";

test("private codec fails closed when OS encryption is unavailable", () => {
  const codec = createSecretCodec({isEncryptionAvailable:()=>false, encryptString:()=>{throw new Error("must not call");}, decryptString:()=>{throw new Error("must not call");}});
  assert.throws(()=>codec.seal("secret"), /加密存储不可用/);
  assert.throws(()=>codec.open("plaintext"), /加密存储不可用/);
});

test("private codec requires a versioned envelope and never reflects secret errors", () => {
  const codec = createSecretCodec({isEncryptionAvailable:()=>true, encryptString:value=>Buffer.from(value.split("").reverse().join("")), decryptString:value=>value.toString().split("").reverse().join("")});
  assert.equal(codec.open(codec.seal("测试 token")), "测试 token");
  for (const bad of ["plain", "agent-console-private-v1:", "agent-console-private-v1:%%%%", "agent-console-private-v1:YWJj\n"])
    assert.throws(()=>codec.open(bad), /格式无效/);
  const broken = createSecretCodec({isEncryptionAvailable:()=>true, encryptString:()=>{throw new Error("private-token");}, decryptString:()=>{throw new Error("private-token");}});
  assert.throws(()=>broken.seal("secret"), {message:"私有数据加密失败"});
  assert.throws(()=>broken.open("agent-console-private-v1:YWJj"), {message:"私有数据无法解密，请使用原 Windows 用户并保留原文件"});
});
