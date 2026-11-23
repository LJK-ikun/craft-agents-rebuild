import { contextBridge, ipcRenderer } from "electron";

// 只向网页提供 ask 这一个能力，不把完整 ipcRenderer 暴露出去。
contextBridge.exposeInMainWorld("craftAgent", {
  ask: (userText: string): Promise<string> =>
    ipcRenderer.invoke("agent:ask", userText),
});
