import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { BoundSocket } from "node:net";
import { isolatedPublicationPostgres } from "./publication-postgres.js";
import { IdentityAdministration } from "../../src/server/modules/identity/administration.js";
import { IdentityAuthentication } from "../../src/server/modules/identity/authentication.js";
import { syntheticIdentityPolicy } from "../../src/server/participation-profile.js";
import { verifier } from "../../src/server/modules/identity/secrets.js";
import { createApplication } from "../../src/server/http/app.js";
import type { Transactions } from "../../src/server/modules/publication/publication.js";

export async function syntheticServer(
  options: {
    port?: number;
    throughMigration?: number;
    transactionWrapper?: (database: Transactions) => Transactions;
    beforeListen?: (origin: string) => Promise<void>;
  } = {},
) {
  const fixture = await isolatedPublicationPostgres(options.throughMigration === undefined ? {} : { throughMigration: options.throughMigration }),
    directory = await mkdtemp(join(tmpdir(), "loom-participation-"));
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let reserved: BoundSocket | undefined;
  const close = async () => {
    await application?.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    // Identity policy needs the exact origin before initialization. Keep the socket
    // bound until HTTPS adopts it; probing and releasing a port leaves a race.
    reserved = new BoundSocket({ host: "127.0.0.1", port: options.port ?? 0 });
    const port = reserved.address().port;
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
    const openApplication = () => createApplication({
      database: {
        isReady: () => fixture.database.isReady(),
        close: async () => {},
      },
      logger: false,
      browserRoot: fileURLToPath(new URL("../../dist/web/", import.meta.url)),
      tls,
      participation: { database, authentication, administration },
    });
    application = await openApplication();
    await options.beforeListen?.(origin);
    const listenOptions = { host: "127.0.0.1", handle: reserved };
    await application.listen(listenOptions);
    return {
      ...fixture,
      app: application,
      origin,
      policy,
      administration,
      authentication,
      ticket: ticket.secret!,
      administratorId: account.participant_id,
      directory,
      restart: async () => {
        await application!.close();
        application=await openApplication();
        await application.listen({host:'127.0.0.1',port});
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    // After adoption the application owns the socket; otherwise release it here.
    reserved?.[Symbol.dispose]();
  }
}
