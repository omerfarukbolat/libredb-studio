/**
 * Database Provider Types & Interfaces
 * Strategy Pattern implementation for multi-database support
 */

// Re-export common types from main types file
export type {
  DatabaseType,
  DatabaseConnection,
  TableSchema,
  ColumnSchema,
  IndexSchema,
  ForeignKeySchema,
  QueryResult,
} from '../types';

import type {
  DatabaseType,
  DatabaseConnection,
  TableSchema,
  QueryResult,
} from '../types';

// ============================================================================
// Pool Configuration
// ============================================================================

export interface PoolConfig {
  /** Minimum number of connections in pool (default: 2) */
  min: number;
  /** Maximum number of connections in pool (default: 10) */
  max: number;
  /** Close idle connections after this time in ms (default: 30000) */
  idleTimeout: number;
  /** Wait for connection timeout in ms (default: 60000) */
  acquireTimeout: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 2,
  max: 10,
  idleTimeout: 30000,
  acquireTimeout: 60000,
};

/** Query timeout in milliseconds (default: 60 seconds) */
export const DEFAULT_QUERY_TIMEOUT = 60000;

// ============================================================================
// Health Information
// ============================================================================

export interface SlowQuery {
  query: string;
  calls: number;
  avgTime: string;
}

export interface ActiveSession {
  pid: number | string;
  user: string;
  database: string;
  state: string;
  query: string;
  duration: string;
}

export interface HealthInfo {
  activeConnections: number;
  databaseSize: string;
  cacheHitRatio: string;
  slowQueries: SlowQuery[];
  activeSessions: ActiveSession[];
}

// ============================================================================
// Maintenance Operations
// ============================================================================

export type MaintenanceType = 'vacuum' | 'analyze' | 'reindex' | 'kill' | 'optimize' | 'check';

export interface MaintenanceResult {
  success: boolean;
  executionTime: number;
  message: string;
}

// ============================================================================
// Provider Interface (Strategy Pattern)
// ============================================================================

export interface DatabaseProvider {
  /** Database type identifier */
  readonly type: DatabaseType;

  /** Connection configuration */
  readonly config: DatabaseConnection;

  /**
   * Initialize connection pool or single connection
   */
  connect(): Promise<void>;

  /**
   * Close all connections and cleanup resources
   */
  disconnect(): Promise<void>;

  /**
   * Check if provider is currently connected
   */
  isConnected(): boolean;

  /**
   * Execute a SQL query
   * @param sql - SQL query string
   * @param params - Optional query parameters for prepared statements
   * @returns Query result with rows, fields, and execution time
   */
  query(sql: string, params?: unknown[]): Promise<QueryResult>;

  /**
   * Get full database schema
   * @returns Array of table schemas with columns, indexes, and foreign keys
   */
  getSchema(): Promise<TableSchema[]>;

  /**
   * Get list of table names
   */
  getTables(): Promise<string[]>;

  /**
   * Get health and performance metrics
   */
  getHealth(): Promise<HealthInfo>;

  /**
   * Run maintenance operations
   * @param type - Type of maintenance operation
   * @param target - Optional target (table name or process ID)
   */
  runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult>;

  /**
   * Validate provider configuration
   * @throws DatabaseConfigError if configuration is invalid
   */
  validate(): void;
}

// ============================================================================
// Provider Configuration Options
// ============================================================================

export interface ProviderOptions {
  /** Connection pool configuration */
  pool?: Partial<PoolConfig>;
  /** Query timeout in milliseconds */
  queryTimeout?: number;
  /** Enable SSL/TLS connection */
  ssl?: boolean | { rejectUnauthorized: boolean };
  /** Connection timezone */
  timezone?: string;
}

// ============================================================================
// Internal Types
// ============================================================================

export interface ConnectionState {
  connected: boolean;
  lastConnected?: Date;
  lastError?: Error;
  activeQueries: number;
}
