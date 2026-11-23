import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite 负责开发期间启动前端页面，以及构建可被 Electron 加载的静态文件。
export default defineConfig({
  plugins: [react()],
  root: "src/renderer",
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
});
