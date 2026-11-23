# WindowManager 导读

文件：`src/main/window-manager.ts`

## 它负责什么

Electron 主进程负责创建桌面窗口。`WindowManager` 把创建窗口、记录窗口、窗口关闭后的清理放在同一个模块里，让 `main.ts` 不必直接处理这些细节。

原版对应模块是 `apps/electron/src/main/window-manager.ts`。原版还负责窗口状态恢复、焦点模式、深链接、关闭流程等；rebuild 会逐项补齐，当前这一步先建立窗口管理的主干。

## 一次创建窗口的过程

```text
main.ts 准备路径与运行模式
  → new WindowManager(config)
  → createWindow({ workspaceId })
  → BrowserWindow 创建窗口
  → 保存到 windows Map
  → 页面加载完成后显示
  → 窗口关闭时从 Map 删除
```

## 关键数据

- `WindowManagerConfig`：窗口需要的 Preload 路径、页面路径、开发服务器地址和打包状态。
- `CreateWindowOptions`：创建窗口时附带的业务信息，目前是所属 `workspaceId`。
- `ManagedWindow`：管理器保存的记录，同时包含 Electron 窗口和所属 workspace。
- `windows`：以 `webContents.id` 为键的 Map，用于跟踪当前窗口。

## 两个重要时机

- `ready-to-show`：页面可以显示后再展示窗口，减少白屏。
- `closed`：窗口销毁后删除 Map 记录，避免管理器留下无效引用。

开发时加载 Vite 地址；打包后加载本地 `index.html`。`main.ts` 负责提供这两种路径，`WindowManager` 负责按 `isPackaged` 选择。
