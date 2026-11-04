import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { administrativeReadClient } from '../../scripts/lib/administrative-read-client.mjs';

const token = 'loom_agent.00000000-0000-4000-8000-000000000001.synthetic_read_fixture';

test('private credential admission rejects unsafe origins, permissions, size and malformed proof', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-read-admission-'));
  const credentialFile = join(dir, 'credential');
  try {
    await writeFile(credentialFile, token, { mode: 0o600 });
    for (const origin of ['http://localhost', 'https://localhost/path', 'https://user@localhost', 'https://localhost/?query', 'https://localhost/#hash']) {
      await assert.rejects(administrativeReadClient({ origin, credentialFile }));
    }
    const options = { origin: 'https://localhost', credentialFile };
    await chmod(credentialFile, 0o644);
    await assert.rejects(administrativeReadClient(options));
    await chmod(credentialFile, 0o600);
    await writeFile(credentialFile, 'x'.repeat(1025));
    await assert.rejects(administrativeReadClient(options));
    await writeFile(credentialFile, 'not-an-agent-proof');
    await assert.rejects(administrativeReadClient(options));
    await assert.rejects(administrativeReadClient({ ...options, credentialFile: dir }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('verified HTTPS preserves GET/POST bytes, response bounds, safe errors and no retries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-read-https-'));
  let server;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    const caFile = join(dir, 'cert.pem'), credentialFile = join(dir, 'credential');
    await writeFile(credentialFile, token, { mode: 0o600 });
    const seen = [];
    server = createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(caFile) }, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({ method: req.method, path: req.url, proof: req.headers.authorization, type: req.headers['content-type'], length: req.headers['content-length'], body: Buffer.concat(chunks).toString() });
      if (req.url.endsWith('/redirect')) { res.writeHead(302, { location: '/api/v1/get' }); res.end('{}'); }
      else if (req.url.endsWith('/invalid')) res.end('not JSON');
      else if (req.url.endsWith('/large')) res.end(JSON.stringify('x'.repeat(32767)));
      else if (req.url.endsWith('/limit')) res.end(JSON.stringify('x'.repeat(32766)));
      else if (req.url.endsWith('/error')) { res.writeHead(403); res.end(JSON.stringify({ error: { code: 'forbidden', detail: 'private-error-canary' } })); }
      else res.end(JSON.stringify({ accepted: true }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `https://127.0.0.1:${server.address().port}`;
    const client = await administrativeReadClient({ origin, credentialFile, caFile });
    assert.equal(client.origin.origin, origin);
    assert.deepEqual(await client.call('get'), { accepted: true });
    const body = { cursor: 'opaque-cursor', text: '雪' };
    assert.deepEqual(await client.call('query', body), { accepted: true });
    assert.deepEqual(seen.slice(0, 2), [
      { method: 'GET', path: '/api/v1/get', proof: 'Bearer ' + token, type: undefined, length: undefined, body: '' },
      { method: 'POST', path: '/api/v1/query', proof: 'Bearer ' + token, type: 'application/json', length: String(Buffer.byteLength(JSON.stringify(body))), body: JSON.stringify(body) },
    ]);
    assert.equal((await client.call('limit')).length, 32766);
    await assert.rejects(client.call('large'));
    await assert.rejects(client.call('invalid'));
    const messages = [], originalWrite = process.stderr.write;
    process.stderr.write = (message) => { messages.push(String(message)); return true; };
    try {
      await assert.rejects(client.call('error'));
      await assert.rejects(client.call('redirect'));
    } finally { process.stderr.write = originalWrite; }
    assert.deepEqual(messages, ['forbidden; explicitly refresh or correct the request.\n', 'HTTPS read failed; retry the same read.\n']);
    assert.equal(seen.length, 7);
    const untrusted = await administrativeReadClient({ origin, credentialFile });
    await assert.rejects(untrusted.call('get'));
    assert.equal(seen.length, 7);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
