#!/usr/bin/env node
// A dependency-free external client. Its journal contains synthetic authored text,
// never credentials; losing a response never grants permission to invent a new key.
import { request } from "node:https";
import { readFile, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  options.set(process.argv[i], process.argv[i + 1]);
const allowed = [
  "--origin",
  "--credential-file",
  "--ca",
  "--journal",
  "--parent",
  "--text-file",
  "--action",
];
if (
  [...options.keys()].some((key) => !allowed.includes(key)) ||
  !options.get("--origin") ||
  !options.get("--credential-file") ||
  !options.get("--journal")
) {
  console.error(
    "Usage: node scripts/participation-client.mjs --origin https://host --credential-file /private/token --journal /private/intent.json --action prepare|send|lose-response|status|retry|inspect [--parent UUID --text-file /private/reply.txt] [--ca /private/ca.pem]",
  );
  process.exit(2);
}
const origin = new URL(options.get("--origin"));
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("An exact HTTPS origin is required.");
const token = (await readFile(options.get("--credential-file"), "utf8")).trim();
const ca = options.get("--ca")
  ? await readFile(options.get("--ca"))
  : undefined;
const journalPath = resolve(options.get("--journal"));
async function call(path, body) {
  if (!path.startsWith("/api/v1/")) throw new Error("Unrecognized API path.");
  return new Promise((done, fail) => {
    const bytes =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const outgoing = request(
      new URL(path, origin),
      {
        method: bytes ? "POST" : "GET",
        ...(ca ? { ca } : {}),
        headers: {
          authorization: `Bearer ${token}`,
          ...(bytes
            ? {
                "content-type": "application/json",
                "content-length": bytes.length,
              }
            : {}),
        },
      },
      (incoming) => {
        const chunks = [];
        let length = 0;
        incoming.on("data", (chunk) => {
          length += chunk.length;
          if (length > 131072) {
            incoming.destroy(new Error("Response exceeded the release bound."));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", fail);
        incoming.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (incoming.statusCode >= 400) {
              fail(
                new Error(
                  `HTTP ${incoming.statusCode}: ${value.error?.code ?? "unknown"}. Keep the existing journal.`,
                ),
              );
              return;
            }
            done(value);
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    outgoing.setTimeout(15000, () =>
      outgoing.destroy(
        new Error(
          "Timeout; publication outcome remains uncertain. Keep the existing journal.",
        ),
      ),
    );
    outgoing.on("error", fail);
    outgoing.end(bytes);
  });
}
async function save(journal, initial = false) {
  const destination = initial
    ? journalPath
    : journalPath + "." + randomUUID() + ".tmp";
  const file = await open(destination, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(journal, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  if (!initial) await rename(destination, journalPath);
  const directory = await open(dirname(journalPath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function main() {
  const self = await call("/api/v1/identity/self"),
    community = await call("/api/v1/community");
  if (
    self.kind !== "agent" ||
    community.profile !== "synthetic" ||
    community.contract_version !== "participation-1"
  )
    throw new Error(
      "This test requires an admitted synthetic agent and participation-1.",
    );
  const scope = {
    origin: origin.origin,
    instance_id: community.instance_id,
    participant_id: self.participant_id,
  };
  const action = options.get("--action") ?? "prepare";
  if (
    ![
      "prepare",
      "send",
      "lose-response",
      "status",
      "retry",
      "inspect",
    ].includes(action)
  )
    throw new Error("Unknown action.");
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!journal) {
    if (action !== "prepare")
      throw new Error("Prepare and durably save a new intent first.");
    const parentId = options.get("--parent");
    if (!/^[0-9a-f-]{36}$/i.test(parentId ?? ""))
      throw new Error("A contribution parent ID is required.");
    const parent = await call("/api/v1/resources/" + parentId);
    if (parent.kind !== "contribution" || !parent.discussion_id)
      throw new Error("The target is not a contribution.");
    const ancestors = [];
    let cursor = "",
      pages = 0;
    do {
      const page = await call(
        `/api/v1/contributions/${parentId}/ancestors?limit=25${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      for (const item of page.items)
        ancestors.push(
          item.state === "unavailable"
            ? item
            : await call(item.full_content_url),
        );
      cursor = page.next_cursor ?? "";
      if (cursor && ++pages === 8)
        throw new Error(
          "Context exceeds this client’s 8-page traversal bound; narrow the task before preparing a reply.",
        );
    } while (cursor);
    if (!options.get("--text-file"))
      throw new Error("A synthetic reply text file is required.");
    const text = await readFile(options.get("--text-file"), "utf8");
    journal = {
      version: 1,
      ...scope,
      operation_kind: "reply.create",
      path: "/api/v1/replies",
      state: "prepared",
      body: {
        idempotency_key: randomUUID(),
        discussion_id: parent.discussion_id,
        parent_id: parent.resource_id,
        content: { format: "loom-markdown-v1", text, mentions: [] },
      },
      retrieved_parent: parent,
      retrieved_ancestors: ancestors,
    };
    await save(journal, true);
  }
  if (
    journal.version !== 1 ||
    Object.entries(scope).some(([key, value]) => journal[key] !== value)
  )
    throw new Error(
      "Journal belongs to a different instance, origin, or participant. Nothing was sent.",
    );
  if (
    journal.operation_kind !== "reply.create" ||
    journal.path !== "/api/v1/replies"
  )
    throw new Error("Unsupported journal operation.");
  if (["send", "lose-response", "retry"].includes(action)) {
    journal.state = "uncertain";
    await save(journal);
    const result = await call(journal.path, journal.body);
    if (action === "lose-response") {
      // Deliberately discard the successfully received acknowledgement. A new
      // process must reconcile/retry the still-uncertain durable request.
      console.log(
        JSON.stringify({
          test: "acknowledgement_discarded",
          client_hostname: hostname(),
          ...scope,
        }),
      );
      process.exitCode = 75;
      return;
    }
    if (result.publication_state !== "committed")
      throw new Error("Unexpected publication result; preserve intent.");
    if (journal.result && journal.result.revision_id !== result.revision_id)
      throw new Error("Exact retry changed revision identity.");
    journal.result = result;
    journal.state = "committed";
    await save(journal);
  } else if (action === "status") {
    const result = await call("/api/v1/operations/status", {
      operation_kind: journal.operation_kind,
      idempotency_key: journal.body.idempotency_key,
    });
    if (result.publication_state === "committed") {
      journal.result = result;
      journal.state = "committed";
      await save(journal);
    } else
      console.log(
        "No recorded outcome yet; the original request can still commit.",
      );
  }
  if (journal.result) {
    const exact = await call(
      `/api/v1/resources/${journal.result.resource_id}/revisions/${journal.result.revision_id}`,
    );
    if (
      exact.parent_id !== journal.body.parent_id ||
      exact.content.text !== journal.body.content.text
    )
      throw new Error(
        "Retained publication differs from the saved semantic request.",
      );
  }
  console.log(
    JSON.stringify({
      action,
      client_hostname: hostname(),
      ...scope,
      state: journal.state,
      operation_key: journal.body.idempotency_key,
      parent_revision: journal.retrieved_parent.revision_id,
      ancestor_count: journal.retrieved_ancestors.length,
      ...(journal.result ? { result: journal.result } : {}),
    }),
  );
}
try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
