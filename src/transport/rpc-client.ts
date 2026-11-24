import { randomUUID } from "node:crypto";
import type { RpcBootstrap, RpcMessage } from "./rpc-types.ts";

// 等待中的 RPC 请求：响应到来时 resolve，超时或断线时 reject。
type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/** Preload 使用的客户端；Renderer 只拿到受控 API，不会接触 WebSocket。 */
export class CraftRpcClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly connected: Promise<void>;
  private resolveConnected!: () => void;
  private rejectConnected!: (error: Error) => void;

  constructor(bootstrap: RpcBootstrap) {
    this.socket = new WebSocket(bootstrap.url);
    this.connected = new Promise<void>((resolve, reject) => {
      this.resolveConnected = resolve;
      this.rejectConnected = reject;
    });
    // 尚未有 UI 请求时，也要处理连接失败，避免未处理的 Promise 警告。
    void this.connected.catch(() => undefined);

    this.socket.onopen = () => {
      // WebSocket 打开只说明网络连上了；握手成功后才算应用连接就绪。
      this.socket.send(JSON.stringify({
        type: "handshake",
        id: randomUUID(),
        token: bootstrap.token,
        protocolVersion: 1,
      } satisfies RpcMessage));
    };

    this.socket.onmessage = (event) => this.handleMessage(String(event.data));
    this.socket.onerror = () => this.failAll(new Error("无法连接 Craft RPC 服务。"));
    this.socket.onclose = () => this.failAll(new Error("Craft RPC 连接已关闭。"));
  }

  /** 调用一个已注册的业务频道，并等待它对应的响应。 */
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    await this.connected;

    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 请求超时：${channel}`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timeout,
      });

      try {
        this.socket.send(JSON.stringify({
          id,
          type: "request",
          channel,
          args,
        } satisfies RpcMessage));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 按响应 id 找到原请求，并完成对应 Promise。 */
  private handleMessage(raw: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch {
      this.failAll(new Error("RPC 服务返回了无效 JSON。"));
      return;
    }

    if (message.type === "handshake_ack") {
      this.resolveConnected();
      return;
    }

    if (message.type !== "response" && message.type !== "error") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.type === "error") {
      pending.reject(new Error(message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  /** 连接断开时拒绝所有未完成请求，避免界面一直等待。 */
  private failAll(error: Error): void {
    this.rejectConnected(error);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
