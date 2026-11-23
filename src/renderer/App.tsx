import { useState, type FormEvent } from "react";

// 界面负责收集问题和显示回答；模型请求由主进程里的 Agent 完成。
export function App() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;

    setBusy(true);
    setError("");
    setAnswer("");
    try {
      // 通过 Preload 暴露的安全接口发 IPC 请求，并等待 Agent 回答。
      setAnswer(await window.craftAgent.ask(text));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
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
          style={{ boxSizing: "border-box", padding: 12, width: "100%" }}
          value={question}
        />
        <button disabled={busy || !question.trim()} type="submit">
          {busy ? "正在回答…" : "发送"}
        </button>
      </form>
      {error && <p role="alert">错误：{error}</p>}
      {answer && <section aria-live="polite"><h2>回答</h2><p>{answer}</p></section>}
    </main>
  );
}
