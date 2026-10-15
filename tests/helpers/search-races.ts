import type pg from 'pg';

export function barrier<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}

export async function bounded<T>(promise: Promise<T>, milliseconds = 10000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Search fixture barrier deadline exceeded.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Observe the actual database lock dependency, never infer a race from a delay. */
export async function blockedBy(observer: pg.Client, waiter: number, holder: number) {
  const deadline = Date.now() + 5000;
  while (!(await observer.query<{ blocked: boolean }>(
    'SELECT $2::integer = ANY(pg_blocking_pids($1)) AS blocked', [waiter, holder],
  )).rows[0]!.blocked) {
    if (Date.now() >= deadline) throw new Error('Expected search fixture lock dependency was not observed.');
  }
}
