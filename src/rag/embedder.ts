// 把文本转换成向量，供后续计算“用户问题”和“文档块”有多相似。
export class OpenAICompatibleEmbedder {
  constructor(
    // 调用模型服务所需的密钥；只保存在程序中，不放进要嵌入的文本。
    private readonly apiKey: string,
    // Embedding 模型名称；把它设成默认参数，创建对象时可以不重复传。
    private readonly model = "text-embedding-3-small",
    // 模型服务的根地址；允许使用兼容 OpenAI API 的其他服务。
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  // 接收多段文本，按原顺序返回对应的向量列表。
  async embedTexts(texts: string[]): Promise<number[][]> {
    // 没有文本就没有必要发网络请求，直接返回空列表。
    if (texts.length === 0) return [];

    // 把根地址和接口路径拼起来；去掉根地址末尾的斜杠，避免出现双斜杠。
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/embeddings`,
      {
        // POST 表示向 Embedding 接口提交需要处理的数据。
        method: "POST",
        headers: {
          // 告诉服务端：请求正文使用 JSON 格式。
          "content-type": "application/json",
          // 用 API 密钥证明当前请求有权调用模型服务。
          authorization: `Bearer ${this.apiKey}`,
        },
        // model 指定向量模型，input 是要转换的一批文本。
        // 批量传入可以避免每个 chunk 都单独发一次请求。
        body: JSON.stringify({ model: this.model, input: texts }),
      },
    );

    // HTTP 请求失败时，读取服务端给出的错误详情并抛出异常。
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Embedding request failed (${response.status}): ${details}`);
    }

    // 把 JSON 响应解析成对象，并告诉 TypeScript 我们预期的数据形状。
    // data 中每一项包含原文本的序号 index 和对应的向量 embedding。
    const data = (await response.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };

    // 按 index 排序，确保返回的向量顺序与输入 texts 的顺序一致。
    const items = data.data?.sort((a, b) => a.index - b.index);

    // 如果服务端没返回数据，或返回条数和输入文本条数对不上，就报错。
    if (!items || items.length !== texts.length) {
      throw new Error("The embedding service returned an unexpected response.");
    }

    // 去掉序号等响应包装，只返回后续相似度计算需要的向量数组。
    return items.map((item) => item.embedding);
  }
}
