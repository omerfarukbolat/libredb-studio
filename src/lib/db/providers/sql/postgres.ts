/**
 * PostgreSQL Database Provider
 * Full PostgreSQL support with connection pooling
 */

import { Pool, type PoolConfig as PgPoolConfig } from 'pg';
import { SQLBaseProvider } from './sql-base';
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type SlowQuery,
  type ActiveSession,
} from '../../types';
import {
  DatabaseConfigError,
  ConnectionError,
  QueryError,
  mapDatabaseError,
} from '../../errors';
import { formatBytes } from '../../utils/pool-manager';

// ============================================================================
// PostgreSQL Provider
// ============================================================================

export class PostgresProvider extends SQLBaseProvider {
  private pool: Pool | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError('Host is required for PostgreSQL', 'postgres');
      }
      if (!this.config.database) {
        throw new DatabaseConfigError('Database name is required for PostgreSQL', 'postgres');
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      const poolConfig = this.buildPoolConfig();
      this.pool = new Pool(poolConfig);

      const client = await this.pool.connect();
      client.release();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : error}`,
        'postgres',
        this.config.host,
        this.config.port
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.setConnected(false);
    }
  }

  private buildPoolConfig(): PgPoolConfig {
    const needsSSL = this.shouldEnableSSL();

    const sslConfig = needsSSL
      ? { rejectUnauthorized: false }
      : this.options.ssl === false
        ? false
        : undefined;

    const baseConfig: PgPoolConfig = {
      min: this.poolConfig.min,
      max: this.poolConfig.max,
      idleTimeoutMillis: this.poolConfig.idleTimeout,
      connectionTimeoutMillis: this.poolConfig.acquireTimeout,
      statement_timeout: this.queryTimeout,
      ssl: sslConfig,
    };

    if (this.config.connectionString) {
      return {
        ...baseConfig,
        connectionString: this.config.connectionString,
      };
    }

    return {
      ...baseConfig,
      host: this.config.host,
      port: this.config.port ?? 5432,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
    };
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const client = await this.pool!.connect();
          try {
            const res = await client.query(sql, params);
            return res;
          } finally {
            client.release();
          }
        } catch (error) {
          throw mapDatabaseError(error, 'postgres', sql);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields?.map((f) => f.name) ?? [],
        rowCount: result.rowCount ?? 0,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      const tablesRes = await client.query(`
        SELECT
          t.table_name,
          COALESCE(c.reltuples::bigint, 0) as row_count,
          COALESCE(pg_total_relation_size(c.oid), 0) as total_size
        FROM information_schema.tables t
        LEFT JOIN pg_class c ON c.oid = (quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass
        WHERE t.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name ASC;
      `);

      const schemas: TableSchema[] = [];

      for (const row of tablesRes.rows) {
        const tableName = row.table_name;
        const rowCount = Math.max(0, parseInt(row.row_count || '0'));
        const sizeBytes = parseInt(row.total_size || '0');

        const columnsRes = await client.query(
          `
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_name = $1
          AND table_schema = 'public'
          ORDER BY ordinal_position
          LIMIT 100;
        `,
          [tableName]
        );

        const pkRes = await client.query(
          `
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_name = $1
            AND tc.table_schema = 'public';
        `,
          [tableName]
        );

        const pkColumns = pkRes.rows.map((r) => r.column_name);

        const fkRes = await client.query(
          `
          SELECT
            kcu.column_name,
            ccu.table_name AS referenced_table,
            ccu.column_name AS referenced_column
          FROM
            information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage AS ccu
              ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1;
        `,
          [tableName]
        );

        const indexRes = await client.query(
          `
          SELECT
            i.relname as index_name,
            array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns,
            ix.indisunique as is_unique
          FROM pg_index ix
          JOIN pg_class t ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
          WHERE t.relname = $1
          AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
          GROUP BY i.relname, ix.indisunique;
        `,
          [tableName]
        );

        schemas.push({
          name: tableName,
          rowCount,
          size: formatBytes(sizeBytes),
          columns: columnsRes.rows.map((col) => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === 'YES',
            isPrimary: pkColumns.includes(col.column_name),
            defaultValue: col.column_default ?? undefined,
          })),
          indexes: indexRes.rows.map((idx) => ({
            name: idx.index_name,
            columns: Array.isArray(idx.columns) ? idx.columns : [],
            unique: idx.is_unique,
          })),
          foreignKeys: fkRes.rows.map((fk) => ({
            columnName: fk.column_name,
            referencedTable: fk.referenced_table,
            referencedColumn: fk.referenced_column,
          })),
        });
      }

      return schemas;
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      const connRes = await client.query('SELECT count(*) FROM pg_stat_activity');

      const sizeRes = await client.query('SELECT pg_size_pretty(pg_database_size($1))', [
        this.config.database,
      ]);

      const cacheRes = await client.query(`
        SELECT
          sum(heap_blks_read) as heap_read,
          sum(heap_blks_hit)  as heap_hit,
          COALESCE(
            ROUND((sum(heap_blks_hit) * 100.0 / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0)), 1),
            100
          ) as ratio
        FROM pg_statio_user_tables;
      `);

      let slowQueries: SlowQuery[] = [];
      try {
        const slowRes = await client.query(`
          SELECT
            LEFT(query, 100) as query,
            calls,
            ROUND((mean_exec_time)::numeric, 2)::text || 'ms' as avgTime
          FROM pg_stat_statements
          WHERE calls > 0
          ORDER BY total_exec_time DESC
          LIMIT 5;
        `);
        slowQueries = slowRes.rows.map((r) => ({
          query: r.query,
          calls: r.calls,
          avgTime: r.avgtime,
        }));
      } catch {
        slowQueries = [
          { query: 'pg_stat_statements extension not enabled', calls: 0, avgTime: 'N/A' },
        ];
      }

      const sessionsRes = await client.query(`
        SELECT
          pid,
          usename as user,
          datname as database,
          COALESCE(state, 'unknown') as state,
          LEFT(COALESCE(query, ''), 100) as query,
          CASE
            WHEN xact_start IS NOT NULL THEN
              EXTRACT(EPOCH FROM (NOW() - xact_start))::text || 's'
            ELSE 'N/A'
          END as duration
        FROM pg_stat_activity
        WHERE datname = $1
        AND pid != pg_backend_pid()
        ORDER BY xact_start DESC NULLS LAST
        LIMIT 10;
      `, [this.config.database]);

      const activeSessions: ActiveSession[] = sessionsRes.rows.map((r) => ({
        pid: r.pid,
        user: r.user || 'unknown',
        database: r.database || '',
        state: r.state,
        query: r.query || '',
        duration: r.duration,
      }));

      return {
        activeConnections: parseInt(connRes.rows[0].count),
        databaseSize: sizeRes.rows[0].pg_size_pretty,
        cacheHitRatio: `${cacheRes.rows[0].ratio}%`,
        slowQueries,
        activeSessions,
      };
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(
    type: MaintenanceType,
    target?: string
  ): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      const client = await this.pool!.connect();
      try {
        let sql = '';

        switch (type) {
          case 'vacuum':
            sql = target
              ? `VACUUM ANALYZE public.${this.escapeIdentifier(target)}`
              : 'VACUUM ANALYZE';
            break;
          case 'analyze':
            sql = target
              ? `ANALYZE public.${this.escapeIdentifier(target)}`
              : 'ANALYZE';
            break;
          case 'reindex':
            sql = target
              ? `REINDEX TABLE public.${this.escapeIdentifier(target)}`
              : `REINDEX DATABASE ${this.escapeIdentifier(this.config.database || '')}`;
            break;
          case 'kill':
            if (!target) {
              throw new QueryError('Target PID is required for kill operation', 'postgres');
            }
            const pid = parseInt(target, 10);
            if (isNaN(pid)) {
              throw new QueryError('Invalid PID for kill operation', 'postgres');
            }
            sql = `SELECT pg_terminate_backend(${pid})`;
            break;
          default:
            throw new QueryError(`Unsupported maintenance type: ${type}`, 'postgres');
        }

        await client.query(sql);
        return { success: true };
      } finally {
        client.release();
      }
    });

    return {
      success: result.success,
      executionTime,
      message: `${type.toUpperCase()} completed successfully`,
    };
  }

  // ============================================================================
  // Pool Statistics
  // ============================================================================

  public getPoolStats() {
    if (!this.pool) {
      return { total: 0, idle: 0, active: 0, waiting: 0 };
    }

    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      active: this.pool.totalCount - this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }
}
