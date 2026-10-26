/** Private state is encrypted by the host OS, never by a key in the shared repository. */
export interface SecretCodec {
  seal(text: string): string;
  open(encoded: string): string;
}

interface HostEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const PREFIX = "agent-console-private-v1:";
const MAX_BYTES = 32 * 1024 * 1024;

/** Call after app.whenReady. On Windows Electron safeStorage uses DPAPI. */
export function createSecretCodec(host: HostEncryption): SecretCodec {
  const available = () => {
    if (!host.isEncryptionAvailable()) throw new Error("系统加密存储不可用，已停止私有配置和消息操作");
  };
  return {
    seal(text) {
      available();
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BYTES)
        throw new Error("私有数据超过大小上限");
      try { return PREFIX + host.encryptString(text).toString("base64"); }
      catch { throw new Error("私有数据加密失败"); }
    },
    open(encoded) {
      available();
      if (typeof encoded !== "string" || !encoded.startsWith(PREFIX) || encoded.length > MAX_BYTES * 2)
        throw new Error("私有数据格式无效");
      const payload = encoded.slice(PREFIX.length);
      if (!payload || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload))
        throw new Error("私有数据格式无效");
      try {
        const text = host.decryptString(Buffer.from(payload, "base64"));
        if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("size");
        return text;
      } catch { throw new Error("私有数据无法解密，请使用原 Windows 用户并保留原文件"); }
    },
  };
}
