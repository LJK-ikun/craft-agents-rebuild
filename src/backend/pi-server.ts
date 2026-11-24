import { createInterface } from "node:readline";
import { AuthStorage, createAgentSession } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";

// Pi 子进程与 Electron 主进程之间只传 JSONL，不把 Pi 的运行时塞进 Electron。
type ServerRequest =
  | {
      type: "init";
      cwd: string;
      provider: string;
      model: string;
      apiKey: string;
    }
  | { type: "ask"; id: string; message: string }
  | { type: "close" };

type ServerResponse =
  | { type: "ready" }
  | { type: "answer"; id: string; answer: string }
  | { type: "error"; id?: string; error: string };

function send(response: ServerResponse): void {
  // stdout 是协议通道，所有日志应该写 stderr。
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function getLatestAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";

  // 从最新消息向前找 assistant，避免把工具调用前的旧回答当成本轮答案。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: unknown;
      content?: unknown;
    };
    if (message.role !== "assistant") continue;

    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n");
    }
  }

  return "";
}

let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

// 服务进程初始化一次 Pi session，之后可以为同一会话连续回答多个问题。
input.on("line", (line) => {
  void handleLine(line);
});

async function handleLine(line: string): Promise<void> {
  let request: ServerRequest;

  try {
    request = JSON.parse(line) as ServerRequest;
  } catch {
    send({ type: "error", error: "收到无效的 JSONL 请求。" });
    return;
  }

  if (request.type === "init") {
    try {
      const model = getModel(request.provider, request.model);
      if (!model) throw new Error(`Pi SDK 找不到模型：${request.provider}/${request.model}`);

      // 凭据仅在 Pi 子进程内存中设置，不写入 Pi 的全局 auth.json。
      const authStorage = AuthStorage.inMemory();
      authStorage.setRuntimeApiKey(request.provider, request.apiKey);

      const created = await createAgentSession({
        cwd: request.cwd,
        model,
        authStorage,
        tools: ["read"],
      });
      session = created.session;
      send({ type: "ready" });
    } catch (error) {
      send({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (request.type === "close") {
    session?.dispose();
    process.exit(0);
  }

  if (!session) {
    send({ type: "error", id: request.id, error: "Pi session 尚未初始化。" });
    return;
  }

  try {
    await session.prompt(request.message);
    const answer = getLatestAssistantText(session.agent.state.messages);
    if (!answer) throw new Error("Pi SDK 没有返回文本回答。");
    send({ type: "answer", id: request.id, answer });
  } catch (error) {
    send({
      type: "error",
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
