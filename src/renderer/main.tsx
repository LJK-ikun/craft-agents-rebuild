import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

// React 从 root 节点接管页面，并渲染桌面应用的第一个界面。
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
