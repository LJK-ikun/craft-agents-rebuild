// 一条聊天消息由“说话的人”和消息内容组成
export type ChatMessage = {
    // system 是给模型的规则： user是用户；assistant是模型
    role: "system" | "user" | "assistant";

    // 这一条消息的文本
    content: string;
}

// 约定模型提供者必须有 complete 方法
// 以后无论接那家模型，Agent都用同一种方法回答
export interface ModelProvider {
    complete(messages: ChatMessage[]): Promise<string>;
}

// 这个类负责通过 OpenAI 兼容接口向模型发送请求
export class OpenAICompatibleProvider implements ModelProvider {
    constructor(
      // 调用模型服务的密钥。
      private readonly apiKey: string,
  
      // 要使用的模型名称。
      private readonly model: string,
  
      // 模型服务地址；默认使用 OpenAI，也可以换成兼容服务。
      private readonly baseUrl = "https://api.openai.com/v1",
    ) {}
  
    // 接收一组对话消息，向模型请求回答。
    async complete(messages: ChatMessage[]): Promise<string> {
      // 发送 HTTP 请求。模型名称和对话内容放在 JSON 请求正文里。
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages,
          }),
        },
      );
  
      // 请求失败时，把服务端返回的错误内容带出来，方便定位问题。
      if (!response.ok) {
        const details = await response.text();
        throw new Error(`模型请求失败（${response.status}）：${details}`);
      }
  
      // 把服务端的 JSON 响应转换成 JavaScript 对象。
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
  
      // OpenAI 兼容接口把回答放在 choices[0].message.content。
      const content = data.choices?.[0]?.message?.content;
  
      // 防止接口成功返回，但回答内容为空。
      if (!content) {
        throw new Error("模型返回了空回答。");
      }
  
      // 只把回答文本交还给调用者，不把 HTTP 响应细节暴露出去。
      return content;
    }
  }