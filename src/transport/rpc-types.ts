// RPC 消息类型：客户端和服务端共享这套 JSON 结构。
export type RpcMessage =
  | { type: "handshake"; id: string; clientId: string; token: string; protocolVersion: 1 }
  | { type: "handshake_ack"; id: string; protocolVersion: 1 }
  | { type: "request"; id: string; channel: string; args: unknown[] }
  | { type: "event"; id: string; channel: string; args: unknown[] }
  | { type: "response"; id: string; result: unknown }
  | { type: "error"; id: string; error: { message: string } };

// 让后端 handler 知道请求来自哪个已握手的桌面客户端。
export type RpcRequestContext = {
  clientId: string;
};

// Preload 先通过 Electron IPC 得到连接地址和一次性应用令牌。
export type RpcBootstrap = {
  url: string;
  token: string;
  // Renderer WebContents 的稳定 ID；断线重连后可恢复同一份客户端运行状态。
  clientId?: string;
};
