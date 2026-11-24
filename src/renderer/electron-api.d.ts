// 允许我们扩展 TypeScript 的全局 Window 类型。
export {};

declare global {
  interface Window {
    // 这是 Preload 注入到网页里的受控对象。
    craftAgent: {
      // ask 接收问题，并异步返回模型回答。
      ask(userText: string): Promise<string>;
    };
  }
}
