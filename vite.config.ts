/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxies exist ONLY for the browser preview (the desktop app fetches through the Rust
// backend instead). They let the web preview reach official metadata sources that do not
// send CORS headers. Only metadata is fetched; never model weights.
const metadataProxy = {
  "/__proxy/ollama-com": {
    target: "https://ollama.com",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/__proxy\/ollama-com/, ""),
  },
  "/__proxy/ollama-registry": {
    target: "https://registry.ollama.ai",
    changeOrigin: true,
    followRedirects: true,
    rewrite: (p: string) => p.replace(/^\/__proxy\/ollama-registry/, ""),
  },
  "/__proxy/ollama-local": {
    target: "http://127.0.0.1:11434",
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/__proxy\/ollama-local/, ""),
  },
};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, proxy: metadataProxy },
  preview: { port: 4173, strictPort: true, proxy: metadataProxy },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // Pre-bundle lazily imported desktop modules so the dev server never reloads mid-session.
  optimizeDeps: { include: ["@tauri-apps/api/core", "@tauri-apps/api/app", "@tauri-apps/plugin-updater", "@tauri-apps/plugin-process", "zustand", "zustand/middleware", "lucide-react"] },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1600 },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
