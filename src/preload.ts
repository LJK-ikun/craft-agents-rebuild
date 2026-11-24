import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AgentEvent } from "./types.ts";

// 目前先暴露一个只读的应用信息示例；后续再逐个增加安全 IPC 能力。
contextBridge.exposeInMainWorld("craftAgent", {
  // 界面调用 ask 时， Preload 把问题送到主进程 agent:ask 通道，
  // invoke 会等主进程处理完，再把回答作为 Promise 返回给界面。
  ask: (userText: string): Promise<string> => ipcRenderer.invoke("agent:ask", userText),

  // 停止当前正在运行的 Agent 请求。
  cancel: (): Promise<boolean> => ipcRenderer.invoke("agent:cancel"),

  // 把工具确认结果送回主进程；网页不能直接访问 Pi 子进程或系统工具。
  respondToPermission: (requestId: string, approved: boolean): Promise<void> =>
    ipcRenderer.invoke("agent:permission-response", requestId, approved),

  // 修改当前会话的权限模式；主进程会先保存，再通知 Agent 后端。
  setPermissionMode: (mode: "explore" | "ask" | "execute"): Promise<string> =>
    ipcRenderer.invoke("session:set-permission-mode", mode),

  // 只暴露 Agent 事件订阅方法，不把整个 ipcRenderer 交给网页。
  onAgentEvent: (callback: (event: AgentEvent) => void): (() => void) => {
    const listener = (_ipcEvent: IpcRendererEvent, event: AgentEvent) => {
      callback(event);
    };

    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },

  // 界面调用 getHistory 时，通过 IPC 向主进程请求历史消息。
  getHistory: (): Promise<
  Array<{ role: "user" | "assistant"; content: string }>
  > => ipcRenderer.invoke("session:history"),

  // 获取所有会话的标题和时间，用于显示会话列表。
  listSessions: () => ipcRenderer.invoke("session:list"),

  // 创建新会话，并返回新会话信息和空消息列表。
  createSession: () => ipcRenderer.invoke("session:create"),

  // 切换到指定会话，主进程会返回该会话的历史消息。
  selectSession: (sessionId: string) =>
    ipcRenderer.invoke("session:select", sessionId),

  // 获取所有已添加的工作区。
  listWorkspaces: () => ipcRenderer.invoke("workspace:list"),

  // 弹出目录选择框并添加工作区；用户取消时主进程返回 null。
  addWorkspace: () => ipcRenderer.invoke("workspace:add"),

  // 切换工作区，并取得该工作区当前会话和聊天记录。
  selectWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke("workspace:select", workspaceId),
})
