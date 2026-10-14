import type { SqlTransaction } from '../db/postgres.js';
import { identityOf, type ActorContext } from '../modules/publication/actor.js';

/** Current authority, never claims cached by authentication. Participant first. */
export async function currentAuthority(tx: SqlTransaction, actor: ActorContext) {
  const identity = identityOf(actor);
  const participant = (await tx.query<{ state: string; role: string; kind: string; nickname: string | null }>(
    'SELECT state, role, kind, nickname FROM loom.participants WHERE id = $1 FOR SHARE', [identity.participantId])).rows[0];
  const credentials = (await tx.query<{ id: string; participant_id: string; state: string; kind: string; expires_at: Date | null; parent_credential_id: string | null; unexpired: boolean }>(`
SELECT id, participant_id, state, kind, expires_at, parent_credential_id,
  expires_at IS NULL OR expires_at > clock_timestamp() AS unexpired
FROM loom.participant_credentials WHERE id = $1 OR id = (
  SELECT parent_credential_id FROM loom.participant_credentials WHERE id = $1
) ORDER BY id FOR SHARE`, [identity.credentialId])).rows;
  const credential = credentials.find(row => row.id === identity.credentialId);
  const parent = credential?.parent_credential_id ? credentials.find(row => row.id === credential.parent_credential_id) : undefined;
  const channelMatches = participant && credential && (
    (participant.kind === 'internal' && credential.kind === 'internal')
    || (participant.kind === 'agent' && credential.kind === 'agent')
    || (participant.kind === 'human' && ['passkey', 'session'].includes(credential.kind))
  );
  if (participant?.state !== 'active' || credential?.state !== 'active' || !credential.unexpired
    || !channelMatches
    || credential.participant_id !== identity.participantId
    || (credential.kind === 'session' && (parent?.state !== 'active' || parent.kind !== 'passkey' || parent.participant_id !== identity.participantId))) return undefined;
  return { ...identity, administrator: participant.role === 'administrator', kind: participant.kind,
    nickname: participant.nickname, credentialKind: credential.kind };
}
