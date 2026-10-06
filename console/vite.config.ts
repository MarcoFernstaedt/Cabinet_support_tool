import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the console API runs separately; requests keep their Origin so the
// server's Origin check still applies (set CONSOLE_ORIGIN=http://localhost:5173).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, assetsInlineLimit: 0 },
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8080", changeOrigin: false } } },
});
