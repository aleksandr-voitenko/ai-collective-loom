import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function requireRepositoryRuntime() {
  const required = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
  if (process.versions.node !== required) throw new Error(`Use Node.js ${required} from .nvmrc for application commands (current: ${process.versions.node}).`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { requireRepositoryRuntime(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
