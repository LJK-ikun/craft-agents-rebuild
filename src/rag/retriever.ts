import type { TextChunk } from "./chunker.ts";
import { OpenAICompatibleEmbedder } from "./embedder.ts";

// 计算两个向量的余弦相似度；结果越大，表示方向越接近。
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error("Vectors must have the same non-zero length.");
  }

  let dotProduct = 0;
  let squaredLengthA = 0;
  let squaredLengthB = 0;

  // 同一位置的数字相乘并累加，得到两个向量的点积。
  for (let i = 0; i < a.length; i += 1) {
    dotProduct += a[i] * b[i];
    squaredLengthA += a[i] * a[i];
    squaredLengthB += b[i] * b[i];
  }

  // 向量长度为 0 时无法计算余弦相似度。
  if (squaredLengthA === 0 || squaredLengthB === 0) {
    throw new Error("Cannot compare a zero-length vector.");
  }

  // 余弦相似度 = 点积 / (向量 A 的长度 × 向量 B 的长度)。
  return dotProduct / (Math.sqrt(squaredLengthA) * Math.sqrt(squaredLengthB));
}

// 从文本块里找出与用户问题最相似的 topK 个块。
export async function retrieveTopK(
  query: string,
  chunks: TextChunk[],
  embedder: OpenAICompatibleEmbedder,
  topK = 3,
): Promise<Array<{ chunk: TextChunk; score: number }>> {
  if (chunks.length === 0 || topK <= 0) return [];

  // 将所有文档块和用户问题放进同一次请求，减少网络调用次数。
  // embedTexts 按输入顺序返回向量，因此问题向量会排在最后。
  const vectors = await embedder.embedTexts([
    ...chunks.map((chunk) => chunk.text),
    query,
  ]);
  const queryVector = vectors[vectors.length - 1];
  const chunkVectors = vectors.slice(0, -1);

  // 为每个文本块计算它与问题的相似度，并保留原始块和分数。
  const ranked = chunks.map((chunk, index) => ({
    chunk,
    score: cosineSimilarity(queryVector, chunkVectors[index]),
  }));

  // 分数从高到低排列，只返回最靠前的 topK 个结果。
  return ranked.sort((a, b) => b.score - a.score).slice(0, topK);
}
