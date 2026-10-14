import pg, { type QueryResult, type QueryResultRow } from "pg";
import type { DatabaseConfiguration } from "../config.js";

export interface DatabaseHealth {
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
export interface SqlTransaction {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, parameters: readonly unknown[]): Promise<QueryResult<Row>>;
}

export class PostgresDatabase implements DatabaseHealth {
  readonly #pool: pg.Pool;
  #closing: Promise<void> | undefined;

  constructor(configuration: DatabaseConfiguration, reportPoolError: () => void = () => {
    process.stderr.write('{"event":"database_pool_error"}\n');
  }) {
    this.#pool = new pg.Pool({
      ...configuration, max: 10, connectionTimeoutMillis: 2000,
      statement_timeout: 3000, query_timeout: 4000,
    });
    // Idle connection failures must be observed without printing credentials/SQL.
    this.#pool.on("error", reportPoolError);
  }

  async isReady(): Promise<boolean> {
    if (this.#closing) return false;
    try {
      const result = await this.#pool.query<{ ready: boolean }>(`
SELECT NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
  AND has_schema_privilege(current_user, $1::text, 'USAGE')
  AND NOT has_schema_privilege(current_user, $1::text, 'CREATE')
  AND NOT has_schema_privilege(current_user, $2::text, 'USAGE') AS ready
FROM pg_roles AS r WHERE r.rolname = current_user;
`, ["loom", "loom_migrations"]);
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  /** Internal repository boundary: controlled SQL, explicit values, no automatic retries. */
  async transaction<T>(operation: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let active = true;
    let discard = false;
    let connectionFailure: Error | undefined;
    const observeConnectionFailure = (error: Error) => { connectionFailure ??= error; discard = true; };
    // Pool error handlers cover idle pooled clients, not a checked-out client
    // between queries. Its transaction owner must observe fatal socket errors.
    client.on("error", observeConnectionFailure);
    const transaction: SqlTransaction = {
      query: async <Row extends QueryResultRow>(text: string, parameters: readonly unknown[]) => {
        if (!active) throw new Error("Transaction connection is no longer available.");
        if (connectionFailure) throw connectionFailure;
        return client.query<Row>(text, [...parameters]);
      },
    };
    try {
      await client.query("BEGIN");
      const result = await operation(transaction);
      active = false;
      if (connectionFailure) throw connectionFailure;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      active = false;
      if (!connectionFailure) {
        try { await client.query("ROLLBACK"); }
        catch { discard = true; }
      }
      // A failed COMMIT can have an unknown outcome even if ROLLBACK responds.
      throw error;
    } finally {
      active = false;
      client.release(discard);
      client.removeListener("error", observeConnectionFailure);
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#pool.end();
    return this.#closing;
  }
}
