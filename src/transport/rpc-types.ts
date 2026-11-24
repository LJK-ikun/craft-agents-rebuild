// RPC 消息类型：客户端和服务端共享这套 JSON 结构。
export const RPC_PROTOCOL_VERSION = "1.0";

export type RpcError = {
  code: string;
  message: string;
  data?: unknown;
};

export type RpcMessage =
  | {
      type: "handshake";
      id: string;
      token: string;
      protocolVersion: string;
      webContentsId?: number;
      workspaceId?: string;
      reconnectClientId?: string;
      lastSeq?: number;
    }
  | {
      type: "handshake_ack";
      id: string;
      protocolVersion: string;
      clientId: string;
      reconnected?: boolean;
      stale?: boolean;
      registeredChannels?: string[];
      serverVersion?: string;
    }
  | { type: "request"; id: string; channel: string; args: unknown[] }
  | { type: "event"; id: string; channel: string; args: unknown[]; seq?: number }
  | { type: "sequence_ack"; id: string; lastSeq: number }
  | { type: "response"; id: string; result: unknown }
  | { type: "error"; id: string; error: RpcError };

// 让后端 handler 知道请求来自哪个已握手的桌面客户端。
export type RpcRequestContext = {
  clientId: string;
};

// Preload 先通过 Electron IPC 得到连接地址和一次性应用令牌。
export type RpcBootstrap = {
  url: string;
  token: string;
  // 用于校验这条重连连接仍来自原来的 Electron 窗口。
  webContentsId?: number;
};
