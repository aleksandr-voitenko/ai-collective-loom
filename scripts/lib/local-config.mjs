import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const CONFIG_KEYS = [
  "COMPOSE_PROJECT_NAME", "LOOM_POSTGRES_PORT", "LOOM_S3_PORT",
  "LOOM_PG_BOOTSTRAP_PASSWORD", "LOOM_PG_MIGRATOR_PASSWORD", "LOOM_PG_APP_PASSWORD",
  "LOOM_S3_ACCESS_KEY", "LOOM_S3_SECRET_KEY", "LOOM_S3_STAGING_BUCKET", "LOOM_S3_FINAL_BUCKET",
];
const SECRET_KEYS = CONFIG_KEYS.filter((key) => /PASSWORD|ACCESS_KEY|SECRET_KEY/.test(key));

/** A deliberately restricted format, not a shell script or a general dotenv parser. */
export function parseLocalConfig(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_-]+)$/.exec(trimmed);
    if (!match || !CONFIG_KEYS.includes(match[1])) throw new Error("Invalid local configuration entry; consult .env.example.");
    if (Object.hasOwn(result, match[1])) throw new Error(`Duplicate local configuration key: ${match[1]}`);
    result[match[1]] = match[2];
  }
  validateLocalConfig(result);
  return Object.freeze(result);
}

export function validateLocalConfig(config) {
  for (const key of CONFIG_KEYS) if (!config[key]) throw new Error(`Missing ${key}; run npm run dev:init.`);
  if (!/^loom-[a-z0-9][a-z0-9_-]{0,40}$/.test(config.COMPOSE_PROJECT_NAME)) throw new Error("Local project name must start with loom-.");
  for (const key of ["LOOM_POSTGRES_PORT", "LOOM_S3_PORT"]) {
    if (!/^\d+$/.test(config[key]) || Number(config[key]) < 1024 || Number(config[key]) > 65535) throw new Error(`Invalid ${key}.`);
  }
  if (Number(config.LOOM_POSTGRES_PORT) === Number(config.LOOM_S3_PORT)) throw new Error("Local service ports must differ.");
  for (const key of SECRET_KEYS) if (!/^[a-f0-9]{32,128}$/.test(config[key])) throw new Error(`Invalid generated value for ${key}; do not use example or production credentials.`);
  for (const key of ["LOOM_S3_STAGING_BUCKET", "LOOM_S3_FINAL_BUCKET"]) {
    if (!/^loom-dev-[a-z0-9][a-z0-9-]{0,45}$/.test(config[key])) throw new Error("Local buckets must start with loom-dev-.");
  }
  if (config.LOOM_S3_STAGING_BUCKET === config.LOOM_S3_FINAL_BUCKET) throw new Error("Staging and final buckets must differ.");
}

export function newLocalConfig() {
  const secret = () => randomBytes(32).toString("hex");
  return {
    COMPOSE_PROJECT_NAME: "loom-dev", LOOM_POSTGRES_PORT: "54320", LOOM_S3_PORT: "8333",
    LOOM_PG_BOOTSTRAP_PASSWORD: secret(), LOOM_PG_MIGRATOR_PASSWORD: secret(),
    LOOM_PG_APP_PASSWORD: secret(), LOOM_S3_ACCESS_KEY: randomBytes(16).toString("hex"),
    LOOM_S3_SECRET_KEY: secret(), LOOM_S3_STAGING_BUCKET: "loom-dev-staging", LOOM_S3_FINAL_BUCKET: "loom-dev-final",
  };
}

export async function initializeLocalConfig(root) {
  const config = newLocalConfig();
  validateLocalConfig(config);
  // Exclusive creation also rejects an existing symlink. Never rotate passwords
  // silently while an existing PostgreSQL volume still retains the old ones.
  await writeFile(join(root, ".env.local"), CONFIG_KEYS.map((key) => `${key}=${config[key]}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  await mkdir(join(root, ".local"), { recursive: true, mode: 0o700 });
  return config;
}

export async function readLocalConfig(root) {
  return parseLocalConfig(await readFile(join(root, ".env.local"), "utf8"));
}

export function composeArgs(root, config, args) {
  validateLocalConfig(config);
  return ["compose", "--env-file", join(root, ".env.local"), "--project-name", config.COMPOSE_PROJECT_NAME, "--file", join(root, "compose.yaml"), ...args];
}

export function localDockerEndpoint(endpoint) {
  if (endpoint.startsWith("unix://") || endpoint.startsWith("npipe://")) return true;
  try {
    const url = new URL(endpoint);
    return ["tcp:", "http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

export function redact(text, config) {
  let safe = String(text);
  for (const key of SECRET_KEYS) if (config?.[key]) safe = safe.replaceAll(config[key], "[REDACTED]");
  return safe;
}
