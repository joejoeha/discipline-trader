import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Rust 的输出文件会在开发时持续变化；忽略它们，避免预览窗口因文件锁而中断。
    watch: { ignored: ["**/src-tauri/target/**"] }
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "es2022", minify: "esbuild", sourcemap: true }
});
