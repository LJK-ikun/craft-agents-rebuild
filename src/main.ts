import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.ts";
import { OpenAICompatibleProvider } from "./provider.ts";
import { JsonlSessionStore } from "./jsonl-store.ts";

// ESM 文件没有内置 __dirname；用当前文件地址还原出它所在的目录。
const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

// 模型配置只从主进程环境变量读取，密钥不会进入网页界面。
const apiKey = process.env.OPENAI_API_KEY;
const modelName = process.env.OPENAI_MODEL;
const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// 配置齐全时创建 Agent；没有配置时，应用仍可启动并在调用时提示用户。
let agent: Agent | null = null;
let sessionStore: JsonlSessionStore | null = null;

// 注册主进程的 IPC 处理器，接收界面之后通过 Preload 送来的问题。
ipcMain.handle("agent:ask", async (_event, userText: unknown): Promise<string> => {
  // IPC 输入来自界面，先检查类型和内容，不能直接当作可信数据使用。
  if (typeof userText !== "string" || !userText.trim()) {
    throw new Error("请输入有效的问题。");
  }

  // Agent 为空表示启动时没有同时配置 API Key 和模型名称。
  if (!agent) {
    throw new Error("请先设置 OPENAI_API_KEY 和 OPENAI_MODEL。");
  }
  // 正常情况下窗口加载前已完成存储初始化；这里保留明确的异常提示。
  if (!sessionStore) throw new Error("会话存储尚未初始化。");

  const question = userText.trim();
  // 先拿到成功回答，再把这轮问答都追加保存到 JSONL 文件。
  const answer = await agent.ask(question);
  await sessionStore.appendMessage({ role: "user", content: question });
  await sessionStore.appendMessage({ role: "assistant", content: answer });
  return answer;
});

async function createMainWindow(): Promise<void> {
  // 会话文件放在 Electron 用户数据目录，应用重启后仍可读取。
  sessionStore = new JsonlSessionStore(
    path.join(app.getPath("userData"), "sessions", "default", "session.jsonl"),
  );
  const previousMessages = await sessionStore.loadMessages();

  // 先读取历史，再创建 Agent，让它从已有对话继续。
  if (apiKey && modelName) {
    agent = new Agent(
      new OpenAICompatibleProvider(apiKey, modelName, baseUrl),
      "你是一个简洁、准确的中文助手。",
      previousMessages,
    );
  }

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
