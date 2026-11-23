import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Agent } from "./agent.ts";
import { OpenAICompatibleProvider } from "./provider.ts";

// 从环境变量读取密钥和模型配置，避免把密钥写进源码。
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// 缺少模型连接配置时不发请求，直接提示用户补齐配置。
if (!apiKey || !model) {
  console.error("Set OPENAI_API_KEY and OPENAI_MODEL before running.");
  process.exit(1);
}

// 组装模型连接器和 Agent：前者负责请求模型，后者负责管理对话。
const provider = new OpenAICompatibleProvider(apiKey, model, baseUrl);
const agent = new Agent(provider, "你是一个简洁、准确的中文助手。");
const terminal = createInterface({ input: stdin, output: stdout });

try {
  console.log("开始聊天。输入 /exit 结束。\n");

  // 循环读取问题；同一个 Agent 会保留本次运行中的对话消息。
  while (true) {
    const userText = (await terminal.question("你：")).trim();
    if (userText === "/exit") break;
    if (!userText) continue;

    try {
      console.log(`Agent：${await agent.ask(userText)}\n`);
    } catch (error) {
      // 单轮请求失败时提示错误，但允许用户继续提问。
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  // 无论正常退出还是发生异常，都关闭终端输入接口。
  terminal.close();
}
