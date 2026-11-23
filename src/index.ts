import { Agent } from "./agent.ts";
import { OpenAICompatibleProvider } from "./provider.ts";

// 读取命令行中用户输入的问题。
const userText = process.argv.slice(2).join(" ").trim();
// 从环境变量读取密钥和模型配置，避免把密钥写进源码。
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

// 没输入问题时提示正确用法并退出。
if (!userText) {
  console.error('Usage: bun run src/index.ts "你的问题"');
  process.exit(1);
}
// 缺少模型连接配置时不发请求，直接提示用户补齐配置。
if (!apiKey || !model) {
  console.error("Set OPENAI_API_KEY and OPENAI_MODEL before running.");
  process.exit(1);
}

// 组装模型连接器和 Agent：前者负责请求模型，后者负责管理对话。
const provider = new OpenAICompatibleProvider(apiKey, model, baseUrl);
const agent = new Agent(provider, "你是一个简洁、准确的中文助手。");

try {
  // 开始一轮问答并打印最终回答。
  console.log(await agent.ask(userText));
} catch (error) {
  // 把请求或模型返回异常转换成可读错误，并以失败状态退出。
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
