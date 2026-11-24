import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent } from "./types.ts";
import { CraftRpcClient } from "./transport/rpc-client.ts";
import type { RpcConnectionState } from "./transport/rpc-client.ts";
import type { RpcBootstrap } from "./transport/rpc-types.ts";

// 启动时用一次同步 IPC 获取本地 WebSocket 地址和令牌；业务请求随后走 RPC。
const rpcBootstrap = ipcRenderer.sendSync("rpc:bootstrap") as RpcBootstrap | null;
if (!rpcBootstrap) throw new Error("主进程尚未启动 RPC 服务。");
const rpcClient = new CraftRpcClient(rpcBootstrap);

// 只把业务方法暴露给网页；Renderer 本身拿不到 ipcRenderer 或 WebSocket。
contextBridge.exposeInMainWorld("craftAgent", {
  // 每个 invoke 都是一个带频道名和参数的 RPC 请求。
  ask: (userText: string): Promise<string> => rpcClient.invoke("agent:ask", userText),

  // 停止当前正在运行的 Agent 请求。
  cancel: (): Promise<boolean> => rpcClient.invoke("agent:cancel"),

  // 把工具确认结果送回主进程；网页不能直接访问 Pi 子进程或系统工具。
  respondToPermission: (requestId: string, approved: boolean): Promise<void> =>
    rpcClient.invoke("agent:permission-response", requestId, approved),

  // 修改当前会话的权限模式；主进程会先保存，再通知 Agent 后端。
  setPermissionMode: (mode: "explore" | "ask" | "execute"): Promise<string> =>
    rpcClient.invoke("session:set-permission-mode", mode),

  // 只暴露 Agent 事件订阅方法，不把整个 ipcRenderer 交给网页。
  onAgentEvent: (callback: (event: AgentEvent) => void): (() => void) => {
    return rpcClient.on("agent:event", (...args) => callback(args[0] as AgentEvent));
  },

  // 事件缓存已经过期时通知 Renderer；由界面重新读取当前工作区和会话。
  onTransportStale: (callback: () => void): (() => void) =>
    rpcClient.on("transport:stale", callback),

  // 暴露连接状态订阅，供界面显示连接中、已连接或正在重连。
  onConnectionStateChanged: (callback: (state: RpcConnectionState) => void): (() => void) =>
    rpcClient.onConnectionStateChanged(callback),

  // 允许界面或路由器在调用前检查服务器是否注册了该频道。
  isChannelAvailable: (channel: string): boolean => rpcClient.isChannelAvailable(channel),

  // 通过 RPC 读取当前会话的历史消息。
  getHistory: (): Promise<
  Array<{ role: "user" | "assistant"; content: string }>
  > => rpcClient.invoke("session:history"),

  // 会话和工作区操作统一通过 WebSocket-RPC 到达主进程。
  listSessions: () => rpcClient.invoke("session:list"),

  // 修改会话的 Inbox 工作流状态。
  setSessionStatus: (sessionId: string, statusId: string) =>
    rpcClient.invoke("session:set-status", sessionId, statusId),

  // 修改会话的 Flag 标记。
  setSessionFlag: (sessionId: string, isFlagged: boolean) =>
    rpcClient.invoke("session:set-flag", sessionId, isFlagged),

  // 创建新会话，并返回新会话信息和空消息列表。
  createSession: () => rpcClient.invoke("session:create"),

  // 切换到指定会话，主进程会返回该会话的历史消息。
  selectSession: (sessionId: string) =>
    rpcClient.invoke("session:select", sessionId),

  // 获取所有已添加的工作区。
  listWorkspaces: () => rpcClient.invoke("workspace:list"),

  // 弹出目录选择框并添加工作区；用户取消时主进程返回 null。
  addWorkspace: () => rpcClient.invoke("workspace:add"),

  // 由主进程弹出文件选择框并导入知识文档或 Skill Markdown。
  addWorkspaceResource: (kind: "source" | "skill") =>
    rpcClient.invoke("workspace:add-resource", kind),

  // 切换工作区，并取得该工作区当前会话和聊天记录。
  selectWorkspace: (workspaceId: string) =>
    rpcClient.invoke("workspace:select", workspaceId),

  // 服务端无法补齐事件时，根据 Renderer 记住的选择恢复界面状态。
  restoreWorkspaceState: (workspaceId: string, sessionId: string) =>
    rpcClient.invoke("workspace:restore", workspaceId, sessionId),
})
