/**
 * MySQL Database Provider
 * Full MySQL support with connection pooling using mysql2
 */

import mysql, { type Pool, type PoolConnection, type RowDataPacket, type FieldPacket } from 'mysql2/promise';
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
// MySQL Provider
// ============================================================================

export class MySQLProvider extends SQLBaseProvider {
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
        throw new DatabaseConfigError('Host is required for MySQL', 'mysql');
      }
      if (!this.config.database) {
        throw new DatabaseConfigError('Database name is required for MySQL', 'mysql');
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
      this.pool = mysql.createPool(this.buildPoolConfig());

      const conn = await this.pool.getConnection();
      conn.release();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to MySQL: ${error instanceof Error ? error.message : error}`,
        'mysql',
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

  private buildPoolConfig(): mysql.PoolOptions {
    const baseConfig: mysql.PoolOptions = {
      connectionLimit: this.poolConfig.max,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    };

    if (this.config.connectionString) {
      return {
        ...baseConfig,
        uri: this.config.connectionString,
      };
    }

    return {
      ...baseConfig,
      host: this.config.host,
      port: this.config.port ?? 3306,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      ssl: this.shouldEnableSSL() ? { rejectUnauthorized: false } : undefined,
      timezone: this.options.timezone ?? 'Z',
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
          const [rows, fields] = await this.pool!.execute<RowDataPacket[]>(sql, params);
          return { rows, fields };
        } catch (error) {
          throw mapDatabaseError(error, 'mysql', sql);
        }
      });

      return {
        rows: result.rows as unknown[],
        fields: result.fields?.map((f: FieldPacket) => f.name) ?? [],
        rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      const [tablesRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          TABLE_NAME as table_name,
          TABLE_ROWS as row_count,
          DATA_LENGTH + INDEX_LENGTH as total_size
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME ASC;
      `, [this.config.database]);

      const schemas: TableSchema[] = [];

      for (const row of tablesRows) {
        const tableName = row.table_name;
        const rowCount = parseInt(row.row_count || '0');
        const sizeBytes = parseInt(row.total_size || '0');

        const [columnsRows] = await conn.execute<RowDataPacket[]>(`
          SELECT
            COLUMN_NAME as column_name,
            DATA_TYPE as data_type,
            IS_NULLABLE as is_nullable,
            COLUMN_DEFAULT as column_default,
            COLUMN_KEY as column_key
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION
          LIMIT 100;
        `, [this.config.database, tableName]);

        const [fkRows] = await conn.execute<RowDataPacket[]>(`
          SELECT
            COLUMN_NAME as column_name,
            REFERENCED_TABLE_NAME as referenced_table,
            REFERENCED_COLUMN_NAME as referenced_column
          FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL;
        `, [this.config.database, tableName]);

        const [indexRows] = await conn.execute<RowDataPacket[]>(`
          SELECT
            INDEX_NAME as index_name,
            GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns,
            NOT NON_UNIQUE as is_unique
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          GROUP BY INDEX_NAME, NON_UNIQUE;
        `, [this.config.database, tableName]);

        schemas.push({
          name: tableName,
          rowCount,
          size: formatBytes(sizeBytes),
          columns: columnsRows.map((col) => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === 'YES',
            isPrimary: col.column_key === 'PRI',
            defaultValue: col.column_default ?? undefined,
          })),
          indexes: indexRows.map((idx) => ({
            name: idx.index_name,
            columns: idx.columns?.split(',') ?? [],
            unique: Boolean(idx.is_unique),
          })),
          foreignKeys: fkRows.map((fk) => ({
            columnName: fk.column_name,
            referencedTable: fk.referenced_table,
            referencedColumn: fk.referenced_column,
          })),
        });
      }

      return schemas;
    } finally {
      conn.release();
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      const [connRows] = await conn.execute<RowDataPacket[]>(
        "SHOW STATUS LIKE 'Threads_connected'"
      );
      const activeConnections = parseInt(connRows[0]?.Value || '0');

      const [sizeRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) as size_mb
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?;
      `, [this.config.database]);
      const databaseSize = `${sizeRows[0]?.size_mb || 0} MB`;

      const [hitRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          (1 - (
            (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') /
            NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'), 0)
          )) * 100 as hit_ratio;
      `);
      const cacheHitRatio = `${(hitRows[0]?.hit_ratio || 99).toFixed(1)}%`;

      let slowQueries: SlowQuery[] = [];
      try {
        const [slowRows] = await conn.execute<RowDataPacket[]>(`
          SELECT
            LEFT(sql_text, 100) as query,
            count_star as calls,
            CONCAT(ROUND(avg_timer_wait / 1000000000, 2), 'ms') as avgTime
          FROM performance_schema.events_statements_summary_by_digest
          WHERE schema_name = ?
          ORDER BY sum_timer_wait DESC
          LIMIT 5;
        `, [this.config.database]);
        slowQueries = slowRows.map((r) => ({
          query: r.query || '',
          calls: parseInt(r.calls || '0'),
          avgTime: r.avgTime || 'N/A',
        }));
      } catch {
        slowQueries = [{ query: 'Performance schema not available', calls: 0, avgTime: 'N/A' }];
      }

      const [sessionRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          ID as pid,
          USER as user,
          DB as \`database\`,
          COMMAND as state,
          LEFT(COALESCE(INFO, ''), 100) as query,
          CONCAT(TIME, 's') as duration
        FROM information_schema.PROCESSLIST
        WHERE DB = ?
        ORDER BY TIME DESC
        LIMIT 10;
      `, [this.config.database]);

      const activeSessions: ActiveSession[] = sessionRows.map((r) => ({
        pid: r.pid,
        user: r.user || 'unknown',
        database: r.database || '',
        state: r.state || 'unknown',
        query: r.query || '',
        duration: r.duration || 'N/A',
      }));

      return {
        activeConnections,
        databaseSize,
        cacheHitRatio,
        slowQueries,
        activeSessions,
      };
    } finally {
      conn.release();
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
      const conn = await this.pool!.getConnection();
      try {
        let sql = '';

        switch (type) {
          case 'analyze':
            sql = target
              ? `ANALYZE TABLE ${this.escapeIdentifier(target)}`
              : `ANALYZE TABLE ${await this.getAllTablesForMaintenance(conn)}`;
            break;
          case 'optimize':
            sql = target
              ? `OPTIMIZE TABLE ${this.escapeIdentifier(target)}`
              : `OPTIMIZE TABLE ${await this.getAllTablesForMaintenance(conn)}`;
            break;
          case 'check':
            sql = target
              ? `CHECK TABLE ${this.escapeIdentifier(target)}`
              : `CHECK TABLE ${await this.getAllTablesForMaintenance(conn)}`;
            break;
          case 'kill':
            if (!target) {
              throw new QueryError('Target connection ID is required for kill operation', 'mysql');
            }
            const connId = parseInt(target, 10);
            if (isNaN(connId)) {
              throw new QueryError('Invalid connection ID for kill operation', 'mysql');
            }
            sql = `KILL ${connId}`;
            break;
          default:
            throw new QueryError(`Unsupported maintenance type for MySQL: ${type}`, 'mysql');
        }

        await conn.execute(sql);
        return { success: true };
      } finally {
        conn.release();
      }
    });

    return {
      success: result.success,
      executionTime,
      message: `${type.toUpperCase()} completed successfully`,
    };
  }

  private async getAllTablesForMaintenance(conn: PoolConnection): Promise<string> {
    const [rows] = await conn.execute<RowDataPacket[]>(`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'BASE TABLE'
      LIMIT 50;
    `, [this.config.database]);

    return rows.map((r) => this.escapeIdentifier(r.TABLE_NAME)).join(', ');
  }
}
