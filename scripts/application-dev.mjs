import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireRepositoryRuntime } from "./check-runtime.mjs";

requireRepositoryRuntime();
const root = fileURLToPath(new URL("../", import.meta.url));
const children = [
  ["--env-file-if-exists=.env.local", "--import", "tsx", "--watch", "src/server/main.ts", "--mode", "api"],
  ["node_modules/vite/bin/vite.js"],
].map((args) => spawn(process.execPath, args, { cwd: root, stdio: "inherit" }));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
};
for (const child of children) {
  child.on("error", () => { process.exitCode = 1; stop(); });
  child.on("exit", (code) => {
    if (!stopping) { process.exitCode = code ?? 1; stop(); }
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
