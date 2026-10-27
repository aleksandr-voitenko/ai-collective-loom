import { rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireRepositoryRuntime } from "./check-runtime.mjs";
import { applicationInputs } from './lib/release-identity.mjs';

requireRepositoryRuntime();
const root = fileURLToPath(new URL("../", import.meta.url));
const identity = applicationInputs(root);
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
for (const args of [
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"],
  ["node_modules/vite/bin/vite.js", "build"],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
if (!process.exitCode) {
  if (JSON.stringify(applicationInputs(root)) !== JSON.stringify(identity)) throw new Error('Application inputs changed during build.');
  await writeFile(new URL('../dist/release.json', import.meta.url), JSON.stringify(identity) + '\n');
}
