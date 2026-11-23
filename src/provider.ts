export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export interface ChatModelProvider {
  complete(messages: ChatMessage[]): Promise<string>;
}

export class OpenAICompatibleProvider implements ChatModelProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Model request failed (${response.status}): ${details}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("The model returned an empty response.");
    return content;
  }
}
