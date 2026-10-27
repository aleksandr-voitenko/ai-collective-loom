import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { httpClient } from './participation-http.js';
import { sql, owned, name, inventory, until } from '../../scripts/lib/pilot.mjs';
import { readInstance, docker } from '../../scripts/lib/pilot-files.mjs';
import { comparable, httpsCall } from '../../scripts/lib/recovery.mjs';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
type CommandOutput = (output: { stdout: string; stderr: string }) => void;
export async function pilotCommand(
  action: string,
  path: string,
  options: Record<string, string> = {},
  checkout = root,
  observe?: CommandOutput,
) {
  const args = [
    join(checkout, 'scripts/pilot.mjs'),
    action,
    '--instance',
    path,
    ...Object.entries(options).flatMap(([k, v]) => ['--' + k, v]),
  ];
  try {
    const output = await execute(process.execPath, args, {
      cwd: checkout,
      timeout: 240000,
      maxBuffer: 256 * 1024,
    });
    observe?.(output);
    return JSON.parse(output.stdout);
  } catch (error) {
    const diagnostic = String((error as { stderr?: string }).stderr ?? '').trim();
    const safe = /^Pilot refused: [A-Za-z0-9 ;:,.>_–()/-]+\.$/.test(diagnostic)
      ? diagnostic
      : 'private child diagnostics withheld';
    throw new Error('Pilot acceptance command failed: ' + action + '; ' + safe);
  }
}
export async function freePort() {
  const s = createServer();
  await new Promise<void>((r, j) => {
    s.once('error', j);
    s.listen({ host: '127.0.0.1', port: 0 }, r);
  });
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
export async function pilotFixture(
  onCreated?: (f: any) => void,
  checkout = root,
  observe?: CommandOutput,
) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'loom-pilot-acceptance-')),
    path = join(directory, 'instance with spaces'),
    testOwner = randomUUID();
  const f = {
    directory,
    path,
    testOwner,
    command: (action: string, options: Record<string, string> = {}) =>
      pilotCommand(action, path, options, checkout, observe),
    instance: () => readInstance(path),
    config: () => JSON.parse(readFileSync(join(path, 'config.json'), 'utf8')),
    async close() {
      if (existsSync(join(path, 'instance.json'))) {
        const d = readInstance(path);
        await pilotCommand('destroy-test', path, {
          'test-owner': testOwner,
          'confirm-instance': d.id,
        });
      }
      for (const kind of ['container', 'volume', 'network']) {
        const args = kind === 'container' ? ['container', 'ls', '--all'] : [kind, 'ls'];
        const remaining = docker([
          ...args,
          '--filter',
          'label=org.loom.test-owner=' + testOwner,
          '--format',
          kind === 'container' ? '{{.Names}}' : '{{.Name}}',
        ]);
        assert.equal(
          remaining,
          '',
          'acceptance teardown must leave no resource for its exact test owner',
        );
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
  onCreated?.(f);
  await f.command('init', {
    port: String(await freePort()),
    acknowledge: 'local-pilot-1',
    'test-owner': testOwner,
  });
  await f.command('start');
  return f;
}
export type PilotFixture = Awaited<ReturnType<typeof pilotFixture>>;
export const plain = (text: string) => ({ format: 'loom-markdown-v1', text, mentions: [] });
export async function populatePilot(f: PilotFixture) {
  const c = f.config(),
    d = f.instance(),
    enrollment = JSON.parse(readFileSync(join(f.path, 'enrollment/enrollment.json'), 'utf8'));
  const admin = httpClient(c.origin, c.tls.ca);
  const human = await admin.enroll(enrollment.ticket);
  const accepted = async (
    client: ReturnType<typeof httpClient>,
    path: string,
    body?: unknown,
  ) => {
    const r = await client.call(path, body);
    assert.ok(
      r.status >= 200 && r.status < 300,
      'pilot HTTPS ' + path.replace(/[a-f0-9-]{36}/g, ':id') + ' status ' + r.status,
    );
    return r.body;
  };
  await accepted(admin, '/api/v1/community/setup', {
    idempotency_key: randomUUID(),
    community_name: 'Persistent acceptance',
    ordinary_area_name: 'General',
    proposal_area_name: 'Proposals',
    overview: plain('Independent trial overview'),
  });
  const area = (await accepted(admin, '/api/v1/areas')).items.find(
    (x: any) => x.title === 'General',
  ).id;
  async function admit(nickname: string, kind: 'agent' | 'human' = 'agent') {
    const a = await accepted(admin, '/api/v1/identity/accounts', {
      idempotency_key: randomUUID(),
      nickname,
      kind,
      role: 'participant',
    });
    const issued = await accepted(admin, '/api/v1/identity/credentials', {
      idempotency_key: randomUUID(),
      participant_id: a.participant_id,
      kind: kind === 'agent' ? 'agent' : 'enrollment',
      purpose: kind === 'human' ? 'enroll' : null,
      label: 'Acceptance device',
      replace_credential_id: null,
    });
    return {
      id: a.participant_id,
      token: issued.secret,
      credential: issued.credential_id,
      client: httpClient(c.origin, c.tls.ca, kind === 'agent' ? issued.secret : undefined),
    };
  }
  const alice = await admit('pilot_alice'),
    bob = await admit('pilot_bob'),
    browser = await admit('pilot_browser', 'human');
  const opening = await accepted(alice.client, '/api/v1/discussions', {
    idempotency_key: randomUUID(),
    area_id: area,
    title: 'Retained discussion',
    content: plain('Opening exact text'),
  });
  const discussion = (await accepted(alice.client, '/api/v1/resources/' + opening.resource_id))
    .discussion_id;
  const reply = await accepted(bob.client, '/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion,
    parent_id: opening.resource_id,
    content: plain('Parent retained text'),
  });
  const nested = await accepted(alice.client, '/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion,
    parent_id: reply.resource_id,
    content: plain('Nested retained text'),
  });
  const bytes = [Buffer.from('Original exact Ω\r\n'), Buffer.from('Current exact bytes\n')];
  const upload = async (resource: string, path: string, data: Buffer, kind = 'area') => {
    const u = await accepted(alice.client, '/api/v1/file-uploads', {
      idempotency_key: randomUUID(),
      target: { kind, resource_id: resource },
      path,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      media_type: 'text/plain',
    });
    assert.equal(
      (
        await alice.client.call('/api/v1/file-uploads/' + u.upload_id + '/bytes', undefined, {
          bytes: data,
        })
      ).status,
      200,
    );
    await accepted(alice.client, '/api/v1/file-uploads/' + u.upload_id + '/finalize', {});
    return { path, source: { upload_id: u.upload_id } };
  };
  const member = await upload(area, 'nested/original.txt', bytes[0]!);
  const originalCommand = {
    idempotency_key: randomUUID(),
    area_id: area,
    title: 'Retained artifact',
    content: plain('Historical artifact'),
    file_set: { version: 'artifact-files-v1', files: [member] },
  };
  const first = await accepted(alice.client, '/api/v1/artifacts', originalCommand);
  const member2 = await upload(first.resource_id, 'nested/current.txt', bytes[1]!, 'artifact');
  const second = await accepted(alice.client, '/api/v1/revisions', {
    idempotency_key: randomUUID(),
    resource_id: first.resource_id,
    expected_revision_id: first.revision_id,
    title: 'Retained artifact',
    content: plain('Current artifact'),
    file_set: { version: 'artifact-files-v1', files: [member2] },
  });
  const preparation = await accepted(alice.client, '/api/v1/summary-preparations', {
    idempotency_key: randomUUID(),
    discussion_id: discussion,
    scope: 'full',
  });
  const summary = await accepted(alice.client, '/api/v1/summaries', {
    idempotency_key: randomUUID(),
    discussion_id: discussion,
    title: 'Retained summary',
    content: {
      format: 'loom-markdown-v2',
      text: 'Exact synthesis',
      mentions: [],
      references: [
        {
          reference_id: randomUUID(),
          target: {
            kind: 'artifact',
            resource_id: first.resource_id,
            revision_id: first.revision_id,
          },
          relationship: null,
          rationale: 'Historical evidence',
        },
      ],
    },
    coverage: { preparation_id: preparation.preparation_id },
  });
  const saved = {
    idempotency_key: randomUUID(),
    target: {
      kind: 'revision',
      resource_id: first.resource_id,
      revision_id: first.revision_id,
    },
    saved: true,
    expected_version: 0,
  };
  const follow = {
    idempotency_key: randomUUID(),
    target: { kind: 'discussion', resource_id: discussion },
    include_descendants: false,
    preferences: ['replies'],
    following: true,
    expected_version: 0,
  };
  const reading = {
    idempotency_key: randomUUID(),
    basis: 'manual',
    episode_id: null,
    targets: [
      {
        resource_id: first.resource_id,
        revision_id: first.revision_id,
        read: true,
        expected_version: 0,
      },
    ],
  };
  const note = {
    idempotency_key: randomUUID(),
    note_id: randomUUID(),
    title: 'Private retained choice',
    body: 'Private exact note',
    links: [],
  };
  for (const [path, body] of [
    ['/api/v1/me/saved-items/state', saved],
    ['/api/v1/me/following/state', follow],
    ['/api/v1/me/reading/state', reading],
    ['/api/v1/me/notes/create', note],
  ] as const)
    await accepted(alice.client, path, body);
  const reads: any[] = [];
  const expectRead = async (token: string, path: string, body?: unknown, status = 200) => {
    const expected = comparable(await httpsCall(c.origin, c.tls.ca, path, body, token), path);
    assert.equal(expected.status, status, 'independent expected status');
    reads.push({ token, path, ...(body === undefined ? {} : { body }), expected });
    return expected.body;
  };
  for (const revision of [opening, reply, nested, first, second, summary])
    await expectRead(
      alice.token,
      `/api/v1/resources/${revision.resource_id}/revisions/${revision.revision_id}`,
    );
  const downloads: string[] = [];
  for (const [index, revision] of [first, second].entries()) {
    const files = await expectRead(
      alice.token,
      `/api/v1/artifacts/${revision.resource_id}/revisions/${revision.revision_id}/files?prefix=nested`,
    );
    const url = files.items[0].download_url;
    downloads.push(url);
    assert.equal(await expectRead(alice.token, url), bytes[index]!.toString('base64'));
  }
  await expectRead(alice.token, '/api/v1/me/notes/' + note.note_id);
  await expectRead(bob.token, '/api/v1/me/notes/' + note.note_id, undefined, 404);
  await expectRead(
    bob.token,
    '/api/v1/revisions',
    {
      idempotency_key: randomUUID(),
      resource_id: first.resource_id,
      expected_revision_id: second.revision_id,
      title: 'Forbidden',
      content: plain('Not an editor'),
    },
    403,
  );
  for (const [path, body] of [
    ['/api/v1/me/saved-items/state', saved],
    ['/api/v1/me/following/state', follow],
    ['/api/v1/me/reading/state', reading],
    ['/api/v1/me/notes/create', note],
    ['/api/v1/artifacts', originalCommand],
  ] as const)
    await expectRead(alice.token, path, body, path === '/api/v1/artifacts' ? 201 : 200);
  const instance = sql(d, 'SELECT instance_id FROM loom.community_settings WHERE id=1');
  const expectations = join(f.directory, 'expectations.json');
  writeFileSync(
    expectations,
    JSON.stringify({ format: 'loom-recovery-expectations-1', instance, reads }),
    { mode: 0o600 },
  );
  const verifyReads = async (origin = c.origin, ca = c.tls.ca) => {
    for (const r of reads)
      assert.deepEqual(
        comparable(await httpsCall(origin, ca, r.path, r.body, r.token), r.path),
        r.expected,
      );
  };
  return {
    c,
    d,
    admin,
    human,
    alice,
    bob,
    browser,
    area,
    opening,
    discussion,
    reply,
    nested,
    first,
    second,
    summary,
    note,
    saved,
    follow,
    reading,
    bytes,
    downloads,
    originalCommand,
    expectations,
    reads,
    verifyReads,
    accepted,
    upload,
  };
}
export { sql, owned, name, inventory, until, readInstance };
