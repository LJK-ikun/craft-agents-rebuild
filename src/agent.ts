import type { ChatMessage, ChatModelProvider } from "./provider.ts";

// Agent 保存对话状态，并负责把用户消息交给模型、再记录回答。
export class Agent {
  // 当前会话的消息列表；每次提问都会在这个列表上继续累积。
  private readonly messages: ChatMessage[];

  constructor(
    private readonly model: ChatModelProvider,
    systemPrompt: string,
    previousMessages: ChatMessage[] = [],
  ) {
    // 系统提示词始终放最前面，后面接上从磁盘恢复的历史消息。
    this.messages = [{ role: "system", content: systemPrompt }, ...previousMessages];
  }

  async ask(userText: string): Promise<string> {
    // 先把本轮问题加入上下文，模型才能看到用户问了什么。
    this.messages.push({ role: "user", content: userText });
    // 调用模型；此处通过接口，不关心具体使用哪家服务。
    const answer = await this.model.complete(this.messages);
    // 保存模型回答，后续提问时模型也能看到这段对话。
    this.messages.push({ role: "assistant", content: answer });
    return answer;
  }
}
