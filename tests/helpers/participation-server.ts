import {isolatedFileStorage} from "./file-storage.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { isolatedPublicationPostgres } from "./publication-postgres.js";
import { IdentityAdministration } from "../../src/server/modules/identity/administration.js";
import { IdentityAuthentication } from "../../src/server/modules/identity/authentication.js";
import { syntheticIdentityPolicy } from "../../src/server/participation-profile.js";
import { verifier } from "../../src/server/modules/identity/secrets.js";
import { createApplication } from "../../src/server/http/app.js";
import type { Transactions } from '../../src/server/db/postgres.js';

export async function syntheticServer(
  options: {
    port?: number;
    logger?: Parameters<typeof createApplication>[0]['logger'];
    files?:boolean;
    throughMigration?: number;
    workloadRates?: boolean;
    transactionWrapper?: (database: Transactions) => Transactions;
    beforeListen?: (origin: string) => Promise<void>;
  } = {},
) {
  const fixture = await isolatedPublicationPostgres(options.throughMigration === undefined ? {} : { throughMigration: options.throughMigration }),
    directory = await mkdtemp(join(tmpdir(), "loom-participation-"));
  let fileFixture:Awaited<ReturnType<typeof isolatedFileStorage>>|undefined;
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let reserved: Server | undefined;
  const releaseReservation = async () => {
    const listener = reserved;
    reserved = undefined;
    if (listener)
      await new Promise<void>((resolve) => listener.close(() => resolve()));
  };
  const close = async () => {
    await releaseReservation();
    await application?.close();
    await fileFixture?.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  };
  const reserve = async (port: number) => {
    // Identity policy needs the exact origin before initialization. A bound-only
    // socket can still lose its port on Linux; keep a listener until HTTPS takes it.
    const listener = createServer((socket) => socket.destroy());
    reserved = listener;
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen({ host: "127.0.0.1", port }, resolve);
      });
      return listener;
    } catch (error) {
      await releaseReservation();
      throw error;
    }
  };
  try {
    // Explicit bulk-test policy, not the synthetic preview default. Every request
    // still passes accounting; tests of rate behavior use smaller supported limits.
    if (options.workloadRates) await fixture.observer.query('UPDATE loom.participation_rate_policy SET ordinary_requests=6000,new_publications=600,recovery_control=1200 WHERE id=1');
    if(options.files)fileFixture=await isolatedFileStorage();
    const listener = await reserve(options.port ?? 0);
    const port = (listener.address() as AddressInfo).port;
    const origin = `https://localhost:${port}`,
      policy = syntheticIdentityPolicy(origin),
      database =
        options.transactionWrapper?.(fixture.database) ?? fixture.database;
    const bootstrap = randomBytes(32).toString("base64url"),
      recovery = randomBytes(32).toString("base64url");
    const administration = new IdentityAdministration(database, policy, {
        bootstrap: verifier(bootstrap),
        recovery: verifier(recovery),
      }),
      authentication = new IdentityAuthentication(database, policy);
    const account = await administration.bootstrap(bootstrap, {
      idempotency_key: randomUUID(),
      nickname: "synthetic_admin",
    });
    const ticket = await administration.deploymentEnrollment(
      bootstrap,
      "bootstrap",
      {
        idempotency_key: randomUUID(),
        participant_id: account.participant_id,
        kind: "enrollment",
        purpose: "enroll",
        label: "Synthetic administrator",
        replace_credential_id: null,
      },
    );
    await writeFile(
      join(directory, "administrator-ticket.txt"),
      ticket.secret!,
      { mode: 0o600 },
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const tls = {
      key: await readFile(join(directory, "key.pem"), "utf8"),
      cert: await readFile(join(directory, "cert.pem"), "utf8"),
    };
    const start = async (listener: Server) => {
      try {
        const next = await createApplication({
          database: {
            isReady: () => fixture.database.isReady(),
            close: async () => {},
          },
          logger: options.logger ?? false,
          browserRoot: fileURLToPath(new URL("../../dist/web/", import.meta.url)),
          tls,
          participation: { database, authentication, administration, ...(fileFixture?{fileStorage:fileFixture.storage}:{}) },
        });
        application = next;
        await options.beforeListen?.(origin);
        // Node's public listen(server) uses the existing listener. Transfer cleanup
        // ownership on listening; closing the original would close HTTPS too.
        const listenOptions = Object.assign(listener, { host: "127.0.0.1" });
        next.server.once("listening", () => { reserved = undefined; });
        await next.listen(listenOptions);
        return next;
      } catch (error) {
        await releaseReservation();
        await application?.close();
        throw error;
      }
    };
    const app = await start(listener);
    return {
      ...fixture,
      fileFixture,
      app,
      origin,
      policy,
      administration,
      authentication,
      ticket: ticket.secret!,
      administratorId: account.participant_id,
      directory,
      restart: async () => {
        await application!.close();
        await start(await reserve(port));
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
