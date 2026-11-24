import { randomUUID } from "node:crypto";
import type { RpcBootstrap, RpcMessage } from "./rpc-types.ts";

// 等待中的 RPC 请求：响应到来时 resolve，超时或断线时 reject。
type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

// 一个事件频道可以有多个界面订阅者。
type RpcEventListener = (...args: unknown[]) => void;

/** Preload 使用的客户端；负责握手、断线重连和请求/事件分发。 */
export class CraftRpcClient {
  private readonly clientId: string;
  private socket: WebSocket | null = null;
  private connection: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectFailureTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<RpcEventListener>>();

  constructor(private readonly bootstrap: RpcBootstrap) {
    this.clientId = bootstrap.clientId ?? randomUUID();
    // 页面刚启动时就建立连接；若失败会自动按退避间隔重试。
    void this.ensureConnected().catch(() => undefined);
  }

  /** 调用业务频道；连接断开时当前请求失败，但不会悄悄重复执行它。 */
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Craft RPC 尚未连接，请稍后重试。");
    }

    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      // Agent 一轮可能运行较久；普通读取/切换请求仍使用较短超时。
      const timeoutMs = channel === "agent:ask" ? 10 * 60_000 : 30_000;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 请求超时：${channel}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timeout,
      });

      try {
        socket.send(JSON.stringify({ id, type: "request", channel, args } satisfies RpcMessage));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 订阅后端主动推送的事件，并返回取消订阅函数。 */
  on(channel: string, listener: RpcEventListener): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set();
      this.listeners.set(channel, channelListeners);
    }
    channelListeners.add(listener);

    return () => {
      channelListeners?.delete(listener);
      if (channelListeners?.size === 0) this.listeners.delete(channel);
    };
  }

  /** 复用进行中的连接；没有可用连接时创建一个并等待握手确认。 */
  private ensureConnected(): Promise<void> {
    if (this.connection) return this.connection;

    const socket = new WebSocket(this.bootstrap.url);
    const handshakeId = randomUUID();
    this.socket = socket;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.connection = ready;
    let settled = false;

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({
          type: "handshake",
          id: handshakeId,
          clientId: this.clientId,
          token: this.bootstrap.token,
          protocolVersion: 1,
        } satisfies RpcMessage));
      } catch (error) {
        if (!settled) {
          settled = true;
          rejectReady(error instanceof Error ? error : new Error(String(error)));
        }
        socket.close();
      }
    };

    socket.onmessage = (event) => {
      this.handleMessage(socket, String(event.data), () => {
        if (settled) return;
        settled = true;
        this.reconnectAttempt = 0;
        if (this.disconnectFailureTimer) clearTimeout(this.disconnectFailureTimer);
        this.disconnectFailureTimer = null;
        resolveReady();
      }, handshakeId);
    };

    socket.onerror = () => {
      if (!settled) {
        settled = true;
        rejectReady(new Error("无法连接 Craft RPC 服务。"));
      }
    };

    socket.onclose = () => {
      if (!settled) {
        settled = true;
        rejectReady(new Error("Craft RPC 连接已关闭。"));
      }
      if (this.socket === socket) this.socket = null;
      if (this.connection === ready) this.connection = null;
      if (this.disconnectFailureTimer) clearTimeout(this.disconnectFailureTimer);
      this.disconnectFailureTimer = setTimeout(() => {
        this.disconnectFailureTimer = null;
        this.failPending(new Error("Craft RPC 重连失败；未完成的请求没有自动重发。"));
      }, 15_000);
      this.scheduleReconnect();
    };

    // 构造时可能还没有任何 UI 请求等待连接，主动处理拒绝避免未处理 Promise。
    void this.connection.catch(() => undefined);
    return this.connection;
  }

  /** 按响应 ID 完成请求，或把服务端事件分发给对应订阅者。 */
  private handleMessage(socket: WebSocket, raw: string, onHandshakeAck: () => void, handshakeId: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch {
      socket.close(4002, "RPC 服务返回了无效 JSON");
      return;
    }

    if (message.type === "handshake_ack") {
      if (message.id === handshakeId) onHandshakeAck();
      return;
    }

    if (message.type === "event") {
      for (const listener of this.listeners.get(message.channel) ?? []) {
        try {
          listener(...message.args);
        } catch (error) {
          console.error("RPC event listener failed:", error);
        }
      }
      return;
    }

    if (message.type !== "response" && message.type !== "error") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.type === "error") pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  /** 连接恢复后重试握手；指数退避避免故障时频繁冲击服务端。 */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(500 * 2 ** this.reconnectAttempt, 8_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch(() => undefined);
    }, delay);
  }

  /** 断线时拒绝全部未完成请求，防止界面无限等待或误以为请求成功。 */
  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
