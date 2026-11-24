import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { RpcBootstrap, RpcMessage, RpcRequestContext } from "./rpc-types.ts";

type RpcHandler = (context: RpcRequestContext, ...args: unknown[]) => unknown | Promise<unknown>;

type BufferedEvent = {
  seq: number;
  data: string;
  timestamp: number;
};

type RpcClient = {
  id: string;
  socket: WebSocket | null;
  webContentsId: number | null;
  workspaceId: string | null;
  lastSentSeq: number;
  lastAckedSeq: number;
  missedPongs: number;
  eventBuffer: BufferedEvent[];
};

const EVENT_BUFFER_MAX_SIZE = 500;
const EVENT_BUFFER_TTL_MS = 30_000;
const DISCONNECTED_CLIENT_TTL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MAX_MISSED = 2;

/** 本地 WebSocket-RPC 服务：负责调用、客户端恢复、可靠事件推送和心跳。 */
export class CraftRpcServer {
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  private readonly listening: Promise<void>;
  private readonly token = randomUUID();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly clients = new Map<string, RpcClient>();
  private readonly disconnectedClients = new Map<
    string,
    { client: RpcClient; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly disconnectListeners = new Set<(clientId: string) => void>();
  private readonly connectListeners = new Set<(clientId: string) => void>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closing = false;

  constructor() {
    this.listening = new Promise<void>((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
    this.server.on("connection", (socket) => this.accept(socket));
    this.heartbeat = setInterval(() => this.pingClients(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
  }

  /** 登记一个 Renderer 可以调用的后端频道。 */
  handle(channel: string, handler: RpcHandler): void {
    if (this.handlers.has(channel)) throw new Error(`RPC 频道重复注册：${channel}`);
    this.handlers.set(channel, handler);
  }

  /** 客户端断开时通知主进程；主进程会暂存运行状态，等待恢复连接。 */
  onClientDisconnected(listener: (clientId: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** 客户端恢复连接时通知主进程取消状态清理计时。 */
  onClientConnected(listener: (clientId: string) => void): () => void {
    this.connectListeners.add(listener);
    return () => this.connectListeners.delete(listener);
  }

  /** 启动本地服务，并返回 Preload 建立连接所需的地址和令牌。 */
  async listen(): Promise<RpcBootstrap> {
    await this.listening;
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("无法取得本地 RPC 服务端口。");
    return { url: `ws://127.0.0.1:${address.port}`, token: this.token };
  }

  /** 关闭服务并清理断线客户端的保留计时。 */
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.heartbeat);
    for (const entry of this.disconnectedClients.values()) clearTimeout(entry.timer);
    this.disconnectedClients.clear();
    for (const client of this.clients.values()) client.socket?.close(1001, "应用退出");
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** 给客户端推送带序号的事件，并保留一段时间用于断线补发。 */
  pushToClient(clientId: string, channel: string, ...args: unknown[]): void {
    const client = this.clients.get(clientId) ?? this.disconnectedClients.get(clientId)?.client;
    if (!client) return;

    const seq = ++client.lastSentSeq;
    const message: RpcMessage = { type: "event", id: randomUUID(), channel, args, seq };
    const data = JSON.stringify(message);
    client.eventBuffer.push({ seq, data, timestamp: Date.now() });
    this.evictBuffer(client);

    const socket = client.socket;
    if (socket && socket.readyState === socket.OPEN) socket.send(data);
  }

  /** 建立未认证连接；只有握手成功后才能调用业务频道。 */
  private accept(socket: WebSocket): void {
    let clientId: string | null = null;
    let authenticated = false;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) socket.close(4003, "握手超时");
    }, 5_000);
    handshakeTimer.unref();

    socket.on("pong", () => {
      if (!clientId) return;
      const client = this.clients.get(clientId);
      if (client?.socket === socket) client.missedPongs = 0;
    });

    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      if (this.closing) return;
      if (!clientId) return;
      const client = this.clients.get(clientId);
      // 旧连接关闭时不能移除刚恢复的新连接。
      if (!client || client.socket !== socket) return;

      this.clients.delete(clientId);
      client.socket = null;
      this.disconnectListeners.forEach((listener) => listener(clientId!));
      const timer = setTimeout(() => {
        this.disconnectedClients.delete(clientId!);
      }, DISCONNECTED_CLIENT_TTL_MS);
      timer.unref();
      this.disconnectedClients.set(clientId, { client, timer });
      if (this.disconnectedClients.size > 50) {
        const oldestId = this.disconnectedClients.keys().next().value;
        if (oldestId) {
          const oldest = this.disconnectedClients.get(oldestId);
          if (oldest) clearTimeout(oldest.timer);
          this.disconnectedClients.delete(oldestId);
        }
      }
    });

    socket.on("message", (raw) => {
      void this.handleMessage(
        socket,
        raw.toString(),
        () => clientId,
        () => authenticated,
        (client, reconnected, stale, handshakeId) => {
          clientId = client.id;
          authenticated = true;
          clearTimeout(handshakeTimer);
          this.send(socket, {
            type: "handshake_ack",
            id: handshakeId,
            protocolVersion: 1,
            clientId: client.id,
            reconnected,
            stale,
          });
          this.clients.set(client.id, client);
          for (const listener of this.connectListeners) listener(client.id);
        },
      );
    });
  }

  /** 验证握手、恢复事件游标、处理 ACK，或派发普通 RPC 请求。 */
  private async handleMessage(
    socket: WebSocket,
    raw: string,
    getClientId: () => string | null,
    isAuthenticated: () => boolean,
    authenticate: (client: RpcClient, reconnected: boolean, stale: boolean, handshakeId: string) => void,
  ): Promise<void> {
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch {
      socket.close(4002, "无效 JSON");
      return;
    }

    if (message.type === "handshake") {
      if (message.protocolVersion !== 1 || message.token !== this.token) {
        socket.close(4001, "RPC 握手验证失败");
        return;
      }
      if (message.webContentsId !== undefined && !Number.isSafeInteger(message.webContentsId)) {
        socket.close(4001, "RPC 窗口身份无效");
        return;
      }

      if (message.reconnectClientId && typeof message.lastSeq === "number") {
        const entry = this.disconnectedClients.get(message.reconnectClientId);
        if (
          entry &&
          entry.client.webContentsId === (message.webContentsId ?? null) &&
          entry.client.workspaceId === (message.workspaceId ?? null)
        ) {
          clearTimeout(entry.timer);
          this.disconnectedClients.delete(message.reconnectClientId);
          const client = entry.client;
          client.socket = socket;
          client.missedPongs = 0;
          this.evictBuffer(client);

          const firstBufferedSeq = client.eventBuffer[0]?.seq;
          const missedEvents = message.lastSeq < client.lastSentSeq;
          const canReplay = !missedEvents ||
            (firstBufferedSeq !== undefined && message.lastSeq >= firstBufferedSeq - 1);
          authenticate(client, true, !canReplay, message.id);

          if (canReplay) {
            for (const event of client.eventBuffer) {
              if (event.seq > message.lastSeq) socket.send(event.data);
            }
          } else {
            client.lastAckedSeq = client.lastSentSeq;
            client.eventBuffer = [];
          }
          return;
        }
      }

      const client: RpcClient = {
        id: randomUUID(),
        socket,
        webContentsId: message.webContentsId ?? null,
        workspaceId: message.workspaceId ?? null,
        lastSentSeq: 0,
        lastAckedSeq: 0,
        missedPongs: 0,
        eventBuffer: [],
      };
      // 客户端曾有身份但服务端已忘记它：新建身份并要求 Renderer 完整刷新。
      const stale = Boolean(message.reconnectClientId);
      authenticate(client, false, stale, message.id);
      return;
    }

    if (!isAuthenticated()) {
      socket.close(4001, "必须先完成 RPC 握手");
      return;
    }

    const clientId = getClientId();
    if (!clientId) return;

    if (message.type === "sequence_ack") {
      const client = this.clients.get(clientId);
      if (!client || !Number.isInteger(message.lastSeq)) return;
      client.lastAckedSeq = Math.max(client.lastAckedSeq, Math.min(message.lastSeq, client.lastSentSeq));
      this.evictBuffer(client);
      return;
    }

    if (message.type !== "request") return;
    const handler = this.handlers.get(message.channel);
    if (!handler) {
      this.send(socket, { type: "error", id: message.id, error: { message: `找不到 RPC 频道：${message.channel}` } });
      return;
    }

    try {
      const result = await handler({ clientId }, ...message.args);
      const client = this.clients.get(clientId);
      if (client && ["workspace:select", "workspace:restore", "workspace:add"].includes(message.channel)) {
        const state = result as { workspace?: { id?: unknown } } | null;
        if (typeof state?.workspace?.id === "string") client.workspaceId = state.workspace.id;
      }
      const responseSocket = client?.socket ?? socket;
      this.send(responseSocket, { type: "response", id: message.id, result });
    } catch (error) {
      const responseSocket = this.clients.get(clientId)?.socket ?? socket;
      this.send(responseSocket, {
        type: "error",
        id: message.id,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /** 定期剔除已确认/过期事件，并限制缓存最大长度。 */
  private evictBuffer(client: RpcClient): void {
    const cutoff = Date.now() - EVENT_BUFFER_TTL_MS;
    client.eventBuffer = client.eventBuffer.filter((event) =>
      event.seq > client.lastAckedSeq && event.timestamp >= cutoff,
    );
    if (client.eventBuffer.length > EVENT_BUFFER_MAX_SIZE) {
      client.eventBuffer.splice(0, client.eventBuffer.length - EVENT_BUFFER_MAX_SIZE);
    }
  }

  /** WebSocket ping/pong 心跳；连续漏掉两次 pong 就关闭失效连接。 */
  private pingClients(): void {
    for (const client of this.clients.values()) {
      const socket = client.socket;
      if (!socket || socket.readyState !== socket.OPEN) continue;
      if (client.missedPongs >= HEARTBEAT_MAX_MISSED) {
        socket.terminate();
        continue;
      }
      client.missedPongs += 1;
      socket.ping();
    }
  }

  private send(socket: WebSocket, message: RpcMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }
}
