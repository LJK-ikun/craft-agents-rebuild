import { Agent } from "./agent.ts";
import { OpenAICompatibleProvider } from "./provider.ts";

const userText = process.argv.slice(2).join(" ").trim();
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;
const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

if (!userText) {
  console.error('Usage: bun run src/index.ts "你的问题"');
  process.exit(1);
}
if (!apiKey || !model) {
  console.error("Set OPENAI_API_KEY and OPENAI_MODEL before running.");
  process.exit(1);
}

const provider = new OpenAICompatibleProvider(apiKey, model, baseUrl);
const agent = new Agent(provider, "你是一个简洁、准确的中文助手。");

try {
  console.log(await agent.ask(userText));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
