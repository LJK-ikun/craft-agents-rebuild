import { app, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.ts";
import { OpenAICompatibleProvider } from "./provider.ts";
import { JsonlSessionStore } from "./sessions/jsonl-store.ts";
import { WindowManager } from "./main/window-manager.ts";
import { JsonWorkspaceStore } from "./workspaces/workspace-store.ts";

// ESM 文件没有内置 __dirname；用当前文件地址还原出它所在的目录。
const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

// Agent 放在主进程中创建；密钥不会发送到网页界面。
const apiKey = process.env.OPENAI_API_KEY;
const modelName = process.env.OPENAI_MODEL;
const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
let agent: Agent | null = null;
let sessionStore: JsonlSessionStore | null = null;
// 保存窗口管理器实例，让应用启动后的 activate 事件也能复用它。
let windowManager: WindowManager | null = null;
// 记住启动时选中的工作区，窗口重新打开时仍使用同一个 ID。
let activeWorkspaceId: string | null = null;

// 注册一个固定 IPC 通道：接收界面的问题，调用 Agent，并返回回答。
ipcMain.handle("agent:ask", async (_event, userText: unknown): Promise<string> => {
  if (typeof userText !== "string" || !userText.trim()) {
    throw new Error("请输入有效的问题。");
  }
  if (!apiKey || !modelName) {
    throw new Error("请先设置 OPENAI_API_KEY 和 OPENAI_MODEL。");
  }
  if (!agent || !sessionStore) {
    throw new Error("会话还没有准备好，请稍后重试。");
  }

  const question = userText.trim();
  await sessionStore.appendMessage({ role: "user", content: question });
  const answer = await agent.ask(question);
  await sessionStore.appendMessage({ role: "assistant", content: answer });
  return answer;
});

async function createMainWindow(): Promise<void> {
  // 先从全局清单读取工作区；首次启动时自动创建默认工作区记录和目录。
  const workspaceStore = new JsonWorkspaceStore(
    path.join(app.getPath("userData"), "workspaces.json"),
  );
  const workspace = await workspaceStore.ensureDefaultWorkspace(
    path.join(app.getPath("userData"), "workspaces", "default"),
  );
  activeWorkspaceId = workspace.id;

  // 会话仍按工作区 ID 分目录保存，后面增加多个工作区时可以自然隔离。
  sessionStore = new JsonlSessionStore(
    path.join(app.getPath("userData"), "sessions", workspace.id, "session.jsonl"),
    workspace.id,
  );
  const previousMessages = await sessionStore.loadMessages();

  // 用磁盘历史初始化 Agent，使应用重启后模型仍能接续这段对话。
  if (apiKey && modelName) {
    agent = new Agent(
      new OpenAICompatibleProvider(apiKey, modelName, baseUrl),
      "你是一个简洁、准确的中文助手。",
      previousMessages,
    );
  }

  // 窗口创建和生命周期交给 WindowManager，主入口只负责启动编排。
  windowManager = new WindowManager({
    preloadPath: path.join(currentDirectory, "preload.cjs"),
    rendererFilePath: path.join(currentDirectory, "renderer", "index.html"),
    rendererDevUrl: "http://127.0.0.1:5173",
    isPackaged: app.isPackaged,
  });
  windowManager.createWindow({ workspaceId: workspace.id });
}

// Electron 初始化完成后才能创建窗口。
void app.whenReady().then(createMainWindow).catch((error: unknown) => {
  console.error("Failed to initialize the application:", error);
});

// macOS 关闭最后一个窗口时应用仍会留在 Dock；再次点击图标会触发 activate。
// 如果此时没有窗口，就重新打开默认 workspace；若窗口还存在则不重复创建。
app.on("activate", () => {
  if (windowManager && activeWorkspaceId && windowManager.getWindows().length === 0) {
    windowManager.focusOrCreateWindow(activeWorkspaceId);
  }
});

// macOS 通常在关闭窗口后保留应用；其他平台关闭窗口就退出。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
