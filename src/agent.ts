import type { ChatMessage, ModelProvider } from "./provider.ts";
import type { ConversationMessage } from "./jsonl-store.ts";

export class Agent {
    // 保存这次运行中的对话消息。
    private readonly messages: ChatMessage[];
  
    constructor(
      private readonly provider: ModelProvider,
      systemPrompt: string,
      previousMessages: ConversationMessage[] = [],
    ) {
      // 对话从系统提示开始，后续问题和回答都追加到这份列表。
      this.messages = [
        { role: "system", content: systemPrompt },
        ...previousMessages,
      ];
    }
  
    async ask(question: string): Promise<string> {
      // 先把用户这轮的问题记下来。
      this.messages.push({ role: "user", content: question });
  
      try {
        // 把完整对话交给模型，模型就能看到前面聊过什么。
        const answer = await this.provider.complete(this.messages);
  
        // 模型成功回答后，也把回答存进对话。
        this.messages.push({ role: "assistant", content: answer });
        return answer;
      } catch (error) {
        // 请求失败时移除刚才的问题，避免失败内容留在历史里。
        this.messages.pop();
        throw error;
      }
    }
  }
