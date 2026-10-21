import { validUnicode } from "../../../contracts/authored.js";
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  EditorsInput,
  SettingsInput,
} from "../../../contracts/participation.js";
import { lockAttempt } from "../../application/attempt.js";
import { identityOf, type ActorContext } from "../publication/actor.js";
import { PublicationError, safeError } from "../publication/errors.js";
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import type { Transactions } from '../../db/postgres.js';
import { digestRequest } from "./publications.js";

export class ParticipationAdministration {
  constructor(private readonly database: Transactions) {}
  async change(
    actorContext: ActorContext,
    kind: "community.settings" | "artifact.editors" | "summary.editors",
    value: unknown,
  ) {
    if (
      !Value.Check(
        kind === "community.settings" ? SettingsInput : EditorsInput,
        value,
      )
    )
      throw new PublicationError("invalid_input");
    const data = structuredClone(value) as Record<string, unknown>;
    for (const [key, field] of Object.entries(data))
      if (
        (key.endsWith("_id") || key === "idempotency_key") &&
        typeof field === "string"
      )
        data[key] = field.toLowerCase();
    const participants =
      (data.participant_ids as string[] | undefined)
        ?.map((id) => id.toLowerCase())
        .sort() ?? [];
    if (new Set(participants).size !== participants.length)
      throw new PublicationError("invalid_input");
    if ("participant_ids" in data) data.participant_ids = participants;
    const { idempotency_key: key, ...fields } = data,
      digest = digestRequest(kind, fields),
      identity = identityOf(actorContext);
    try {
      return await this.database.transaction(async (tx) => {
        await lockAttempt(tx, identity.participantId, kind, String(key));
        for (const id of [
          ...new Set([identity.participantId, ...participants]),
        ].sort())
          await tx.query(
            "SELECT id FROM loom.participants WHERE id=$1 FOR SHARE",
            [id],
          );
        const actor = await lockActor(tx, actorContext);
        if (!actor.administrator) throw new PublicationError("forbidden");
        const saved = (
          await tx.query<{
            id: string;
            request_digest: string;
            result_version: number;
          }>(
            "SELECT id,request_digest,result_version FROM loom.participation_audit WHERE actor_id=$1 AND operation_kind=$2 AND idempotency_key=$3",
            [actor.participantId, kind, key],
          )
        ).rows[0];
        if (saved) {
          if (saved.request_digest !== digest)
            throw new PublicationError("idempotency_conflict");
          return {
            operation_state: "committed",
            operation_id: saved.id,
            version: saved.result_version,
          };
        }
        let target: string, version: number;
        if (kind === "community.settings") {
          const name = data.community_name as string;
          if (!name.trim() || !validUnicode(name) || name.includes("\0"))
            throw new PublicationError("invalid_input");
          await tx.query(
            "SELECT pg_advisory_xact_lock($1::integer,$2::integer)",
            [0x4c4f4f4d, 3],
          );
          const current = (
            await tx.query<{ instance_id: string; version: number }>(
              "SELECT instance_id,version FROM loom.community_settings WHERE id=1 FOR UPDATE",
              [],
            )
          ).rows[0]!;
          if (current.version !== data.expected_version)
            throw new PublicationError("revision_conflict");
          for (const [id, resourceKind] of [
            [data.overview_id, "artifact"],
            [data.proposal_area_id, "area"],
          ] as const)
            if (id) {
              const chain = await lockContext(tx, String(id), "resolution", [
                resourceKind,
              ]);
              if (resourceKind === "artifact") {
                if (!chain[0]!.current_revision_id)
                  throw new PublicationError("unavailable");
                await requireRevision(
                  tx,
                  String(id),
                  chain[0]!.current_revision_id,
                );
              } else if (!chain.every((r) => r.publication_open))
                throw new PublicationError("forbidden");
            }
          version = current.version + 1;
          target = current.instance_id;
          await tx.query(
            "UPDATE loom.community_settings SET version=$1,community_name=$2,overview_id=$3,proposal_area_id=$4 WHERE id=1",
            [version, name, data.overview_id, data.proposal_area_id],
          );
        } else {
          target = String(data.resource_id);
          await lockContext(tx, target, "publication", [kind === 'summary.editors' ? 'summary' : 'artifact']);
          const current = (
            await tx.query<{ editors_version: number }>(
              "SELECT editors_version FROM loom.resources WHERE id=$1",
              [target],
            )
          ).rows[0]!;
          if (current.editors_version !== data.expected_version)
            throw new PublicationError("revision_conflict");
          for (const id of participants)
            if (
              !(
                await tx.query(
                  "SELECT id FROM loom.participants WHERE id=$1 AND state='active' AND kind <> 'internal'",
                  [id],
                )
              ).rowCount
            )
              throw new PublicationError("invalid_input");
          version = current.editors_version + 1;
          await tx.query(
            "DELETE FROM loom.resource_editors WHERE resource_id=$1",
            [target],
          );
          for (const id of participants)
            await tx.query("INSERT INTO loom.resource_editors VALUES ($1,$2)", [
              target,
              id,
            ]);
          await tx.query(
            "UPDATE loom.resources SET editors_version=$2 WHERE id=$1",
            [target, version],
          );
        }
        const id = randomUUID();
        await tx.query(
          "INSERT INTO loom.participation_audit(id,actor_id,actor_credential_id,operation_kind,target_id,idempotency_key,request_digest,result_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id,
            actor.participantId,
            actor.credentialId,
            kind,
            target,
            key,
            digest,
            version,
          ],
        );
        return { operation_state: "committed", operation_id: id, version };
      });
    } catch (error) {
      return safeError(error);
    }
  }
}
