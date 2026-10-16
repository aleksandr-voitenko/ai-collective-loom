import { syntheticServer } from "../tests/helpers/participation-server.js";
import { requireRepositoryRuntime } from "./check-runtime.mjs";
import { NativeSearchWorker } from './lib/native-search-worker.js';
import { createInterface } from 'node:readline';
requireRepositoryRuntime();
const server = await syntheticServer({
  port: Number(process.env.LOOM_SYNTHETIC_PORT ?? 3443),
});
const worker=new NativeSearchWorker(server.configuration);
const notifications=new NativeSearchWorker(server.configuration,'notifications');
try {await worker.start();await notifications.start();} catch(error) {await notifications.stop();await worker.stop();await server.close();throw error;}
const controls=createInterface({input:process.stdin});
let commands=Promise.resolve();
controls.on('line',line=>{commands=commands.then(async()=>{
  if(line.trim()==='worker stop'){await worker.stop();process.stdout.write('Search worker stopped; API remains available.\n');}
  else if(line.trim()==='worker start'){await worker.start();process.stdout.write('Search worker started.\n');}
  else if(line.trim()==='notifications stop'){await notifications.stop();process.stdout.write('Notification worker stopped; search and API remain available.\n');}
  else if(line.trim()==='notifications start'){await notifications.start();process.stdout.write('Notification worker started.\n');}
}).catch(()=>{process.stderr.write('Worker control failed.\n');});});
process.stdout.write('Search worker running. Enter "worker stop" or "worker start" to control indexing independently.\n');
process.stdout.write('Notification worker running. Enter "notifications stop" or "notifications start" to test delayed availability.\n');
process.stdout.write(
  `Synthetic participation preview: ${server.origin}/loom\nLocal self-signed TLS certificate: ${server.directory}/cert.pem\nOne-time administrator enrollment ticket: ${server.directory}/administrator-ticket.txt\nOnly this process's temporary PostgreSQL database is used. Ctrl-C closes it.\n`,
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  controls.close();
  await commands;
  await notifications.stop();
  await worker.stop();
  await server.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
