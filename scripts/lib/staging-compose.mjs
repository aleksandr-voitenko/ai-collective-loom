import { join } from 'node:path';
import { fail } from './staging-files.mjs';
export const caddyImage =
  'caddy:2.11.2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d';
export const services = ['api', 'search', 'notifications', 'file-text'];
export const containers = ['proxy', 'postgres', 's3', ...services];
export const volumes = ['postgres-data', 's3-data', 'proxy-data'];
export const networks = ['network', 'edge'];
export const name = (d, service) => d.id + '-' + service;
export const labels = (d) => ({
  'org.loom.vps-staging': d.owner,
  'org.loom.instance': d.id,
  'org.loom.kind': d.kind,
  ...(d.testOwner ? { 'org.loom.test-owner': d.testOwner } : {}),
});
export const labelArgs = (d) =>
  Object.entries(labels(d)).flatMap(([k, v]) => ['--label', k + '=' + v]);
export function subnet(value) {
  if (
    !/^(10\.(?:\d{1,3}\.){2}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.|192\.168\.\d{1,3}\.)0\/24$/.test(
      value,
    ) ||
    value.split(/[./]/).some((n) => Number(n) > 255)
  )
    fail('explicit private IPv4 subnet of size 24 required');
  return value.slice(0, -4);
}
export function caddyfile(d, c) {
  const host = new URL(d.origin).host;
  const refusals = [
    'Forwarded',
    'X-Forwarded-For',
    'X-Forwarded-Host',
    'X-Forwarded-Proto',
    'X-Forwarded-Port',
    'X-Real-IP',
  ]
    .map((h, i) => `  @spoof${i} header ${h} *\n  respond @spoof${i} 400`)
    .join('\n');
  return `{
  admin off
  persist_config off
  servers {\n    strict_sni_host on\n    protocols h1 h2\n  }
}
https://${host} {
${c.quarantine ? '  tls /custody/tls.pem /custody/tls.key' : ''}
  header Strict-Transport-Security "max-age=31536000"
${refusals}
  reverse_proxy api:3000 {
    header_up Host ${host}
    header_up X-Forwarded-Host ${host}
    header_up X-Forwarded-Proto https
    header_up X-Forwarded-For {remote_host}
    header_up -Forwarded
    header_up -X-Forwarded-Port
    header_up -X-Real-IP
  }
}
`;
}
export function composeSpec(d, c) {
  const prefix = subnet(c.subnet),
    address = (n) => prefix + n;
  const common = {
    read_only: true,
    restart: 'no',
    labels: labels(d),
    logging: { driver: 'local', options: { 'max-size': '1m', 'max-file': '2' } },
    security_opt: ['no-new-privileges:true'],
    stop_grace_period: '60s',
  };
  const mount = (source, target, read_only = true, type = 'bind') => ({
    type,
    source,
    target,
    read_only,
  });
  const spec = {
    name: d.id,
    services: {},
    volumes: Object.fromEntries(volumes.map((v) => [v, { external: true, name: name(d, v) }])),
    networks: Object.fromEntries(networks.map((v) => [v, { external: true, name: name(d, v) }])),
  };
  spec.services.postgres = {
    ...common,
    container_name: name(d, 'postgres'),
    image: d.release.images.postgres,
    entrypoint: ['bash', '/opt/loom/postgres.sh'],
    command: ['postgres'],
    env_file: [join(d.path, 'postgres.env')],
    tmpfs: ['/tmp', '/var/run/postgresql', '/docker-entrypoint-initdb.d'],
    stop_signal: 'SIGINT',
    volumes: [
      mount('postgres-data', '/var/lib/postgresql', false, 'volume'),
      mount(join(d.path, 'release/infra/pilot'), '/opt/loom'),
    ],
    networks: { network: { ipv4_address: address(4) } },
  };
  spec.services.s3 = {
    ...common,
    container_name: name(d, 's3'),
    image: d.release.images.seaweed,
    command: ['mini', '-dir=/data', '-s3.port=8333', '-master.telemetry=false'],
    env_file: [join(d.path, 'storage.env')],
    tmpfs: ['/tmp'],
    stop_signal: 'SIGINT',
    volumes: [mount('s3-data', '/data', false, 'volume')],
    networks: { network: { ipv4_address: address(5) } },
  };
  for (const [i, service] of services.entries())
    spec.services[service] = {
      ...common,
      container_name: name(d, service),
      image: d.release.image,
      command: ['node', 'scripts/lib/staging-runtime.mjs', service],
      volumes: [mount(join(d.path, 'runtime.json'), '/custody/runtime.json')],
      networks: { network: { ipv4_address: address(i === 0 ? 3 : i + 5) } },
    };
  spec.services.proxy = {
    ...common,
    container_name: name(d, 'proxy'),
    image: d.release.images.caddy,
    command: ['caddy', 'run', '--config', '/custody/Caddyfile', '--adapter', 'caddyfile'],
    cap_drop: ['ALL'],
    // Operator-owned 0600 binds can have a different UID on native Linux.
    // All custody binds remain read-only; the container has no other host mounts.
    cap_add: ['NET_BIND_SERVICE', 'DAC_OVERRIDE'],
    tmpfs: ['/config', '/tmp'],
    volumes: [
      mount('proxy-data', '/data', false, 'volume'),
      mount(join(d.path, 'Caddyfile'), '/custody/Caddyfile'),
      ...(c.quarantine
        ? [
            mount(join(d.path, 'tls.pem'), '/custody/tls.pem'),
            mount(join(d.path, 'tls.key'), '/custody/tls.key'),
          ]
        : []),
    ],
    ports: [
      {
        host_ip: c.quarantine ? '127.0.0.1' : '0.0.0.0',
        published: String(c.quarantine ? new URL(d.origin).port : 443),
        target: c.quarantine ? Number(new URL(d.origin).port) : 443,
        protocol: 'tcp',
      },
      ...(!c.quarantine
        ? [{ host_ip: '0.0.0.0', published: '80', target: 80, protocol: 'tcp' }]
        : []),
      ...(!c.quarantine && c.ipv6
        ? [443, 80].map((port) => ({
            host_ip: '::',
            published: String(port),
            target: port,
            protocol: 'tcp',
          }))
        : []),
    ],
    networks: { network: { ipv4_address: address(2) }, edge: {} },
  };
  return spec;
}
