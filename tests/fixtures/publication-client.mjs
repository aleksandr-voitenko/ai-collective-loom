// Private process fixture exercising the compiled release. No production entrypoint
// or route imports it; trusted fixture identities are unrelated to real credentials.
import { PostgresDatabase } from '../../dist/server/db/postgres.js';
import { readConfiguration } from '../../dist/server/config.js';
import { actorFromVerifiedIdentity } from '../../dist/server/modules/publication/actor.js';
import { PublicationOperation } from '../../dist/server/modules/publication/publication.js';

const database = new PostgresDatabase(readConfiguration().database);
process.once('message', async message => {
  try {
    const committed = await new PublicationOperation(database).publish(actorFromVerifiedIdentity(message), message.input);
    process.send?.({ stage: 'committed_before_response' });
    // Keep the response behind a separate controlled barrier. The test kills this
    // process after persisted commit and before any logical result reaches it.
    process.once('message', async () => { process.send?.(committed); await database.close(); process.disconnect(); });
  } catch { process.send?.({ stage: 'failed' }); await database.close(); process.exitCode = 1; process.disconnect(); }
});
