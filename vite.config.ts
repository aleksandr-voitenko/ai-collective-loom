import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const apiPort = process.env.LOOM_API_PORT ?? "3000";
if (!/^\d+$/.test(apiPort) || Number(apiPort) < 1 || Number(apiPort) > 65535) throw new Error("Invalid LOOM_API_PORT for the browser development proxy.");
const apiHost = process.env.LOOM_API_HOST === "::1" ? "[::1]" : "127.0.0.1";
const apiTarget = `http://${apiHost}:${apiPort}`;

export default defineConfig({
  root: fileURLToPath(new URL("./src/web/", import.meta.url)),
  envDir: false,
  plugins: [react()],
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    proxy: {
      // The namespace slash keeps browser modules such as /api.ts out of the proxy.
      "/api/": apiTarget,
      "/health/": apiTarget,
    },
  },
  build: { outDir: fileURLToPath(new URL("./dist/web/", import.meta.url)), emptyOutDir: true },
});
