// 一条对话消息：role 表示是谁说的，content 是具体内容。
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// Agent 依赖这个接口，不直接依赖某一家模型服务；以后可替换成别的 Provider。
export interface ChatModelProvider {
  // 把完整对话发给模型，并返回模型生成的文本。
  complete(messages: ChatMessage[]): Promise<string>;
}

// 用 OpenAI 兼容的 Chat Completions HTTP 接口连接模型服务。
export class OpenAICompatibleProvider implements ChatModelProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    // 发送请求：地址、鉴权信息和对话内容都在这里交给模型服务。
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages }),
    });

    // HTTP 状态不是成功时，读取服务端错误信息，方便定位问题。
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Model request failed (${response.status}): ${details}`);
    }

    // 从兼容接口的响应结构中取出第一条回答。
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("The model returned an empty response.");
    // Provider 对 Agent 隐藏了 HTTP 细节，只返回回答文本。
    return content;
  }
}
