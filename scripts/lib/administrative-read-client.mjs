import { request } from 'node:https';
import { readFile, stat } from 'node:fs/promises';

// Shared transport for the independent administrator metadata readers. Collection,
// owner and continuation admission stay with each client; this layer never retries.
export async function administrativeReadClient({ origin: value, credentialFile, caFile }) {
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username ||
      origin.password || origin.search || origin.hash) throw new Error();
  const info = await stat(credentialFile);
  if (!info.isFile() || (info.mode & 0o077) || info.size > 1024) throw new Error();
  const token = (await readFile(credentialFile, 'utf8')).trim();
  const ca = caFile === undefined ? undefined : await readFile(caFile);
  if (!/^loom_agent\.[a-f0-9-]+\.[A-Za-z0-9_-]+$/i.test(token)) throw new Error();

  function call(path, body) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const chunks = [];
      let bytes = 0;
      const req = request(new URL('/api/v1/' + path, origin), {
        ca, agent: false, method: encoded ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + token, ...(encoded ? {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded),
        } : {}) },
      }, (res) => {
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 32768) res.destroy(new Error());
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode !== 200) {
              const code = result.error?.code;
              process.stderr.write([
                'collection_changed', 'cursor_expired', 'cursor_restart', 'invalid_cursor',
                'page_budget_exceeded', 'forbidden', 'unauthenticated',
              ].includes(code) ? code + '; explicitly refresh or correct the request.\n'
                : 'HTTPS read failed; retry the same read.\n');
              throw new Error();
            }
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error()));
      req.end(encoded);
    });
  }
  return { origin, call };
}
