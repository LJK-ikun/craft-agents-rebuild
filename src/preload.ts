import { contextBridge, ipcRenderer } from "electron";

// 目前先暴露一个只读的应用信息示例；后续再逐个增加安全 IPC 能力。
contextBridge.exposeInMainWorld("craftAgent", {
  // 界面调用 ask 时， Preload 把问题送到主进程 agent:ask 通道，
  // invoke 会等主进程处理完，再把回答作为 Promise 返回给界面。
  ask: (userText: string): Promise<string> => ipcRenderer.invoke("agent:ask", userText),

})
