// 一个分块结果：id 用来区分文本块，text 保存块里的原文。
export type TextChunk = {
  id: string;
  text: string;
};

// 把长文本按字符数切成小块，作为后续检索的基本单位。
export function splitIntoChunks(text: string, chunkSize = 300): TextChunk[] {
  if (chunkSize <= 0) {
    throw new Error("chunkSize must be greater than 0.");
  }

  // 先把多余空白压成一个空格，减少空格和换行造成的浪费。
  const normalizedText = text.replace(/\s+/g, " ").trim();
  const chunks: TextChunk[] = [];

  // 每次向后移动 chunkSize 个字符，取出一个文本片段。
  for (let start = 0; start < normalizedText.length; start += chunkSize) {
    const index = chunks.length + 1;
    chunks.push({
      id: `chunk-${index}`,
      text: normalizedText.slice(start, start + chunkSize),
    });
  }

  return chunks;
}
