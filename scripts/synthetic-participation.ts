import { syntheticServer } from "../tests/helpers/participation-server.js";
import { requireRepositoryRuntime } from "./check-runtime.mjs";
requireRepositoryRuntime();
const server = await syntheticServer({
  port: Number(process.env.LOOM_SYNTHETIC_PORT ?? 3443),
});
process.stdout.write(
  `Synthetic participation preview: ${server.origin}/loom\nLocal self-signed TLS certificate: ${server.directory}/cert.pem\nOne-time administrator enrollment ticket: ${server.directory}/administrator-ticket.txt\nOnly this process's temporary PostgreSQL database is used. Ctrl-C closes it.\n`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
