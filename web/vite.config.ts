import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite dev server runs on :5173 and proxies /api → the Express host on :3000.
// `npm run build` emits to ../public, which the Express server statically serves
// in production. Keep the output path in sync with src/server.ts.
const API_PORT = Number(process.env.API_PORT) || 3000;

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        // SSE needs the proxy to keep the connection open
        ws: false,
      },
    },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    rollupOptions: {
      // Multi-page build: the main app + a dev-only preview at /preview.html
      // that renders every PromptPanel variant in isolation. The preview
      // page bypasses the hook stream entirely so we can screenshot each
      // pending state for visual review without a live Claude session.
      input: {
        index: resolve(__dirname, "index.html"),
        preview: resolve(__dirname, "preview.html"),
      },
    },
  },
});
