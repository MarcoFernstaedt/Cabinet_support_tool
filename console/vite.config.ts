import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the console API runs separately; requests keep their Origin so the
// server's Origin check still applies (set CONSOLE_ORIGIN=http://localhost:5173).
export default defineConfig({
  // The console is served from the origin root by default. A deployment that serves it under a
  // path builds with --base (deploy/Dockerfile passes CONSOLE_BASE), so Vite prefixes every
  // asset URL and lib/base.ts prefixes the console's own addresses.
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, assetsInlineLimit: 0 },
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8080", changeOrigin: false } } },
});
