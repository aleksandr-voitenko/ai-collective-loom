import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const capture = 'loom.operational_capture', observations = 'loom.operational_observations';
const hash = value => createHash('sha256').update(value).digest('hex');
function rows(table) {
  if (!table || Object.keys(table).sort().join() !== 'classification,observationRows,rows,sha256' ||
      table.classification !== 'observational-captured' || !Array.isArray(table.observationRows) ||
      table.rows !== table.observationRows.length || table.rows > 1024 ||
      hash(JSON.stringify(table.observationRows)) !== table.sha256) throw new Error('invalid inventory');
  return table.observationRows.map(({row}) => JSON.parse(row));
}
/** Permit only identified verifier samples, bounded slot replacement and 24h expiry.
 * Physical restore still compares the complete inventory before any requests run. */
export function normalizeVerifierObservations(before, after, allowed, start, end) {
  if ([capture, observations].every(key => isDeepStrictEqual(before[key], after[key]))) return after;
  try {
    const oldCapture = rows(before[capture]), newCapture = rows(after[capture]);
    if (oldCapture.length !== 1 || newCapture.length !== 1) return null;
    const prior = oldCapture[0], current = newCapture[0];
    if ([prior, current].some(r => Object.keys(r).sort().join() !== 'admitted_at,id,position' || r.id !== 1 || !Number.isSafeInteger(r.position))) return null;
    const count = current.position - prior.position;
    if (count < 1 || count > 1024 || count > allowed.size) return null;
    const oldRows = rows(before[observations]), newRows = rows(after[observations]);
    const added = newRows.filter(r => r.position > prior.position).sort((a,b) => a.position-b.position);
    if (added.length !== count || new Set(newRows.map(r=>r.slot)).size !== newRows.length || new Set(added.map(r=>r.request_id)).size !== count) return null;
    for (const [index,row] of added.entries()) {
      const expected = allowed.get(row.request_id), time = Date.parse(row.observed_at);
      if (Object.keys(row).sort().join() !== 'code,family,observed_at,position,request_id,slot,status' ||
          row.position !== prior.position + index + 1 || row.slot !== row.position % 1024 ||
          !Number.isFinite(time) || time < start || time > end ||
          !isDeepStrictEqual({code:row.code,family:row.family,status:row.status},expected)) return null;
    }
    if (Date.parse(current.admitted_at) !== Date.parse(added.at(-1).observed_at)) return null;
    const replaced = new Set(added.map(r=>r.slot));
    for (const row of oldRows) {
      if (replaced.has(row.slot)) continue;
      const next = newRows.find(r=>r.slot===row.slot);
      if (!next && Date.parse(row.observed_at) <= end-86400000) continue;
      if (!isDeepStrictEqual(row,next)) return null;
    }
    for (const row of newRows.filter(r=>r.position<=prior.position))
      if (!oldRows.some(old=>isDeepStrictEqual(old,row))) return null;
    return {...after,[capture]:before[capture],[observations]:before[observations]};
  } catch { return null; }
}
