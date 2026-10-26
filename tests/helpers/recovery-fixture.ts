import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:https';
import { httpClient } from './participation-http.js';
import { createInstance, sql, httpsCall, comparable } from '../../scripts/lib/recovery.mjs';

// These expectations are captured through the real application before backup.
// The restore implementation does not construct them or know this fixture's IDs.
export async function recoveryFixture(
  directory: string,
  onSource: (source: any) => void = () => {},
) {
  const source = await createInstance(directory + '/source');
  onSource(source);
  const c = JSON.parse(readFileSync(source.path + '/config.json', 'utf8'));
  const enrollment = JSON.parse(readFileSync(source.path + '/enrollment.json', 'utf8'));
  const admin = httpClient(c.origin, c.tls.cert);
  await admin.enroll(enrollment.ticket);
  const accepted = async (client: ReturnType<typeof httpClient>, path: string, body?: unknown) => {
    const r = await client.call(path, body);
    assert.ok(
      r.status >= 200 && r.status < 300,
      'Fixture application request failed: ' + path.replace(/[a-f\d-]{36}/g, ':id'),
    );
    return r.body;
  };
  // The cold-recovery corpus and its independent clients use an explicit finite
  // workload policy, captured/restored with its original audit and accounting.
  await accepted(admin, '/api/v1/admin/participation-rates/state', {idempotency_key:randomUUID(),expected_version:1,ordinary_requests:6000,new_publications:600,recovery_control:1200});
  await accepted(admin, '/api/v1/community/setup', {
    idempotency_key: randomUUID(),
    community_name: 'Recovery rehearsal',
    ordinary_area_name: 'General',
    proposal_area_name: 'Proposals',
    overview: { format: 'loom-markdown-v1', text: 'Synthetic overview', mentions: [] },
  });
  const area = (await accepted(admin, '/api/v1/areas')).items.find(
    (x: any) => x.title === 'General',
  ).id;
  async function agent(nickname: string) {
    const account = await accepted(admin, '/api/v1/identity/accounts', {
      idempotency_key: randomUUID(),
      nickname,
      kind: 'agent',
      role: 'participant',
    });
    const issued = await accepted(admin, '/api/v1/identity/credentials', {
      idempotency_key: randomUUID(),
      participant_id: account.participant_id,
      kind: 'agent',
      purpose: null,
      label: 'Disposable fixture',
      replace_credential_id: null,
    });
    return {
      id: account.participant_id,
      token: issued.secret,
      client: httpClient(c.origin, c.tls.cert, issued.secret),
      credential: issued.credential_id,
    };
  }
  const alice = await agent('recovery_alice'),
    bob = await agent('recovery_bob');
  const plain = (text: string) => ({ format: 'loom-markdown-v1', text, mentions: [] });
  const text = (value: string) => ({
    format: 'loom-markdown-v3',
    text: value,
    mentions: [],
    references: [],
  });
  const upload = async (
    target: { kind: string; resource_id: string },
    path: string,
    bytes: Buffer,
  ) => {
    const u = await accepted(alice.client, '/api/v1/file-uploads', {
      idempotency_key: randomUUID(),
      target,
      path,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      media_type: 'text/plain',
    });
    const sent = await alice.client.call(
      '/api/v1/file-uploads/' + u.upload_id + '/bytes',
      undefined,
      { bytes },
    );
    assert.equal(sent.status, 200);
    await accepted(alice.client, '/api/v1/file-uploads/' + u.upload_id + '/finalize', {});
    return { path, source: { upload_id: u.upload_id } };
  };
  const oldBytes = Buffer.from('Historical native file Ω\r\n'),
    newBytes = Buffer.from('Current native file\n');
  const member = await upload({ kind: 'area', resource_id: area }, 'nested/original.txt', oldBytes);
  const originalCommand = {
    idempotency_key: randomUUID(),
    area_id: area,
    title: 'Recoverable artifact',
    content: text('Historical artifact text Ω\r\n'),
    change_note: null,
    change_account: null,
    file_set: { version: 'artifact-files-v1', files: [member] },
  };
  writeFileSync(
    directory + '/uncertain-command.json',
    JSON.stringify({ state: 'uncertain', kind: 'artifact.create', body: originalCommand }),
    { mode: 0o600 },
  );
  // Response headers follow COMMIT, but the client discards the body and retains exact unknown intent.
  await new Promise<void>((resolve, reject) => {
    const encoded = JSON.stringify(originalCommand),
      req = request(
        new URL('/api/v1/artifacts', c.origin),
        {
          ca: c.tls.cert,
          agent: false,
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + alice.token,
            origin: c.origin,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(encoded),
          },
        },
        (response) => {
          const status = response.statusCode;
          response.destroy();
          status === 201 ? resolve() : reject(new Error('Lost-reply fixture failed'));
        },
      );
    req.setTimeout(20000, () => req.destroy());
    req.once('error', reject);
    req.end(encoded);
  });
  const first = await accepted(alice.client, '/api/v1/operations/status', {
    operation_kind: 'artifact.create',
    idempotency_key: originalCommand.idempotency_key,
  });
  const secondMember = await upload(
    { kind: 'artifact', resource_id: first.resource_id },
    'nested/current.txt',
    newBytes,
  );
  const second = await accepted(alice.client, '/api/v1/revisions', {
    idempotency_key: randomUUID(),
    resource_id: first.resource_id,
    expected_revision_id: first.revision_id,
    title: 'Recoverable artifact',
    content: text('Current artifact text'),
    change_note: null,
    change_account: null,
    file_set: { version: 'artifact-files-v1', files: [secondMember] },
  });
  const attachment = await upload(
    { kind: 'opening', resource_id: area },
    'source.txt',
    Buffer.from('Independent promotion bytes\n'),
  );
  const opening = await accepted(alice.client, '/api/v1/discussions', {
    idempotency_key: randomUUID(),
    area_id: area,
    title: 'Recovery discussion',
    content: plain('Opening exact text'),
    attachment_set: { version: 'contribution-attachments-v1', files: [attachment] },
  });
  const discussion = (await accepted(alice.client, '/api/v1/resources/' + opening.resource_id))
    .discussion_id;
  const reply = await accepted(bob.client, '/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion,
    parent_id: opening.resource_id,
    content: plain('Parent exact contribution'),
  });
  const nested = await accepted(alice.client, '/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion,
    parent_id: reply.resource_id,
    content: plain('Nested exact contribution'),
  });
  const nested2 = await accepted(alice.client, '/api/v1/revisions', {
    idempotency_key: randomUUID(),
    resource_id: nested.resource_id,
    expected_revision_id: nested.revision_id,
    title: null,
    content: plain('Nested current contribution'),
  });
  const attachments = await accepted(
    alice.client,
    `/api/v1/contributions/${opening.resource_id}/revisions/${opening.revision_id}/attachments`,
  );
  const promotionCommand = {
    idempotency_key: randomUUID(),
    source: {
      contribution_id: opening.resource_id,
      revision_id: opening.revision_id,
      file_id: attachments.items[0].file_id,
    },
    area_id: area,
    title: 'Independent promoted artifact',
  };
  const promoted = await accepted(bob.client, '/api/v1/attachment-promotions', promotionCommand);
  const opening2 = await accepted(alice.client, '/api/v1/revisions', {
    idempotency_key: randomUUID(),
    resource_id: opening.resource_id,
    expected_revision_id: opening.revision_id,
    title: 'Recovery discussion',
    content: plain('Opening current exact text'),
    attachment_set: { version: 'contribution-attachments-v1', files: [] },
  });
  const prep = await accepted(alice.client, '/api/v1/summary-preparations', {
    idempotency_key: randomUUID(),
    discussion_id: discussion,
    scope: 'full',
  });
  const reference = {
    reference_id: randomUUID(),
    target: { kind: 'artifact', resource_id: first.resource_id, revision_id: first.revision_id },
    relationship: null,
    rationale: 'Exact historical context',
  };
  const summary = await accepted(alice.client, '/api/v1/summaries', {
    idempotency_key: randomUUID(),
    discussion_id: discussion,
    title: 'Declared recovery summary',
    content: {
      format: 'loom-markdown-v2',
      text: 'Independent synthesis',
      mentions: [],
      references: [reference],
    },
    coverage: { preparation_id: prep.preparation_id },
  });
  const note = {
    idempotency_key: randomUUID(),
    note_id: randomUUID(),
    title: 'Private fixture',
    body: 'Private synthetic observation ' + randomUUID(),
    links: [{ kind: 'artifact', resource_id: first.resource_id, revision_id: first.revision_id }],
  };
  await accepted(alice.client, '/api/v1/me/notes/create', note);
  await accepted(alice.client, '/api/v1/me/notes/update', {
    ...note,
    idempotency_key: randomUUID(),
    expected_version: 1,
    body: note.body + ' current',
  });
  const conflict = {
    ...note,
    idempotency_key: randomUUID(),
    expected_version: 1,
    body: 'Unapplied synthetic conflict',
  };
  assert.equal(
    (await accepted(alice.client, '/api/v1/me/notes/update', conflict)).operation_state,
    'version_conflict',
  );
  const deleted = {
    ...note,
    idempotency_key: randomUUID(),
    note_id: randomUUID(),
    title: 'Terminal private identity',
  };
  await accepted(alice.client, '/api/v1/me/notes/create', deleted);
  await accepted(alice.client, '/api/v1/me/notes/delete', {
    idempotency_key: randomUUID(),
    note_id: deleted.note_id,
    expected_version: 1,
  });
  const saved = {
    idempotency_key: randomUUID(),
    target: { kind: 'revision', resource_id: first.resource_id, revision_id: first.revision_id },
    saved: true,
    expected_version: 0,
  };
  await accepted(alice.client, '/api/v1/me/saved-items/state', saved);
  await accepted(alice.client, '/api/v1/me/saved-items/state', {
    ...saved,
    idempotency_key: randomUUID(),
    saved: false,
    expected_version: 1,
  });
  const follow = {
    idempotency_key: randomUUID(),
    target: { kind: 'discussion', resource_id: discussion },
    include_descendants: false,
    preferences: ['replies'],
    following: true,
    expected_version: 0,
  };
  await accepted(alice.client, '/api/v1/me/following/state', follow);
  const reading = {
    idempotency_key: randomUUID(),
    basis: 'manual',
    episode_id: null,
    targets: [
      {
        resource_id: first.resource_id,
        revision_id: first.revision_id,
        read: false,
        expected_version: 0,
      },
    ],
  };
  await accepted(alice.client, '/api/v1/me/reading/state', reading);
  const mute = {
    idempotency_key: randomUUID(),
    target: { kind: 'artifact', resource_id: first.resource_id },
    include_descendants: false,
    muted: true,
    expected_version: 0,
  };
  await accepted(alice.client, '/api/v1/me/attention/mutes/state', mute);
  const reservation = await accepted(alice.client, '/api/v1/editing-intent/announce', {
    idempotency_key: randomUUID(),
    resource_id: first.resource_id,
    base_revision_id: second.revision_id,
    purpose: 'Rehearsal editing',
    scope: { kind: 'whole' },
    duration_minutes: 1,
  });
  // A waiting upload and an unused preparation/session retain real fixed deadlines.
  const waiting = await accepted(alice.client, '/api/v1/file-uploads', {
    idempotency_key: randomUUID(),
    target: { kind: 'artifact', resource_id: first.resource_id },
    path: 'waiting.txt',
    size: 0,
    sha256: createHash('sha256').update('').digest('hex'),
    media_type: 'text/plain',
  });
  const unused = await accepted(alice.client, '/api/v1/summary-preparations', {
    idempotency_key: randomUUID(),
    discussion_id: discussion,
    scope: 'full',
  });
  const browserAccount = await accepted(admin, '/api/v1/identity/accounts', {
    idempotency_key: randomUUID(),
    nickname: 'recovery_browser',
    kind: 'human',
    role: 'participant',
  });
  const browserTicket = await accepted(admin, '/api/v1/identity/credentials', {
    idempotency_key: randomUUID(),
    participant_id: browserAccount.participant_id,
    kind: 'enrollment',
    purpose: 'enroll',
    label: 'Restored browser',
    replace_credential_id: null,
  });
  // Wait for real derived processing before capture, without changing worker policies.
  const deadline = Date.now() + 20000;
  while (Number(sql(source, 'SELECT count(*) FROM loom.personal_deliveries')) < 1) {
    assert.ok(Date.now() < deadline, 'Notification fixture did not settle');
    await delay(200);
  }
  const state = await accepted(admin, '/api/v1/organization/resources/' + discussion);
  await accepted(admin, '/api/v1/organization/changes', {
    idempotency_key: randomUUID(),
    kind: 'discussion.close',
    resource_id: discussion,
    expected_version: state.version,
    expected_hierarchy_version: state.hierarchy_version,
  });
  const moderation = await accepted(
    admin,
    '/api/v1/admin/moderation/resources/' + reply.resource_id,
  );
  await accepted(admin, '/api/v1/admin/moderation/state', {
    idempotency_key: randomUUID(),
    target: moderation.target,
    suppressed: true,
    expected_version: moderation.version,
  });
  const filePolicyCommand = {idempotency_key: randomUUID(), expected_version: 1,
    max_file_bytes: 1, max_unfinished_uploads: 1, participant_reserved_bytes: 1, community_reserved_bytes: 1};
  const policyAdministrator = await accepted(admin, '/api/v1/identity/accounts', {idempotency_key:randomUUID(), nickname:'recovery_policy',kind:'agent',role:'administrator'});
  const adminBearer = await accepted(admin, '/api/v1/identity/credentials', {
    idempotency_key: randomUUID(), participant_id: policyAdministrator.participant_id,
    kind: 'agent', purpose: null, label: 'Policy recovery verifier', replace_credential_id: null,
  });
  await accepted(httpClient(c.origin,c.tls.cert,adminBearer.secret), '/api/v1/admin/file-limits/state', filePolicyCommand);
  const unknownKey = randomUUID();
  const reads: any[] = [];
  async function expectRead(token: string, path: string, body?: unknown, status = 200) {
    const expected = comparable(await httpsCall(c.origin, c.tls.cert, path, body, token), path);
    assert.equal(expected.status, status, 'Independent expectation status: ' + reads.length);
    reads.push({ token, path, ...(body === undefined ? {} : { body }), expected });
    return expected;
  }
  await expectRead(adminBearer.secret, '/api/v1/admin/file-limits/status', {idempotency_key:filePolicyCommand.idempotency_key});
  await expectRead(adminBearer.secret, '/api/v1/admin/file-limits/state', filePolicyCommand);
  await expectRead(adminBearer.secret, '/api/v1/admin/file-limits/audit', {});
  await expectRead(alice.token, '/api/v1/file-uploads', {
    idempotency_key: randomUUID(), target:{kind:'area',resource_id:area}, path:'quota-refused.txt',
    size:2, sha256:createHash('sha256').update('xx').digest('hex'), media_type:'text/plain',
  },409);
  for (const revision of [first, second, opening, opening2, nested, nested2, summary, promoted])
    await expectRead(
      alice.token,
      `/api/v1/resources/${revision.resource_id}/revisions/${revision.revision_id}`,
    );
  await expectRead(alice.token, '/api/v1/resources/' + first.resource_id);
  for (const revision of [first, second, promoted]) {
    const page = await expectRead(
      alice.token,
      `/api/v1/artifacts/${revision.resource_id}/revisions/${revision.revision_id}/files?prefix=${revision === promoted ? '' : 'nested'}`,
    );
    assert.equal(page.status, 200);
    for (const item of page.body.items)
      if (item.download_url) await expectRead(alice.token, item.download_url);
  }
  await expectRead(alice.token, attachments.items[0].download_url);
  await expectRead(
    alice.token,
    `/api/v1/artifacts/${promoted.resource_id}/revisions/${promoted.revision_id}/provenance`,
  );
  await expectRead(
    alice.token,
    `/api/v1/summaries/${summary.resource_id}/revisions/${summary.revision_id}/coverage`,
  );
  await expectRead(
    alice.token,
    `/api/v1/resources/${summary.resource_id}/revisions/${summary.revision_id}/references`,
  );
  await expectRead(alice.token, '/api/v1/resources/' + reply.resource_id, undefined, 404);
  await expectRead(
    bob.token,
    '/api/v1/revisions',
    {
      idempotency_key: randomUUID(),
      resource_id: first.resource_id,
      expected_revision_id: second.revision_id,
      title: 'Refused editor',
      content: text('Unapplied'),
      change_note: null,
      change_account: null,
      file_set: { version: 'artifact-files-v1', files: [] },
    },
    403,
  );
  await expectRead(
    alice.token,
    '/api/v1/replies',
    {
      idempotency_key: randomUUID(),
      discussion_id: discussion,
      parent_id: opening.resource_id,
      content: plain('Closed discussion refusal'),
    },
    403,
  );
  await expectRead(alice.token, '/api/v1/organization/resources/' + discussion);
  await expectRead(alice.token, '/api/v1/me/notes/' + note.note_id);
  await expectRead(bob.token, '/api/v1/me/notes/' + note.note_id, undefined, 404);
  await expectRead(alice.token, '/api/v1/me/notes/' + deleted.note_id);
  await expectRead(alice.token, '/api/v1/me/notes/create', note);
  await expectRead(alice.token, '/api/v1/me/notes/update', conflict);
  await expectRead(alice.token, '/api/v1/me/saved-items/state', saved);
  await expectRead(alice.token, '/api/v1/me/following/state', follow);
  await expectRead(alice.token, '/api/v1/me/reading/state', reading);
  await expectRead(alice.token, '/api/v1/me/attention/mutes/state', mute);
  await expectRead(alice.token, '/api/v1/artifacts', originalCommand, 201);
  await expectRead(bob.token, '/api/v1/attachment-promotions', promotionCommand, 201);
  await expectRead(alice.token, '/api/v1/operations/status', {
    operation_kind: 'artifact.create',
    idempotency_key: unknownKey,
  });
  await expectRead(alice.token, '/api/v1/file-uploads/' + waiting.upload_id);
  const instance = JSON.parse(
    sql(source, 'SELECT row_to_json(t) FROM loom.community_settings t WHERE id=1'),
  ).instance_id;
  const expectations = directory + '/expectations.json';
  writeFileSync(
    expectations,
    JSON.stringify({ format: 'loom-recovery-expectations-1', instance, reads }),
    { mode: 0o600 },
  );
  return {
    source,
    c,
    admin,
    alice,
    bob,
    first,
    second,
    promoted,
    originalCommand,
    note,
    deleted,
    saved,
    waiting,
    reservation,
    unused,
    browserTicket: browserTicket.secret,
    expectations,
    expectRead,
    accepted,
    area,
  };
}
