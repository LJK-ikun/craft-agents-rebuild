import { BrowserWindow } from "electron";

// 主入口交给 WindowManager 的配置。
// WindowManager 不自己猜路径或环境，而是使用调用者明确传入的值。
export type WindowManagerConfig = {
  // Preload 脚本的磁盘路径；BrowserWindow 创建时会加载它。
  preloadPath: string;
  // 打包后 Vite 生成的本地 HTML 文件路径。
  rendererFilePath: string;
  // 开发时 Vite 开发服务器的地址。
  rendererDevUrl: string;
  // true 表示正式打包运行，false 表示本地开发运行。
  isPackaged: boolean;
};

// 创建窗口时需要的业务信息。原版窗口属于一个 workspace，
// 因此这里也保留 workspaceId，后续可用于多工作区窗口管理。
export type CreateWindowOptions = {
  workspaceId: string;
};

// WindowManager 内部保存的窗口记录：除了窗口对象，还记录其所属 workspace。
type ManagedWindow = {
  window: BrowserWindow;
  workspaceId: string;
};

// 集中管理 Electron 窗口的创建、查找和销毁清理。
export class WindowManager {
  // Map 的 key 是 Electron 为页面分配的 webContents.id；
  // value 同时保存 BrowserWindow 和业务上的 workspaceId。
  private readonly windows = new Map<number, ManagedWindow>();

  // 保存主入口提供的路径和运行模式，供 createWindow 使用。
  constructor(private readonly config: WindowManagerConfig) {}

  // 为指定 workspace 创建一个桌面窗口，并返回窗口对象给调用方。
  createWindow(options: CreateWindowOptions): BrowserWindow {
    const window = new BrowserWindow({
      // 默认窗口尺寸；minWidth/minHeight 限制用户不能缩得过小。
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      // 先隐藏窗口，等页面首帧准备好再显示，减少白屏闪烁。
      show: false,
      webPreferences: {
        // Preload 提供受控的主进程能力。
        preload: this.config.preloadPath,
        // 隔离网页 JavaScript 环境，并禁止网页直接使用 Node.js API。
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // webContents.id 标识窗口中的网页上下文，用它作为 Map 的键。
    const windowId = window.webContents.id;
    // 保存窗口记录，之后可以统一列出窗口或在关闭时移除它。
    this.windows.set(windowId, { window, workspaceId: options.workspaceId });

    // closed 事件只触发一次。窗口销毁后必须从 Map 删除，
    // 否则管理器会一直持有已失效的窗口引用。
    window.once("closed", () => {
      this.windows.delete(windowId);
    });

    // ready-to-show 表示页面已经可以展示；此时再显示窗口。
    window.once("ready-to-show", () => window.show());

    // 开发环境使用 Vite 热更新服务器；正式应用使用打包后的本地 HTML。
    if (this.config.isPackaged) {
      // void 表明这里启动异步导航，但当前函数不等待页面加载完成。
      void window.loadFile(this.config.rendererFilePath);
    } else {
      void window.loadURL(this.config.rendererDevUrl);
    }

    return window;
  }

  // 返回当前仍由管理器登记的所有窗口，忽略已关闭并清理的窗口。
  getWindows(): BrowserWindow[] {
    return Array.from(this.windows.values()).map(({ window }) => window);
  }

  // 按 workspace 查找窗口。一个窗口对应一个 workspace，
  // 因此找到第一条仍然存活的匹配记录就可以返回。
  getWindowByWorkspace(workspaceId: string): BrowserWindow | null {
    for (const managed of this.windows.values()) {
      // BrowserWindow 关闭后可能仍短暂留在事件处理过程中，
      // isDestroyed() 用来避免把已经销毁的窗口交给调用方。
      if (managed.workspaceId === workspaceId && !managed.window.isDestroyed()) {
        return managed.window;
      }
    }
    // null 明确表示当前没有可复用的窗口。
    return null;
  }

  // IPC 事件提供的是 webContents.id；通过它反查该窗口当前属于哪个 workspace。
  getWorkspaceForWindow(webContentsId: number): string | null {
    const managed = this.windows.get(webContentsId);
    return managed?.workspaceId ?? null;
  }

  // 如果该 workspace 已经有窗口，就把它带回屏幕并聚焦；
  // 否则创建新窗口。这是“避免同一 workspace 重复开窗”的入口。
  focusOrCreateWindow(workspaceId: string): BrowserWindow {
    const existing = this.getWindowByWorkspace(workspaceId);

    if (existing) {
      // 最小化窗口仍存在，只是收进了任务栏；先恢复才能正常显示。
      if (existing.isMinimized()) {
        existing.restore();
      }

      // 把现有窗口放到用户面前，并返回这个窗口对象。
      existing.focus();
      return existing;
    }

    // 没找到可用窗口时，复用已有创建逻辑，保证加载页面和登记映射一致。
    return this.createWindow({ workspaceId });
  }
}
