export class ConfigurationError extends Error {}

export interface DatabaseConfiguration {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}
export interface ApplicationConfiguration {
  host: string;
  port: number;
  database: DatabaseConfiguration;
}

function port(value: string | undefined, fallback: number, key: string, minimum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > 65535) {
    throw new ConfigurationError(`Invalid ${key}.`);
  }
  return Number(value);
}

export function readConfiguration(env: NodeJS.ProcessEnv = process.env): ApplicationConfiguration {
  const host = env.LOOM_API_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host))
    throw new ConfigurationError('Invalid LOOM_API_HOST.');
  const databaseHost = env.LOOM_DATABASE_HOST ?? '127.0.0.1';
  if (!/^[a-zA-Z0-9._:-]+$/.test(databaseHost))
    throw new ConfigurationError('Invalid LOOM_DATABASE_HOST.');
  const database = env.LOOM_DATABASE_NAME ?? 'loom_dev';
  const user = env.LOOM_DATABASE_USER ?? 'loom_app';
  for (const [key, value] of [
    ['LOOM_DATABASE_NAME', database],
    ['LOOM_DATABASE_USER', user],
  ]) {
    if (!value || !/^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/.test(value))
      throw new ConfigurationError(`Invalid ${key}.`);
  }
  const password = env.LOOM_PG_APP_PASSWORD;
  if (!password) throw new ConfigurationError('Missing LOOM_PG_APP_PASSWORD.');
  return {
    host,
    port: port(env.LOOM_API_PORT, 3000, 'LOOM_API_PORT', 0),
    database: {
      host: databaseHost,
      port: port(env.LOOM_POSTGRES_PORT, 54320, 'LOOM_POSTGRES_PORT', 1),
      database,
      user,
      password,
    },
  };
}

export function readMode(args: string[]): 'api' | 'web' {
  if (!args.length) return 'web';
  if (args.length === 2 && args[0] === '--mode' && (args[1] === 'api' || args[1] === 'web'))
    return args[1];
  throw new ConfigurationError('Use --mode api or --mode web.');
}
