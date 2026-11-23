import { contextBridge } from "electron";

// 目前先暴露一个只读的应用信息示例；后续再逐个增加安全 IPC 能力。
contextBridge.exposeInMainWorld("craftAgent", {
  appName: "Craft Agents Learning Rebuild",
});
