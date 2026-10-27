// Complete native recovery inventory shared by explicitly owned controllers.
import { createHash } from 'node:crypto';
import {
  GetBucketVersioningCommand,
  ListObjectVersionsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const derived = new Set([
  'search_state',
  'search_jobs',
  'search_documents',
  'file_text_state',
  'file_text_jobs',
  'file_text_documents',
  'notification_jobs',
  'notification_projection_heads',
  'notification_gaps',
]);

export async function nativeInventory(db, s3, storageConfig, phase = () => {}) {
  phase('inventory-database');
  await db.connect();
  const tables = {};
  // Every non-system table is included, including migration history and private/key tables.
  const names = (
    await db.query(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2",
    )
  ).rows;
  for (const { schemaname, tablename } of names) {
    const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
    const rows = (
      await db.query(
        `SELECT row_to_json(t)::text AS row FROM ${quote(schemaname)}.${quote(tablename)} t ORDER BY 1`,
      )
    ).rows;
    tables[schemaname + '.' + tablename] = {
      rows: rows.length,
      sha256: hash(JSON.stringify(rows)),
      classification: derived.has(tablename)
        ? 'rebuildable-derived-captured'
        : 'authoritative-captured',
    };
    if (
      schemaname === 'loom' &&
      ['operational_capture', 'operational_observations'].includes(tablename)
    ) {
      tables[schemaname + '.' + tablename].classification = 'observational-captured';
      tables[schemaname + '.' + tablename].observationRows = rows;
    }
    if (schemaname === 'loom' && tablename === 'participation_rate_windows') {
      // Capture all counters exactly. Application verification may subsequently
      // charge its own reads; publication allowance must remain byte-identical.
      tables[schemaname + '.' + tablename].publicationSha256 = hash(
        JSON.stringify(
          rows.filter(({ row }) => JSON.parse(row).category === 'new_publications'),
        ),
      );
      tables[schemaname + '.' + tablename].requestWindows = rows
        .map(({ row }) => JSON.parse(row))
        .filter((row) => row.category !== 'new_publications');
    }
    if (schemaname === 'loom' && tablename === 'notification_state') {
      const progress = [
        'source_after',
        'revision_after',
        'scan_complete',
        'event_after',
        'event_after_intent',
        'heartbeat_at',
        'capacity_limited',
        'discovery_generation',
      ];
      const authoritative = rows.map(({ row }) =>
        Object.fromEntries(
          Object.entries(JSON.parse(row)).filter(([key]) => !progress.includes(key)),
        ),
      );
      tables[schemaname + '.' + tablename].classification = 'mixed-captured';
      tables[schemaname + '.' + tablename].authoritativeSha256 = hash(
        JSON.stringify(authoritative),
      );
    }
  }
  const buckets = {};
  phase('inventory-native-versions');
  for (const Bucket of [storageConfig.stagingBucket, storageConfig.finalBucket]) {
    if ((await s3.send(new GetBucketVersioningCommand({ Bucket }))).Status !== 'Enabled')
      throw new Error('versioning');
    const versions = [];
    let KeyMarker, VersionIdMarker;
    do {
      const page = await s3.send(
        new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker }),
      );
      for (const v of page.Versions ?? []) {
        const object = await s3.send(
          new GetObjectCommand({ Bucket, Key: v.Key, VersionId: v.VersionId }),
        );
        const bytes = await object.Body.transformToByteArray();
        versions.push({
          key: v.Key,
          version: v.VersionId,
          size: bytes.length,
          sha256: hash(bytes),
        });
      }
      for (const v of page.DeleteMarkers ?? [])
        versions.push({ key: v.Key, version: v.VersionId, deleted: true });
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      VersionIdMarker = page.NextVersionIdMarker;
      if (page.IsTruncated && !KeyMarker) throw new Error('pagination');
    } while (KeyMarker);
    buckets[Bucket] = {
      versioning: 'Enabled',
      versions: versions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
  }
  const required = (
    await db.query(
      'SELECT DISTINCT u.id,u.size,u.sha256,u.final_version FROM loom.file_contexts f JOIN loom.file_uploads u ON u.id=f.upload_id ORDER BY u.id',
    )
  ).rows;
  phase('inventory-required-versions');
  for (const u of required) {
    const v = buckets[storageConfig.finalBucket].versions.find(
      (v) => v.key === 'artifact-files-v1/' + u.id && v.version === u.final_version,
    );
    if (!v || v.size !== u.size || v.sha256 !== u.sha256)
      throw new Error('required exact native version');
  }
  const migrations = (
    await db.query(
      'SELECT version,filename,sha256 FROM loom_migrations.history ORDER BY version',
    )
  ).rows;
  phase('inventory-history');
  const instance = (
    await db.query('SELECT instance_id FROM loom.community_settings WHERE id=1')
  ).rows[0]?.instance_id;
  await db.end();
  s3.destroy();
  return { tables, buckets, migrations, instance, requiredVersions: required.length };
}
