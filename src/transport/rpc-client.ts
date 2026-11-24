import { randomUUID } from "node:crypto";
import { RPC_PROTOCOL_VERSION, type RpcBootstrap, type RpcMessage } from "./rpc-types.ts";

// 等待中的 RPC 请求：响应到来时 resolve，超时或断线时 reject。
type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

// 一个事件频道可以有多个界面订阅者。
type RpcEventListener = (...args: unknown[]) => void;

export type RpcConnectionState = {
  status: "connecting" | "connected" | "reconnecting" | "disconnected";
  attempt: number;
  nextRetryInMs?: number;
  serverVersion?: string;
  lastError?: string;
};

/** Preload 使用的客户端；负责握手、断线重连和请求/事件分发。 */
export class CraftRpcClient {
  private clientId: string | null = null;
  private workspaceId: string | null = null;
  private lastSeenSeq = 0;
  private lastAckSentSeq = 0;
  private ackTimer: ReturnType<typeof setInterval> | null = null;
  private stalePending = false;
  private socket: WebSocket | null = null;
  private connection: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<RpcEventListener>>();
  private readonly connectionListeners = new Set<(state: RpcConnectionState) => void>();
  private connectionState: RpcConnectionState = { status: "connecting", attempt: 0 };
  private registeredChannels: Set<string> | null = null;
  private serverVersion: string | undefined;
  private backoffResetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly bootstrap: RpcBootstrap) {
    // 页面刚启动时就建立连接；若失败会自动按退避间隔重试。
    void this.ensureConnected().catch(() => undefined);
  }

  /** 调用业务频道；连接断开时当前请求失败，但不会悄悄重复执行它。 */
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    await this.ensureConnected();
    if (!this.isChannelAvailable(channel)) {
      const error = new Error(`RPC 服务端未注册频道：${channel}`) as Error & { code?: string };
      error.code = "CHANNEL_NOT_FOUND";
      throw error;
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Craft RPC 尚未连接，请稍后重试。");
    }

    const id = randomUUID();
    const result = await new Promise<T>((resolve, reject) => {
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

    // 记住窗口当前工作区；重连握手会用它校验是否仍是原来的客户端状态。
    if (channel === "workspace:select" || channel === "workspace:restore") {
      const state = result as { workspace?: { id?: unknown } };
      if (typeof state.workspace?.id === "string") this.workspaceId = state.workspace.id;
    } else if (channel === "workspace:add" && result) {
      const state = result as { workspace?: { id?: unknown } };
      if (typeof state.workspace?.id === "string") this.workspaceId = state.workspace.id;
    }
    return result;
  }

  /** 订阅后端主动推送的事件，并返回取消订阅函数。 */
  on(channel: string, listener: RpcEventListener): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set();
      this.listeners.set(channel, channelListeners);
    }
    channelListeners.add(listener);

    // stale 握手可能早于 React 订阅；先暂存状态，再在订阅时补发通知。
    if (channel === "transport:stale" && this.stalePending) {
      this.stalePending = false;
      try {
        listener();
      } catch (error) {
        console.error("RPC stale-state listener failed:", error);
      }
    }

    return () => {
      channelListeners?.delete(listener);
      if (channelListeners?.size === 0) this.listeners.delete(channel);
    };
  }

  /** 读取当前连接状态；调用订阅时会先立即收到一次当前值。 */
  onConnectionStateChanged(listener: (state: RpcConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    try {
      listener({ ...this.connectionState });
    } catch (error) {
      console.error("RPC connection-state listener failed:", error);
    }
    return () => this.connectionListeners.delete(listener);
  }

  getConnectionState(): RpcConnectionState {
    return { ...this.connectionState };
  }

  isChannelAvailable(channel: string): boolean {
    return !this.registeredChannels || this.registeredChannels.has(channel);
  }

  /** 复用进行中的连接；没有可用连接时创建一个并等待握手确认。 */
  private ensureConnected(): Promise<void> {
    if (this.connection) return this.connection;

    const socket = new WebSocket(this.bootstrap.url);
    const handshakeId = randomUUID();
    this.socket = socket;
    this.setConnectionState({
      status: this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
      attempt: this.reconnectAttempt,
    });
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
          token: this.bootstrap.token,
          protocolVersion: RPC_PROTOCOL_VERSION,
          webContentsId: this.bootstrap.webContentsId,
          workspaceId: this.workspaceId ?? undefined,
          reconnectClientId: this.clientId ?? undefined,
          lastSeq: this.clientId ? this.lastSeenSeq : undefined,
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
      this.handleMessage(socket, String(event.data), (ack) => {
        if (settled) return;
        settled = true;
        this.clientId = ack.clientId;
        this.serverVersion = ack.serverVersion;
        this.registeredChannels = ack.registeredChannels
          ? new Set(ack.registeredChannels)
          : null;
        this.setConnectionState({
          status: "connected",
          attempt: this.reconnectAttempt,
          serverVersion: this.serverVersion,
        });
        if (this.backoffResetTimer) clearTimeout(this.backoffResetTimer);
        this.backoffResetTimer = setTimeout(() => {
          this.backoffResetTimer = null;
          this.reconnectAttempt = 0;
        }, 10_000);
        if (ack.stale) {
          this.lastSeenSeq = 0;
          this.lastAckSentSeq = 0;
          this.stalePending = (this.listeners.get("transport:stale")?.size ?? 0) === 0;
          if (!this.stalePending) this.emit("transport:stale");
        }
        this.startSequenceAckTimer();
        resolveReady();
      }, handshakeId);
    };

    socket.onerror = () => {
      if (!settled) {
        settled = true;
        this.setConnectionState({
          status: "disconnected",
          attempt: this.reconnectAttempt,
          lastError: "无法连接 Craft RPC 服务。",
        });
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
      if (this.ackTimer) clearInterval(this.ackTimer);
      this.ackTimer = null;
      if (this.backoffResetTimer) clearTimeout(this.backoffResetTimer);
      this.backoffResetTimer = null;
      this.failPending(new Error("Craft RPC 连接中断；未完成的请求没有自动重发。"));
      this.setConnectionState({
        status: "disconnected",
        attempt: this.reconnectAttempt,
        lastError: "Craft RPC 连接中断。",
      });
      this.scheduleReconnect();
    };

    // 构造时可能还没有任何 UI 请求等待连接，主动处理拒绝避免未处理 Promise。
    void this.connection.catch(() => undefined);
    return this.connection;
  }

  /** 按响应 ID 完成请求，或把服务端事件分发给对应订阅者。 */
  private handleMessage(
    socket: WebSocket,
    raw: string,
    onHandshakeAck: (ack: Extract<RpcMessage, { type: "handshake_ack" }>) => void,
    handshakeId: string,
  ): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch {
      socket.close(4002, "RPC 服务返回了无效 JSON");
      return;
    }

    if (message.type === "handshake_ack") {
      if (message.id === handshakeId) onHandshakeAck(message);
      return;
    }

    if (message.type === "event") {
      if (message.seq !== undefined) {
        if (message.seq <= this.lastSeenSeq) {
          this.sendSequenceAck();
          return;
        }
        if (this.lastSeenSeq > 0 && message.seq > this.lastSeenSeq + 1) {
          console.warn(`RPC event sequence gap: expected ${this.lastSeenSeq + 1}, received ${message.seq}`);
        }
        this.lastSeenSeq = message.seq;
      }
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
    if (message.type === "error" && message.id === handshakeId) {
      this.setConnectionState({
        status: "disconnected",
        attempt: this.reconnectAttempt,
        lastError: message.error.message,
      });
      socket.close(4001, message.error.code);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.type === "error") {
      const error = new Error(message.error.message) as Error & { code?: string; data?: unknown };
      error.code = message.error.code;
      error.data = message.error.data;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  /** 连接恢复后重试握手；指数退避避免故障时频繁冲击服务端。 */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(500 * 2 ** this.reconnectAttempt, 8_000);
    this.reconnectAttempt += 1;
    this.setConnectionState({
      status: "reconnecting",
      attempt: this.reconnectAttempt,
      nextRetryInMs: delay,
      serverVersion: this.serverVersion,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected().catch(() => undefined);
    }, delay);
  }

  /** 每隔几秒确认已处理的事件，服务端据此回收已确认的缓存。 */
  private startSequenceAckTimer(): void {
    if (this.ackTimer) clearInterval(this.ackTimer);
    this.ackTimer = setInterval(() => this.sendSequenceAck(), 5_000);
  }

  private sendSequenceAck(): void {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      this.lastSeenSeq <= this.lastAckSentSeq
    ) return;

    try {
      socket.send(JSON.stringify({
        type: "sequence_ack",
        id: randomUUID(),
        lastSeq: this.lastSeenSeq,
      } satisfies RpcMessage));
      this.lastAckSentSeq = this.lastSeenSeq;
    } catch {
      // socket 的 close 事件会启动重连；下次连接会携带 lastSeenSeq。
    }
  }

  private emit(channel: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      try {
        listener(...args);
      } catch (error) {
        console.error("RPC event listener failed:", error);
      }
    }
  }

  private setConnectionState(state: RpcConnectionState): void {
    this.connectionState = state;
    for (const listener of this.connectionListeners) {
      try {
        listener({ ...state });
      } catch (error) {
        console.error("RPC connection-state listener failed:", error);
      }
    }
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
