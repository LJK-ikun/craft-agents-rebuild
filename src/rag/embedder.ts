// 把文本转换成向量，供后续计算问题与文档块的相似度。
export class OpenAICompatibleEmbedder {
  constructor(
    private readonly apiKey: string,
    private readonly model = "text-embedding-3-small",
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // 一次请求批量转换多段文本，减少网络请求次数。
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/embeddings`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      },
    );

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Embedding request failed (${response.status}): ${details}`);
    }

    const data = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    const items = data.data?.sort((a, b) => a.index - b.index);

    if (!items || items.length !== texts.length) {
      throw new Error("The embedding service returned an unexpected response.");
    }

    return items.map((item) => item.embedding);
  }
}
