import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";

/** Recreate only this local project's services; never remove or reset volumes. */
export async function persistenceSmoke({ root, config, tool, waitForStorage }) {
  const scratch = await mkdtemp(join(root, ".local", "persistence-smoke-"));
  const containerPath = (name) => `/work/${basename(scratch)}/${name}`;
  const token = randomUUID();
  const table = `bootstrap_persistence_${token.replaceAll("-", "")}`;
  const key = `bootstrap-persistence/${token}`;
  const staging = config.LOOM_S3_STAGING_BUCKET;
  const final = config.LOOM_S3_FINAL_BUCKET;
  const objects = [];
  let downloadSequence = 0;
  const credentials = await readFile(join(root, ".env.local"));
  const historyQuery = "SELECT coalesce(json_agg(h ORDER BY version), '[]') FROM loom_migrations.history AS h;";
  const history = tool.sql(historyQuery);
  const containerIds = () => tool.compose(["ps", "--quiet", "postgres", "s3"]).trim().split(/\s+/).sort();
  let tableCreated = false;
  let primaryError;
  const cleanupErrors = [];
  try {
    await waitForStorage(tool);
    for (const bucket of [staging, final]) {
      assert.equal(tool.awsJson(["get-bucket-versioning", "--bucket", bucket]).Status, "Enabled", "Enable versioning with dev:up before creating persistence fixtures.");
    }
    tool.sql(`CREATE TABLE loom.${table}(id integer PRIMARY KEY, value text NOT NULL);`);
    tableCreated = true;
    // Default migration grants must allow actual runtime DML on a new table.
    tool.sql(`INSERT INTO loom.${table} VALUES (1, '${token}'); UPDATE loom.${table} SET value = value WHERE id = 1;`, "loom_app");
    for (const [bucket, body] of [[staging, "original bytes\n"], [staging, "replacement bytes\n"], [final, "final bytes\n"]]) {
      // Rewriting a host file between CLI containers can expose stale file sizes
      // through a bind mount. Keep each transfer file immutable and uniquely named.
      const inputName = `input-${objects.length}.txt`;
      await writeFile(join(scratch, inputName), body, { flag: "wx" });
      const { VersionId: version } = tool.awsJson(["put-object", "--bucket", bucket, "--key", key, "--body", containerPath(inputName)]);
      assert.ok(typeof version === "string" && version && version !== "null", "Persistence fixture needs native versions.");
      objects.push({ bucket, version, body });
    }
    assert.notEqual(objects[0].version, objects[1].version);

    const verify = async (phase) => {
      await waitForStorage(tool);
      assert.equal(tool.sql(`SELECT value FROM loom.${table} WHERE id = 1;`, "loom_app"), token, `${phase}: committed application row changed.`);
      assert.equal(tool.sql(historyQuery), history, `${phase}: migration history changed.`);
      // Do not call dev:up/setupStorage here: re-enabling versioning could hide
      // a persistence defect. Read and assert the stored configuration instead.
      for (const bucket of [staging, final]) {
        assert.equal(tool.awsJson(["get-bucket-versioning", "--bucket", bucket]).Status, "Enabled", `${phase}: bucket versioning was lost.`);
      }
      for (const { bucket, version, body } of objects) {
        const metadata = tool.awsJson(["head-object", "--bucket", bucket, "--key", key, "--version-id", version]);
        assert.equal(metadata.ContentLength, Buffer.byteLength(body), `${phase}: stored object length changed.`);
        const outputName = `read-${downloadSequence++}.txt`;
        tool.aws(["get-object", "--bucket", bucket, "--key", key, "--version-id", version, containerPath(outputName)]);
        assert.equal(await readFile(join(scratch, outputName), "utf8"), body, `${phase}: exact object version changed.`);
      }
      // Compare without printing either buffer, even when they differ.
      assert.ok(credentials.equals(await readFile(join(root, ".env.local"))), `${phase}: local credentials changed.`);
      console.log(`Persistence: ${phase} retained the committed row, migration history, bucket versioning, three exact object versions, and credentials.`);
    };
    await verify("before lifecycle changes");
    const originalContainers = containerIds();
    assert.equal(originalContainers.length, 2, "Both local services must be running.");
    tool.compose(["stop", "postgres", "s3"]);
    // Linux CI's Compose lacks start --wait. Reuse the stopped containers through
    // up's supported health wait; unchanged IDs below still prove a true restart.
    tool.compose(["up", "-d", "--no-recreate", "--wait", "--wait-timeout", "90", "postgres", "s3"]);
    assert.deepEqual(containerIds(), originalContainers, "Stop/start must reuse containers.");
    await verify("stop/start");
    tool.compose(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "90", "postgres", "s3"]);
    const recreatedContainers = containerIds();
    assert.equal(recreatedContainers.length, 2);
    assert.ok(recreatedContainers.every((id) => !originalContainers.includes(id)), "Both containers must actually be recreated.");
    await verify("container recreation");
  } catch (error) { primaryError = error; }
  finally {
    for (const { bucket, version } of objects.reverse()) {
      try { tool.aws(["delete-object", "--bucket", bucket, "--key", key, "--version-id", version]); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (tableCreated) {
      try {
        tool.sql(`DELETE FROM loom.${table};`, "loom_app");
        tool.sql(`DROP TABLE loom.${table};`);
      } catch (error) { cleanupErrors.push(error); }
    }
    if (!cleanupErrors.length) await rm(scratch, { recursive: true, force: true });
  }
  if (primaryError) {
    if (cleanupErrors.length) console.error(`Persistence scratch cleanup failed; inspect ${table} and ${key}. No volumes were removed.`);
    throw primaryError;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Persistence assertions passed but scratch cleanup failed; no volumes were removed.");
  console.log("Local persistence suite passed; services remain running. This is not backup/restore or managed-provider validation.");
}
