import { useState, type FormEvent } from "react";

export function App() {
  // 保存输入框里的问题、模型回答、错误提示和请求状态。
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // 用户提交表单时运行这个函数。
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // 阻止浏览器提交表单后刷新整页。
    event.preventDefault();

    const text = question.trim();
    if (!text || busy) return;

    setBusy(true);
    setError("");
    setAnswer("");

    try {
      // 调用 Preload 暴露的 ask，再等待主进程和模型返回回答。
      const result = await window.craftAgent.ask(text);
      setAnswer(result);
    } catch (cause) {
      // 主进程或模型请求出错时，把错误显示在界面上。
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // 无论成功还是失败，都恢复按钮状态。
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: "sans-serif", margin: "48px auto", maxWidth: 720, padding: 24 }}>
      <h1>Craft Agents Learning Rebuild</h1>

      <form onSubmit={handleSubmit}>
        <textarea
          aria-label="输入问题"
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="输入一个问题"
          rows={4}
          value={question}
        />
        <button disabled={busy || !question.trim()} type="submit">
          {busy ? "正在回答…" : "发送"}
        </button>
      </form>

      {error && <p role="alert">错误：{error}</p>}
      {answer && <section><h2>回答</h2><p>{answer}</p></section>}
    </main>
  );
}