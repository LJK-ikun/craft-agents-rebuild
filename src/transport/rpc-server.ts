import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { RpcBootstrap, RpcMessage, RpcRequestContext } from "./rpc-types.ts";

// 一个频道对应一个后端业务处理函数。
type RpcHandler = (context: RpcRequestContext, ...args: unknown[]) => unknown | Promise<unknown>;

/** 在 Electron 主进程中提供本地 WebSocket-RPC 服务。 */
export class CraftRpcServer {
  // 仅监听本机回环地址，避免 RPC 端口暴露到局域网。
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  // 在 WebSocketServer 开始监听时就注册回调，避免 listen() 调用太晚漏掉事件。
  private readonly listening: Promise<void>;
  // 每次启动生成新令牌，Preload 必须先通过握手才能调用业务频道。
  private readonly token = randomUUID();
  // channel 是稳定的业务方法名，不直接把任意函数名暴露给网页。
  private readonly handlers = new Map<string, RpcHandler>();
  // 只保留已完成令牌握手的客户端，供服务端向指定界面推送事件。
  private readonly clients = new Map<string, WebSocket>();
  private readonly disconnectListeners = new Set<(clientId: string) => void>();

  constructor() {
    this.listening = new Promise<void>((resolve, reject) => {
      this.server.once("listening", resolve);
      this.server.once("error", reject);
    });
    this.server.on("connection", (socket) => this.accept(socket));
  }

  /** 登记一个 Renderer 可以调用的后端频道。 */
  handle(channel: string, handler: RpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`RPC 频道重复注册：${channel}`);
    }
    this.handlers.set(channel, handler);
  }

  /** 注册客户端断线回调，供主进程回收该客户端持有的 Agent 等资源。 */
  onClientDisconnected(listener: (clientId: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** 启动本地 WebSocket 服务，并返回给 Preload 使用的连接资料。 */
  async listen(): Promise<RpcBootstrap> {
    await this.listening;

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("无法取得本地 RPC 服务端口。");
    }

    return {
      url: `ws://127.0.0.1:${address.port}`,
      token: this.token,
    };
  }

  /** 关闭 WebSocket 服务，随 Electron 应用一起退出。 */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** 向指定客户端推送事件；例如把 Agent 的文字增量送回发起请求的窗口。 */
  pushToClient(clientId: string, channel: string, ...args: unknown[]): void {
    const socket = this.clients.get(clientId);
    if (!socket) return;
    this.send(socket, { type: "event", id: randomUUID(), channel, args });
  }

  /** 处理一个新连接：先验令牌，再允许它发送 RPC 请求。 */
  private accept(socket: WebSocket): void {
    const clientId = randomUUID();
    let authenticated = false;

    const handshakeTimer = setTimeout(() => {
      if (!authenticated) socket.close(4003, "握手超时");
    }, 5_000);
    handshakeTimer.unref();

    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      this.clients.delete(clientId);
      for (const listener of this.disconnectListeners) listener(clientId);
    });
    socket.on("message", (raw) => {
      void this.handleMessage(socket, clientId, raw.toString(), () => authenticated, () => {
        authenticated = true;
        this.clients.set(clientId, socket);
        clearTimeout(handshakeTimer);
      });
    });
  }

  /** 验证消息类型、执行频道处理函数，并把结果回给原请求。 */
  private async handleMessage(
    socket: WebSocket,
    clientId: string,
    raw: string,
    isAuthenticated: () => boolean,
    onAuthenticated: () => void,
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

      onAuthenticated();
      this.send(socket, {
        type: "handshake_ack",
        id: message.id,
        protocolVersion: 1,
      });
      return;
    }

    // 不允许客户端跳过握手直接调用业务频道。
    if (!isAuthenticated()) {
      socket.close(4001, "必须先完成 RPC 握手");
      return;
    }

    if (message.type !== "request") return;

    const handler = this.handlers.get(message.channel);
    if (!handler) {
      this.send(socket, {
        type: "error",
        id: message.id,
        error: { message: `找不到 RPC 频道：${message.channel}` },
      });
      return;
    }

    try {
      const result = await handler({ clientId }, ...message.args);
      this.send(socket, { type: "response", id: message.id, result });
    } catch (error) {
      this.send(socket, {
        type: "error",
        id: message.id,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /** 统一把消息编码成 JSON 后写入 WebSocket。 */
  private send(socket: WebSocket, message: RpcMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
