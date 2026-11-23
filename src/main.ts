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

// 每个工作区各自持有 Agent 和会话文件，避免不同工作区混用聊天上下文。
type WorkspaceRuntime = {
  agent: Agent | null;
  sessionStore: JsonlSessionStore;
};
const workspaceRuntimes = new Map<string, WorkspaceRuntime>();

// 保存窗口管理器实例，让应用启动后的 activate 事件也能复用它。
let windowManager: WindowManager | null = null;
// 保存工作区清单存储，让 IPC 请求可以校验窗口所属 workspace。
let workspaceStore: JsonWorkspaceStore | null = null;
// 记住启动时选中的工作区，窗口重新打开时仍使用同一个 ID。
let activeWorkspaceId: string | null = null;

// 按 ID 读取或初始化一个工作区运行时：会话文件和 Agent 历史都属于该工作区。
async function getWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
  const existing = workspaceRuntimes.get(workspaceId);
  if (existing) return existing;
  if (!workspaceStore) throw new Error("工作区存储尚未初始化。");

  // 只允许已登记的 workspace ID 创建运行时，避免任意字符串生成会话目录。
  const workspace = (await workspaceStore.list()).find((item) => item.id === workspaceId);
  if (!workspace) throw new Error("找不到这个工作区。");

  const sessionStore = new JsonlSessionStore(
    path.join(app.getPath("userData"), "sessions", workspace.id, "session.jsonl"),
    workspace.id,
  );
  const previousMessages = await sessionStore.loadMessages();

  // 没有模型配置时仍然可以打开工作区，只是发送问题时会提示补充配置。
  const agent = apiKey && modelName
    ? new Agent(
        new OpenAICompatibleProvider(apiKey, modelName, baseUrl),
        "你是一个简洁、准确的中文助手。",
        previousMessages,
      )
    : null;

  const runtime = { agent, sessionStore };
  workspaceRuntimes.set(workspaceId, runtime);
  return runtime;
}

// 注册一个固定 IPC 通道：接收界面的问题，调用 Agent，并返回回答。
ipcMain.handle("agent:ask", async (event, userText: unknown): Promise<string> => {
  if (typeof userText !== "string" || !userText.trim()) {
    throw new Error("请输入有效的问题。");
  }
  if (!apiKey || !modelName) {
    throw new Error("请先设置 OPENAI_API_KEY 和 OPENAI_MODEL。");
  }

  // IPC 发送方就是当前窗口；用它反查 workspace，确保请求进入正确的会话。
  const workspaceId = windowManager?.getWorkspaceForWindow(event.sender.id);
  if (!workspaceId) throw new Error("无法确定当前窗口所属的工作区。");
  const runtime = await getWorkspaceRuntime(workspaceId);
  if (!runtime.agent) throw new Error("当前工作区的 Agent 尚未准备好。");

  const question = userText.trim();
  await runtime.sessionStore.appendMessage({ role: "user", content: question });
  const answer = await runtime.agent.ask(question);
  await runtime.sessionStore.appendMessage({ role: "assistant", content: answer });
  return answer;
});

async function createMainWindow(): Promise<void> {
  // 先从全局清单读取工作区；首次启动时自动创建默认工作区记录和目录。
  workspaceStore = new JsonWorkspaceStore(
    path.join(app.getPath("userData"), "workspaces.json"),
  );
  const workspace = await workspaceStore.ensureDefaultWorkspace(
    path.join(app.getPath("userData"), "workspaces", "default"),
  );
  activeWorkspaceId = workspace.id;

  // 预先载入默认工作区；应用重启后 Agent 能接着该工作区的聊天记录继续。
  await getWorkspaceRuntime(workspace.id);

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
