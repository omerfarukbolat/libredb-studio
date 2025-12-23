/**
 * SQLite Database Provider
 * File-based SQLite support - Uses bun:sqlite when available
 *
 * Note: SQLite is primarily for local development. Cloud deployments
 * typically use PostgreSQL or MySQL instead.
 */

import { SQLBaseProvider } from './sql-base';
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
} from '../../types';
import {
  DatabaseConfigError,
  ConnectionError,
  QueryError,
  mapDatabaseError,
} from '../../errors';
import { formatBytes } from '../../utils/pool-manager';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Dynamic SQLite Import (for Bun runtime compatibility)
// ============================================================================

type SQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number };
  };
  close(): void;
};

type SQLiteConstructor = new (path: string, options?: { create?: boolean; readwrite?: boolean }) => SQLiteDatabase;

let Database: SQLiteConstructor | null = null;
let sqliteLoadError: Error | null = null;

// Try to load bun:sqlite at runtime
async function loadSQLite(): Promise<SQLiteConstructor> {
  if (Database) return Database;
  if (sqliteLoadError) throw sqliteLoadError;

  try {
    // Dynamic import for bun:sqlite
    const sqlite = await import('bun:sqlite');
    Database = sqlite.Database as unknown as SQLiteConstructor;
    return Database;
  } catch (error) {
    sqliteLoadError = new DatabaseConfigError(
      'SQLite is not available in this environment. SQLite requires Bun runtime. For cloud deployments, use PostgreSQL or MySQL instead.',
      'sqlite'
    );
    throw sqliteLoadError;
  }
}

// ============================================================================
// SQLite Provider
// ============================================================================

