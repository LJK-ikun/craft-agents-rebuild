import { contextBridge, ipcRenderer } from "electron";

// 目前先暴露一个只读的应用信息示例；后续再逐个增加安全 IPC 能力。
contextBridge.exposeInMainWorld("craftAgent", {
  // 界面调用 ask 时， Preload 把问题送到主进程 agent:ask 通道，
  // invoke 会等主进程处理完，再把回答作为 Promise 返回给界面。
  ask: (userText: string): Promise<string> => ipcRenderer.invoke("agent:ask", userText),

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
