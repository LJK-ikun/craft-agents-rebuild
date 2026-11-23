import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM 文件没有内置 __dirname；用当前文件地址还原出它所在的目录。
const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

function createMainWindow(): void {
  // 主进程创建桌面窗口，并指定它加载哪个 Preload 和网页。
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      // Preload 在主进程与网页之间提供受控桥梁。
      preload: path.join(currentDirectory, "preload.cjs"),
      // 隔离网页和 Preload 的 JavaScript 环境。
      contextIsolation: true,
      // 不允许网页直接访问 Node.js 能力。
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    // 打包后加载 Vite 构建出的本地页面。
    void window.loadFile(path.join(currentDirectory, "renderer", "index.html"));
  } else {
    // 开发时加载 Vite 开发服务器；需要另一个终端运行 npm run dev:ui。
    void window.loadURL("http://127.0.0.1:5173");
  }
}

// Electron 初始化完成后才能创建窗口。
void app.whenReady().then(createMainWindow);

// macOS 通常在关闭窗口后保留应用；其他平台关闭窗口就退出。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
