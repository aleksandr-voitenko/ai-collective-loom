import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from '../../scripts/lib/pilot-files.mjs';
export function expiredLeaf(parent, tls) {
  const root = join(parent, 'expired-' + randomUUID());
  mkdirSync(root, { mode: 0o700 });
  try {
    for (const [file, bytes] of [
      ['key', tls.key],
      ['ca', tls.ca],
      ['ca-key', tls.caKey],
      ['index', ''],
      ['serial', '02'],
    ])
      writeFileSync(join(root, file), bytes, { mode: 0o600 });
    run('openssl', [
      'req',
      '-new',
      '-key',
      join(root, 'key'),
      '-subj',
      '/CN=localhost',
      '-out',
      join(root, 'csr'),
    ]);
    writeFileSync(
      join(root, 'openssl.cnf'),
      `[ca]\ndefault_ca=local\n[local]\ndir=${root}\ndatabase=$dir/index\nserial=$dir/serial\nnew_certs_dir=$dir\ncertificate=$dir/ca\nprivate_key=$dir/ca-key\ndefault_md=sha256\npolicy=names\n[names]\ncommonName=supplied\n[leaf]\nsubjectAltName=DNS:localhost\n`,
      { mode: 0o600 },
    );
    run('openssl', [
      'ca',
      '-config',
      join(root, 'openssl.cnf'),
      '-batch',
      '-in',
      join(root, 'csr'),
      '-out',
      join(root, 'expired'),
      '-startdate',
      '20200101000000Z',
      '-enddate',
      '20200102000000Z',
      '-extensions',
      'leaf',
    ]);
    return { ...tls, cert: readFileSync(join(root, 'expired'), 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
