import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./frontend", import.meta.url)) },
  },
  build: {
    outDir: "src/whisper_local/static",
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: "frontend/main.jsx",
      output: { entryFileNames: "app.js", assetFileNames: "[name].[ext]" },
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:8765",
      "/static": "http://127.0.0.1:8765",
      "/session": { target: "http://127.0.0.1:8765", rewrite: () => "/" },
    },
  },
});
