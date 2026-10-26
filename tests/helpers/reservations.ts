import type {fixture} from './moderation.js';
/** Includes every old subsystem, including file-text queues/projections; request accounting changes on reads. */
export async function reservationSnapshot(f:Awaited<ReturnType<typeof fixture>>){
  const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' AND tablename <> 'participation_rate_windows' ORDER BY tablename")).rows;
  const result:Record<string,unknown>={};
  for(const {tablename} of tables)result[tablename]=(await f.observer.query(`SELECT row_to_json(t)::text AS row FROM loom."${tablename}" t ORDER BY 1`)).rows;
  return result;
}
