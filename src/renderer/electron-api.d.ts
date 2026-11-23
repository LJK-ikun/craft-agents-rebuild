export {};

// 告诉 TypeScript：Preload 会向网页提供这个受控接口。
declare global {
  interface Window {
    craftAgent: {
      ask(userText: string): Promise<string>;
    };
  }
}