export class SQLiteProvider extends SQLBaseProvider {
  private db: SQLiteDatabase | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.database && !this.config.connectionString) {
      throw new DatabaseConfigError(
        'Database file path is required for SQLite (use "database" field or ":memory:" for in-memory)',
        'sqlite'
      );
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.db) {
      return;
    }

    try {
      // Dynamically load SQLite
      const SQLiteDB = await loadSQLite();

      const dbPath = this.getDatabasePath();

      if (dbPath !== ':memory:') {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      this.db = new SQLiteDB(dbPath, {
        create: true,
        readwrite: true,
      });

      // Enable WAL mode and foreign keys
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));

      if (error instanceof DatabaseConfigError) {
        throw error;
      }

      throw new ConnectionError(
        `Failed to open SQLite database: ${error instanceof Error ? error.message : error}`,
        'sqlite'
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.setConnected(false);
    }
  }

  private getDatabasePath(): string {
    if (this.config.connectionString) {
      if (this.config.connectionString.startsWith('file:')) {
        return this.config.connectionString.replace('file:', '');
      }
      return this.config.connectionString;
    }
    return this.config.database || ':memory:';
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const isSelect = this.isReadOnlyQuery(sql);

          if (isSelect) {
            const stmt = this.db!.prepare(sql);
            const rows = params ? stmt.all(...params) : stmt.all();
            const fields = rows.length > 0 ? Object.keys(rows[0] as object) : [];
            return {
              rows: rows as unknown[],
              fields,
              changes: 0,
            };
          } else {
            const stmt = this.db!.prepare(sql);
            const info = params ? stmt.run(...params) : stmt.run();
            return {
              rows: [],
              fields: [],
              changes: info.changes,
            };
          }
        } catch (error) {
          throw mapDatabaseError(error, 'sqlite', sql);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields,
        rowCount: result.rows.length || result.changes,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const tablesStmt = this.db!.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      ORDER BY name;
    `);
    const tables = tablesStmt.all() as { name: string }[];

    const schemas: TableSchema[] = [];

    for (const { name: tableName } of tables) {
      const countStmt = this.db!.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`);
      const countResult = countStmt.get() as { count: number };
      const rowCount = countResult?.count || 0;

      const columnsStmt = this.db!.prepare(`PRAGMA table_info("${tableName}")`);
      const columns = columnsStmt.all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      const fkStmt = this.db!.prepare(`PRAGMA foreign_key_list("${tableName}")`);
      const foreignKeys = fkStmt.all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
      }>;

      const indexStmt = this.db!.prepare(`PRAGMA index_list("${tableName}")`);
      const indexList = indexStmt.all() as Array<{
        seq: number;
        name: string;
        unique: number;
      }>;

      const indexes = [];
      for (const idx of indexList) {
        if (idx.name.startsWith('sqlite_')) continue;

        const indexInfoStmt = this.db!.prepare(`PRAGMA index_info("${idx.name}")`);
        const indexCols = indexInfoStmt.all() as Array<{ seqno: number; cid: number; name: string }>;

        indexes.push({
          name: idx.name,
          columns: indexCols.map((c) => c.name),
          unique: idx.unique === 1,
        });
      }

      let sizeBytes = 0;
      try {
        const pageCountStmt = this.db!.prepare(`
          SELECT (SELECT page_count FROM pragma_page_count()) *
                 (SELECT page_size FROM pragma_page_size()) as size
        `);
        const sizeResult = pageCountStmt.get() as { size: number };
        sizeBytes = sizeResult?.size || 0;
      } catch {
        // Ignore size calculation errors
      }

      schemas.push({
        name: tableName,
        rowCount,
        size: formatBytes(sizeBytes),
        columns: columns.map((col) => ({
          name: col.name,
          type: col.type || 'TEXT',
          nullable: col.notnull === 0,
          isPrimary: col.pk === 1,
          defaultValue: col.dflt_value ?? undefined,
        })),
        indexes,
        foreignKeys: foreignKeys.map((fk) => ({
          columnName: fk.from,
          referencedTable: fk.table,
          referencedColumn: fk.to,
        })),
      });
    }

    return schemas;
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const dbPath = this.getDatabasePath();

    let databaseSize = 'N/A';
    if (dbPath !== ':memory:') {
      try {
        const stats = fs.statSync(dbPath);
        databaseSize = formatBytes(stats.size);
      } catch {
        databaseSize = 'Unknown';
      }
    } else {
      try {
        const sizeStmt = this.db!.prepare(`
          SELECT (page_count * page_size) as size
          FROM pragma_page_count(), pragma_page_size()
        `);
        const result = sizeStmt.get() as { size: number };
        databaseSize = formatBytes(result?.size || 0);
      } catch {
        databaseSize = 'N/A';
      }
    }

    let isHealthy = true;
    try {
      const integrityStmt = this.db!.prepare('PRAGMA integrity_check');
      const integrityResult = integrityStmt.get() as { integrity_check: string };
      isHealthy = integrityResult?.integrity_check === 'ok';
    } catch {
      isHealthy = false;
    }

    let journalMode = 'unknown';
    try {
      const journalStmt = this.db!.prepare('PRAGMA journal_mode');
      const journalResult = journalStmt.get() as { journal_mode: string };
      journalMode = journalResult?.journal_mode || 'unknown';
    } catch {
      // Ignore
    }

    return {
      activeConnections: 1,
      databaseSize,
      cacheHitRatio: 'N/A',
      slowQueries: [
        {
          query: `Integrity: ${isHealthy ? 'OK' : 'FAILED'}`,
          calls: 0,
          avgTime: 'N/A',
        },
        {
          query: `Journal Mode: ${journalMode}`,
          calls: 0,
          avgTime: 'N/A',
        },
      ],
      activeSessions: [
        {
          pid: process.pid,
          user: 'sqlite',
          database: path.basename(dbPath),
          state: 'active',
          query: '',
          duration: 'N/A',
        },
      ],
    };
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
      let sql = '';

      switch (type) {
        case 'vacuum':
          sql = 'VACUUM';
          break;
        case 'analyze':
          sql = target ? `ANALYZE "${target}"` : 'ANALYZE';
          break;
        case 'reindex':
          sql = target ? `REINDEX "${target}"` : 'REINDEX';
          break;
        case 'check':
          const checkStmt = this.db!.prepare('PRAGMA integrity_check');
          const checkResult = checkStmt.get() as { integrity_check: string };
          return {
            success: checkResult?.integrity_check === 'ok',
            message: checkResult?.integrity_check || 'Unknown',
          };
        default:
          throw new QueryError(`Unsupported maintenance type for SQLite: ${type}`, 'sqlite');
      }

      this.db!.exec(sql);
      return { success: true, message: `${type.toUpperCase()} completed successfully` };
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }
}
