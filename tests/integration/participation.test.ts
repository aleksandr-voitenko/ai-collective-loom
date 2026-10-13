import type { QueryResultRow } from "pg";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import SwaggerParser from "@apidevtools/swagger-parser";
import { syntheticServer } from "../helpers/participation-server.js";
import { httpClient } from "../helpers/participation-http.js";
import { createApplication } from "../../src/server/http/app.js";
import { participationProfile } from "../../src/server/participation-profile.js";

const content = (text: string) => ({
  format: "loom-markdown-v1",
  text,
  mentions: [],
});
test(
  "synthetic participation over real HTTPS and PostgreSQL",
  { timeout: 180000 },
  async (t) => {
    let loseKey = "",
      rollback = false;
    const server = await syntheticServer({
      transactionWrapper: (database) => ({
        transaction: async (operation) => {
          let key = "";
          const result = await database.transaction((tx) =>
            operation({
              query: async <Row extends QueryResultRow>(
                sql: string,
                values: readonly unknown[],
              ) => {
                const value = await tx.query<Row>(sql, values);
                if (sql.startsWith("INSERT INTO loom.idempotency_records")) {
                  key = String(values[3]);
                  if (rollback) throw new Error("synthetic rollback");
                }
                return value;
              },
            }),
          );
          if (key && key === loseKey) {
            loseKey = "";
            throw new Error("acknowledgement lost after COMMIT");
          }
          return result;
        },
      }),
    });
    t.after(server.close);
    const cert = await readFile(server.directory + "/cert.pem", "utf8"),
      admin = httpClient(server.origin, cert);
    await admin.enroll(server.ticket);
    const create = async (nickname: string, kind: string) => {
      const account = await admin.call("/api/v1/identity/accounts", {
        idempotency_key: randomUUID(),
        nickname,
        kind,
        role: "participant",
      });
      assert.equal(account.status, 200, JSON.stringify(account.body));
      const issued = await admin.call("/api/v1/identity/credentials", {
        idempotency_key: randomUUID(),
        participant_id: account.body.participant_id,
        kind: kind === "agent" ? "agent" : "enrollment",
        purpose: kind === "agent" ? null : "enroll",
        label: "Synthetic client",
        replace_credential_id: null,
      });
      assert.equal(issued.status, 200);
      const client = httpClient(
        server.origin,
        cert,
        kind === "agent" ? issued.body.secret : undefined,
      );
      if (kind === "human") await client.enroll(issued.body.secret);
      return {
        client,
        id: account.body.participant_id,
        secret: issued.body.secret,
        credential: issued.body.credential_id,
      };
    };
    const human = await create("synthetic_human", "human"),
      agent = await create("synthetic_agent", "agent");
    let area = "",
      proposal = "",
      overview = "",
      discussion = "",
      opening = "",
      reply = "",
      revision = "";
    await t.test(
      "setup discovery, atomic overview publication, and release schemas",
      async () => {
        const before = await human.client.call("/api/v1/community");
        assert.equal(before.body.overview.state, "setup_incomplete");
        assert.equal(before.body.proposal_area.state, "setup_incomplete");
        const input = {
          idempotency_key: randomUUID(),
          community_name: "Research commons",
          ordinary_area_name: "General",
          proposal_area_name: "Community organization",
          overview: content("A synthetic community overview."),
        };
        assert.equal(
          (await agent.client.call("/api/v1/community/setup", input)).status,
          403,
        );
        const setup = await admin.call("/api/v1/community/setup", input);
        assert.equal(setup.status, 201, JSON.stringify(setup.body));
        overview = setup.body.resource_id;
        const replay = await admin.call("/api/v1/community/setup", input);
        assert.equal(replay.body.revision_id, setup.body.revision_id);
        const info = (await human.client.call("/api/v1/community")).body;
        assert.equal(info.overview.resource_id, overview);
        proposal = info.proposal_area.resource_id;
        const areas = (await human.client.call("/api/v1/areas")).body;
        assert.equal(areas.items.length, 2);
        area = areas.items.find(
          (a: { title: string }) => a.title === "General",
        ).id;
        const schema = (await admin.call("/api/v1/openapi.json")).body;
        await SwaggerParser.validate(schema);
        assert.equal(schema.info.version, "participation-1");
        assert.ok(schema.paths["/api/v1/replies"]);
        const guide = (await agent.client.call("/api/v1/guide")).body;
        assert.equal(guide.contract_version, info.contract_version);
        assert.match(guide.text, /GET never marks content read/);
        const media = await agent.client.call(
          "/api/v1/replies",
          {},
          { headers: { "content-type": "text/plain" } },
        );
        assert.equal(media.status, 415);
        assert.equal(media.body.error.recovery.action, "correct_request");
        const getBody = await agent.client.call(
          "/api/v1/community",
          {},
          { method: "GET" },
        );
        assert.equal(getBody.status, 400);
        assert.equal(getBody.body.error.recovery.action, "correct_request");
      },
    );
    await t.test(
      "human creates discussion/opening atomically; HTTP agent retrieves actual parent and nests replies",
      async () => {
        const input = {
          idempotency_key: randomUUID(),
          area_id: area,
          title: "Which context should travel?",
          content: content("Start with the actual parent."),
        };
        const created = await human.client.call("/api/v1/discussions", input);
        assert.equal(created.status, 201, JSON.stringify(created.body));
        opening = created.body.resource_id;
        const detail = (await agent.client.call("/api/v1/resources/" + opening))
          .body;
        discussion = detail.discussion_id;
        assert.equal(detail.parent_id, null);
        assert.equal(detail.content.text, input.content.text);
        const d = (await agent.client.call("/api/v1/discussions/" + discussion))
          .body;
        assert.equal(d.opening.resource_id, opening);
        const first = await agent.client.call("/api/v1/replies", {
          idempotency_key: randomUUID(),
          discussion_id: discussion,
          parent_id: opening,
          content: content("I read the opening contribution."),
        });
        assert.equal(first.status, 201);
        reply = first.body.resource_id;
        revision = first.body.revision_id;
        const nested = await human.client.call("/api/v1/replies", {
          idempotency_key: randomUUID(),
          discussion_id: discussion,
          parent_id: reply,
          content: content("This answers the agent specifically."),
        });
        assert.equal(nested.status, 201);
        const ancestors = (
          await agent.client.call(
            "/api/v1/contributions/" +
              nested.body.resource_id +
              "/ancestors?limit=1",
          )
        ).body;
        assert.equal(ancestors.items[0].resource_id, reply);
        assert.equal(ancestors.complete, false);
        const next = (
          await agent.client.call(
            "/api/v1/contributions/" +
              nested.body.resource_id +
              "/ancestors?cursor=" +
              encodeURIComponent(ancestors.next_cursor),
          )
        ).body;
        assert.equal(next.items[0].resource_id, opening);
        assert.equal(next.complete, true);
        const children = (
          await human.client.call(
            "/api/v1/contributions/" + opening + "/children",
          )
        ).body;
        assert.deepEqual(
          children.items.map(
            (item: { resource_id: string }) => item.resource_id,
          ),
          [reply],
        );
        assert.equal(
          (
            await agent.client.call("/api/v1/replies", {
              idempotency_key: randomUUID(),
              discussion_id: randomUUID(),
              parent_id: reply,
              content: content("wrong discussion"),
            })
          ).status,
          404,
        );
        const other = await human.client.call("/api/v1/discussions", {
          ...input,
          idempotency_key: randomUUID(),
          title: "Another discussion",
        });
        await assert.rejects(
          server.database.transaction(async (tx) => {
            const bad = randomUUID();
            await tx.query(
              "INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id) VALUES ($1,'contribution',$2,$3)",
              [bad, discussion, human.id],
            );
            await tx.query(
              "INSERT INTO loom.contributions(id,discussion_id,parent_id) VALUES ($1,$2,$3)",
              [bad, discussion, other.body.resource_id],
            );
          }),
          { code: "23503" },
        );
        rollback = true;
        const failed = await human.client.call("/api/v1/discussions", {
          ...input,
          idempotency_key: randomUUID(),
          title: "Must roll back",
        });
        rollback = false;
        assert.equal(failed.status, 503);
        assert.equal(
          Number(
            (
              await server.observer.query(
                "SELECT count(*) FROM loom.discussions",
              )
            ).rows[0].count,
          ),
          2,
        );
      },
    );
    await t.test(
      "immutable exact revisions, conflicting bases, explicit entities and equivalent edit denial",
      async () => {
        const edit = {
          idempotency_key: randomUUID(),
          resource_id: reply,
          expected_revision_id: revision,
          title: null,
          content: content("Revised by the agent."),
        };
        assert.equal(
          (await human.client.call("/api/v1/revisions", edit)).status,
          403,
        );
        assert.equal(
          (
            await agent.client.call("/api/v1/revisions", {
              ...edit,
              resource_id: opening,
            })
          ).status,
          403,
        );
        const changed = await agent.client.call("/api/v1/revisions", edit);
        assert.equal(changed.status, 201);
        const stale = await agent.client.call("/api/v1/revisions", {
          ...edit,
          idempotency_key: randomUUID(),
          content: content("Stale proposal retained by client."),
        });
        assert.equal(stale.status, 409);
        assert.equal(
          stale.body.error.current_revision_id,
          changed.body.revision_id,
        );
        const retry = await agent.client.call("/api/v1/revisions", edit);
        assert.equal(retry.body.revision_id, changed.body.revision_id);
        const exact = await human.client.call(
          `/api/v1/resources/${reply}/revisions/${revision}`,
        );
        assert.equal(
          exact.body.content.text,
          "I read the opening contribution.",
        );
        await server.observer.query(
          "UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",
          [changed.body.revision_id],
        );
        const oldWhileSuppressed = await agent.client.call(
          `/api/v1/resources/${reply}/revisions/${revision}`,
        );
        assert.equal(oldWhileSuppressed.status, 200);
        assert.equal(oldWhileSuppressed.body.current_revision_id, null);
        assert.equal(oldWhileSuppressed.body.can_edit, false);
        assert.equal(
          (await agent.client.call("/api/v1/resources/" + reply)).status,
          404,
        );
        await server.observer.query(
          "UPDATE loom.revisions SET availability='available' WHERE id=$1",
          [changed.body.revision_id],
        );
        await assert.rejects(
          server.database.transaction((tx) =>
            tx.query("UPDATE loom.revisions SET content_text=$2 WHERE id=$1", [
              revision,
              "rewrite",
            ]),
          ),
          { code: "42501" },
        );
        for (const text of [
          "`[[mention:m]]`",
          "> [[mention:m]]",
          "[label [[mention:m]]](https://example.org)",
        ]) {
          const invalid = await agent.client.call("/api/v1/replies", {
            idempotency_key: randomUUID(),
            discussion_id: discussion,
            parent_id: opening,
            content: {
              format: "loom-markdown-v1",
              text,
              mentions: [{ token: "m", participant_id: human.id }],
            },
          });
          assert.equal(invalid.status, 400, text);
        }
        const mentioned = await agent.client.call("/api/v1/replies", {
          idempotency_key: randomUUID(),
          discussion_id: discussion,
          parent_id: opening,
          content: {
            format: "loom-markdown-v1",
            text: "Hello [[mention:m]]. Raw @synthetic_human is just text.",
            mentions: [{ token: "m", participant_id: human.id }],
          },
        });
        assert.equal(mentioned.status, 201);
        const body = (
          await human.client.call(
            `/api/v1/resources/${mentioned.body.resource_id}`,
          )
        ).body;
        assert.equal(body.content.mentions[0].participant_id, human.id);
        assert.equal(
          (
            await agent.client.call("/api/v1/replies", {
              idempotency_key: randomUUID(),
              discussion_id: discussion,
              parent_id: opening,
              content: content("public?"),
              audience: "private",
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "post-COMMIT response loss, restarted HTTP client, changed semantics and current authority",
      async () => {
        const input = {
          idempotency_key: randomUUID(),
          discussion_id: discussion,
          parent_id: reply,
          content: content("Lost acknowledgement, one contribution."),
        };
        loseKey = input.idempotency_key;
        const lost = await agent.client.call("/api/v1/replies", input);
        assert.equal(lost.status, 503);
        assert.equal(lost.body.error.operation_outcome, "unknown");
        const restarted = httpClient(server.origin, cert, agent.secret),
          status = {
            operation_kind: "reply.create",
            idempotency_key: input.idempotency_key,
          };
        const found = await restarted.call("/api/v1/operations/status", status);
        assert.equal(found.body.publication_state, "committed");
        const retry = await restarted.call("/api/v1/replies", input);
        assert.equal(retry.body.revision_id, found.body.revision_id);
        assert.equal(
          (
            await restarted.call("/api/v1/replies", {
              ...input,
              content: content("Changed intent"),
            })
          ).status,
          409,
        );
        const count = await server.observer.query(
          "SELECT count(*) FROM loom.idempotency_records WHERE participant_id=$1 AND operation_kind=$2 AND idempotency_key=$3",
          [agent.id, "reply.create", input.idempotency_key],
        );
        assert.equal(count.rows[0].count, "1");
        assert.equal(
          (await human.client.call("/api/v1/operations/status", status)).body
            .operation_state,
          "not_recorded",
        );
        await admin.call("/api/v1/identity/state", {
          idempotency_key: randomUUID(),
          participant_id: agent.id,
          state: "suspended",
          role: "participant",
        });
        assert.equal(
          (await restarted.call("/api/v1/operations/status", status)).status,
          401,
        );
        await admin.call("/api/v1/identity/state", {
          idempotency_key: randomUUID(),
          participant_id: agent.id,
          state: "active",
          role: "participant",
        });
        await server.observer.query(
          "UPDATE loom.resources SET state='suppressed' WHERE id=$1",
          [found.body.resource_id],
        );
        const unavailable = await restarted.call(
          "/api/v1/operations/status",
          status,
        );
        assert.equal(unavailable.status, 404);
        assert.equal(unavailable.body.error.current_revision_id, undefined);
      },
    );
    await t.test(
      "ordinary artifact editor rules, removed editing rights and safe setup unavailability",
      async () => {
        const initial = (await admin.call("/api/v1/resources/" + overview))
          .body;
        const editorInput = {
          idempotency_key: randomUUID(),
          resource_id: overview,
          expected_version: 0,
          participant_ids: [human.id],
        };
        assert.equal(
          (await human.client.call("/api/v1/editors", editorInput)).status,
          403,
        );
        assert.equal(
          (await agent.client.call("/api/v1/editors", editorInput)).status,
          403,
        );
        assert.equal(
          (await admin.call("/api/v1/editors", editorInput)).status,
          200,
        );
        const edit = {
          idempotency_key: randomUUID(),
          resource_id: overview,
          expected_revision_id: initial.revision_id,
          title: "Community overview",
          content: content("An ordinary text artifact revision."),
        };
        const published = await human.client.call("/api/v1/revisions", edit);
        assert.equal(published.status, 201);
        await admin.call("/api/v1/editors", {
          ...editorInput,
          idempotency_key: randomUUID(),
          expected_version: 1,
          participant_ids: [],
        });
        assert.equal(
          (await human.client.call("/api/v1/revisions", edit)).status,
          403,
        );
        assert.equal(
          (
            await human.client.call("/api/v1/operations/status", {
              operation_kind: "revision.publish",
              idempotency_key: edit.idempotency_key,
            })
          ).body.revision_id,
          published.body.revision_id,
        );
        await server.observer.query(
          "UPDATE loom.resources SET state='suppressed' WHERE id=$1",
          [overview],
        );
        await server.observer.query(
          "UPDATE loom.resources SET publication_open=false WHERE id=$1",
          [proposal],
        );
        const unavailable = (await human.client.call("/api/v1/community")).body;
        assert.deepEqual(unavailable.overview, { state: "unavailable" });
        assert.deepEqual(unavailable.proposal_area, { state: "unavailable" });
        assert.equal(
          (
            await human.client.call("/api/v1/discussions", {
              idempotency_key: randomUUID(),
              area_id: area,
              title: "Unrelated participation still works",
              content: content("Hello."),
            })
          ).status,
          201,
        );
      },
    );
    await t.test(
      "compatible text/JSON limits, bounded children, hidden scan continuation and no reading effects",
      async () => {
        const maximum = await agent.client.call("/api/v1/replies", {
          idempotency_key: randomUUID(),
          discussion_id: discussion,
          parent_id: opening,
          content: content("\u0001".repeat(16384)),
        });
        assert.equal(maximum.status, 201);
        const url = `/api/v1/resources/${maximum.body.resource_id}/revisions/${maximum.body.revision_id}`;
        const small = await agent.client.call(url + "?max_response_bytes=4096");
        assert.equal(small.status, 400);
        assert.equal(small.body.error.code, "response_budget_too_small");
        const full = await agent.client.call(url);
        assert.equal(full.status, 200);
        assert.equal(full.body.content.text.length, 16384);
        assert.ok(full.bytes <= 131072);
        assert.equal(small.body.error.minimum_response_bytes, full.bytes);
        assert.equal(
          (
            await agent.client.call("/api/v1/replies", {
              idempotency_key: randomUUID(),
              discussion_id: discussion,
              parent_id: opening,
              content: content("🧵".repeat(4097)),
            })
          ).status,
          400,
        );
        const accepted = await agent.client.call("/api/v1/replies", {
          idempotency_key: randomUUID(),
          discussion_id: discussion,
          parent_id: opening,
          content: content("🧵".repeat(4096)),
        });
        assert.equal(accepted.status, 201);
        // Hidden envelopes exercise bounded scan work without publishing hidden prose.
        await server.database.transaction(async (tx) => {
          for (let i = 0; i < 105; i++) {
            const id = randomUUID();
            await tx.query(
              "INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id,state) VALUES ($1,'contribution',$2,$3,'suppressed')",
              [id, discussion, human.id],
            );
            await tx.query("INSERT INTO loom.contributions VALUES ($1,$2,$3)", [
              id,
              discussion,
              reply,
            ]);
          }
        });
        let cursor = "",
          seen = 0,
          partial = false,
          requests = 0;
        do {
          const page = await agent.client.call(
            `/api/v1/contributions/${reply}/children?limit=1${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
          );
          assert.equal(page.status, 200);
          assert.ok(page.body.items.length <= 1);
          assert.ok(page.bytes <= 131072);
          partial ||= page.body.work_budget_reached;
          seen += page.body.items.length;
          cursor = page.body.next_cursor ?? "";
          assert.ok(++requests < 10);
        } while (cursor);
        assert.ok(partial);
        assert.equal(seen, 1);
        const before = (
          await server.observer.query(
            "SELECT shared_position FROM loom.community_clocks WHERE id=1",
          )
        ).rows[0].shared_position;
        await agent.client.call(url);
        await human.client.call("/api/v1/discussions/" + discussion);
        assert.equal(
          (
            await server.observer.query(
              "SELECT shared_position FROM loom.community_clocks WHERE id=1",
            )
          ).rows[0].shared_position,
          before,
        );
        assert.equal(
          (
            await server.observer.query(
              "SELECT count(*) FROM information_schema.tables WHERE table_schema='loom' AND table_name='read_receipts'",
            )
          ).rows[0].count,
          "0",
        );
      },
    );
    await t.test(
      "standalone external-client executable persists intent across process exit and exact retry (same machine)",
      async () => {
        const credential = server.directory + "/remote-token.txt",
          textFile = server.directory + "/remote-text.txt",
          journal = server.directory + "/remote-intent.json";
        await writeFile(credential, agent.secret, { mode: 0o600 });
        await writeFile(textFile, "Synthetic standalone HTTP client reply.", {
          mode: 0o600,
        });
        const args = [
          "scripts/participation-client.mjs",
          "--origin",
          server.origin,
          "--credential-file",
          credential,
          "--ca",
          server.directory + "/cert.pem",
          "--journal",
          journal,
        ];
        const run = (action: string, extra: string[] = []) =>
          promisify(execFile)(process.execPath, [
            ...args,
            "--action",
            action,
            ...extra,
          ]);
        await run("prepare", ["--parent", reply, "--text-file", textFile]);
        const original = JSON.parse(await readFile(journal, "utf8"));
        assert.equal(original.retrieved_parent.resource_id, reply);
        assert.equal(original.retrieved_ancestors[0].resource_id, opening);
        await assert.rejects(run("lose-response"), { code: 75 });
        assert.equal(
          JSON.parse(await readFile(journal, "utf8")).state,
          "uncertain",
        );
        await run("status");
        await run("retry");
        await run("inspect");
        const resolved = JSON.parse(await readFile(journal, "utf8"));
        assert.deepEqual(resolved.body, original.body);
        assert.equal(resolved.result.idempotency, "replayed");
        const count = await server.observer.query(
          "SELECT count(*) FROM loom.idempotency_records WHERE participant_id=$1 AND idempotency_key=$2",
          [agent.id, resolved.body.idempotency_key],
        );
        assert.equal(count.rows[0].count, "1");
      },
    );
    await t.test(
      "ordinary server restart preserves publication recovery and makes old view cursors explicit",
      async () => {
        const page = await agent.client.call(
          "/api/v1/contributions/" + opening + "/children?limit=1",
        );
        assert.ok(page.body.next_cursor);
        const intent = {
          idempotency_key: randomUUID(),
          discussion_id: discussion,
          parent_id: opening,
          content: content("Survives server restart."),
        };
        const first = await agent.client.call("/api/v1/replies", intent);
        assert.equal(first.status, 201);
        await server.app.close();
        const replacement = await createApplication({
          database: {
            isReady: () => server.database.isReady(),
            close: async () => {},
          },
          logger: false,
          tls: {
            cert,
            key: await readFile(server.directory + "/key.pem", "utf8"),
          },
          participation: participationProfile(server.database, {
            LOOM_PARTICIPATION_PROFILE: "synthetic",
            LOOM_ORIGIN: server.origin,
          }),
        });
        t.after(() => replacement.close());
        await replacement.listen({
          host: "127.0.0.1",
          port: Number(new URL(server.origin).port),
        });
        const newClient = httpClient(server.origin, cert, agent.secret),
          replay = await newClient.call("/api/v1/replies", intent);
        assert.equal(replay.body.revision_id, first.body.revision_id);
        const stale = await newClient.call(
          "/api/v1/contributions/" +
            opening +
            "/children?cursor=" +
            encodeURIComponent(page.body.next_cursor),
        );
        assert.equal(stale.body.error.code, "invalid_cursor");
      },
    );
  },
);
