import type { ChatMessage, ChatModelProvider } from "./provider.ts";

export class Agent {
  private readonly messages: ChatMessage[];

  constructor(private readonly model: ChatModelProvider, systemPrompt: string) {
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  async ask(userText: string): Promise<string> {
    this.messages.push({ role: "user", content: userText });
    const answer = await this.model.complete(this.messages);
    this.messages.push({ role: "assistant", content: answer });
    return answer;
  }
}
