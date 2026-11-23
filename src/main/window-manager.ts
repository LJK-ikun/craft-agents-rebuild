import { BrowserWindow } from "electron";

// WindowManager 只管理桌面窗口；路径和开发/打包状态由 Electron 主入口传入。
export type WindowManagerConfig = {
  preloadPath: string;
  rendererFilePath: string;
  rendererDevUrl: string;
  isPackaged: boolean;
};

// 和原版一样，窗口还要关联它所属的 workspace。
export type CreateWindowOptions = {
  workspaceId: string;
};

type ManagedWindow = {
  window: BrowserWindow;
  workspaceId: string;
};

export class WindowManager {
  // 用 webContents.id 找回对应窗口和它所属的 workspace。
  private readonly windows = new Map<number, ManagedWindow>();

  constructor(private readonly config: WindowManagerConfig) {}

  createWindow(options: CreateWindowOptions): BrowserWindow {
    const window = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      // 等窗口第一帧准备好再显示，减少启动时的白屏闪烁。
      show: false,
      webPreferences: {
        preload: this.config.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const windowId = window.webContents.id;
    this.windows.set(windowId, { window, workspaceId: options.workspaceId });

    // 窗口关闭后从管理表移除，避免保留已销毁窗口。
    window.once("closed", () => {
      this.windows.delete(windowId);
    });

    // 页面首帧就绪后再显示窗口。
    window.once("ready-to-show", () => window.show());

    // 开发时加载 Vite 地址；打包后加载本地构建文件。
    if (this.config.isPackaged) {
      void window.loadFile(this.config.rendererFilePath);
    } else {
      void window.loadURL(this.config.rendererDevUrl);
    }

    return window;
  }

  getWindows(): BrowserWindow[] {
    return Array.from(this.windows.values()).map(({ window }) => window);
  }
}
