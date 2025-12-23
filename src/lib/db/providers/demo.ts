/**
 * Demo Database Provider
 * Mock provider for demonstration and testing purposes
 */

import { BaseDatabaseProvider } from '../base-provider';
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
} from '../types';

// ============================================================================
// Mock Data
// ============================================================================

const MOCK_USERS = [
  { id: 1, email: 'john@example.com', full_name: 'John Doe', created_at: '2024-01-15T10:30:00Z' },
  { id: 2, email: 'jane@example.com', full_name: 'Jane Smith', created_at: '2024-02-20T14:45:00Z' },
  { id: 3, email: 'bob@example.com', full_name: 'Bob Wilson', created_at: '2024-03-10T09:15:00Z' },
  { id: 4, email: 'alice@example.com', full_name: 'Alice Brown', created_at: '2024-03-25T16:20:00Z' },
  { id: 5, email: 'charlie@example.com', full_name: 'Charlie Davis', created_at: '2024-04-05T11:00:00Z' },
];

const MOCK_PRODUCTS = [
  { id: 1, name: 'MacBook Pro 16"', price: 2499.99, stock: 15, category: 'Electronics' },
  { id: 2, name: 'iPhone 15 Pro', price: 999.99, stock: 42, category: 'Electronics' },
  { id: 3, name: 'AirPods Pro', price: 249.99, stock: 128, category: 'Electronics' },
  { id: 4, name: 'Magic Keyboard', price: 99.99, stock: 67, category: 'Accessories' },
  { id: 5, name: 'Studio Display', price: 1599.99, stock: 8, category: 'Electronics' },
];

const MOCK_ORDERS = [
  { id: 101, user_id: 1, total_amount: 2749.98, status: 'completed', order_date: '2024-04-01T12:00:00Z' },
  { id: 102, user_id: 2, total_amount: 999.99, status: 'completed', order_date: '2024-04-02T15:30:00Z' },
  { id: 103, user_id: 1, total_amount: 249.99, status: 'shipped', order_date: '2024-04-05T09:00:00Z' },
  { id: 104, user_id: 3, total_amount: 1699.98, status: 'processing', order_date: '2024-04-08T14:00:00Z' },
  { id: 105, user_id: 4, total_amount: 99.99, status: 'pending', order_date: '2024-04-10T10:00:00Z' },
];

// ============================================================================
// Demo Provider
// ============================================================================

export class DemoProvider extends BaseDatabaseProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    // Demo mode is always "connected"
    this.setConnected(true);
  }

  public async disconnect(): Promise<void> {
    this.setConnected(false);
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string): Promise<QueryResult> {
    const { result, executionTime } = await this.measureExecution(async () => {
      const lowerSql = sql.toLowerCase().trim();

      // Parse query to determine response
      if (lowerSql.includes('from users')) {
        return this.handleUsersQuery(lowerSql);
      }

      if (lowerSql.includes('from products')) {
        return this.handleProductsQuery(lowerSql);
      }

      if (lowerSql.includes('from orders')) {
        return this.handleOrdersQuery(lowerSql);
      }

      // Handle aggregate queries
      if (lowerSql.includes('count(*)')) {
        return {
          rows: [{ count: 100 }],
          fields: ['count'],
        };
      }

      // Default response for unknown queries
      return {
        rows: [{
          message: "Demo mode supports: 'SELECT * FROM users', 'SELECT * FROM products', 'SELECT * FROM orders'",
          hint: "Try: SELECT * FROM users WHERE id = 1",
        }],
        fields: ['message', 'hint'],
      };
    });

    return {
      rows: result.rows,
      fields: result.fields,
      rowCount: result.rows.length,
      executionTime,
    };
  }

  private handleUsersQuery(sql: string): { rows: unknown[]; fields: string[] } {
    let rows = [...MOCK_USERS];

    // Simple WHERE clause parsing
    const whereMatch = sql.match(/where\s+(\w+)\s*=\s*['"]?(\w+)['"]?/i);
    if (whereMatch) {
      const [, field, value] = whereMatch;
      rows = rows.filter((r) => {
        const fieldValue = String(r[field as keyof typeof r]);
        return fieldValue.toLowerCase() === value.toLowerCase();
      });
    }

    // LIMIT parsing
    const limitMatch = sql.match(/limit\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]));
    }

    return {
      rows,
      fields: ['id', 'email', 'full_name', 'created_at'],
    };
  }

  private handleProductsQuery(sql: string): { rows: unknown[]; fields: string[] } {
    let rows = [...MOCK_PRODUCTS];

    const whereMatch = sql.match(/where\s+(\w+)\s*=\s*['"]?(\w+)['"]?/i);
    if (whereMatch) {
      const [, field, value] = whereMatch;
      rows = rows.filter((r) => {
        const fieldValue = String(r[field as keyof typeof r]);
        return fieldValue.toLowerCase() === value.toLowerCase();
      });
    }

    const limitMatch = sql.match(/limit\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]));
    }

    return {
      rows,
      fields: ['id', 'name', 'price', 'stock', 'category'],
    };
  }

  private handleOrdersQuery(sql: string): { rows: unknown[]; fields: string[] } {
    let rows = [...MOCK_ORDERS];

    const whereMatch = sql.match(/where\s+(\w+)\s*=\s*['"]?(\w+)['"]?/i);
    if (whereMatch) {
      const [, field, value] = whereMatch;
      rows = rows.filter((r) => {
        const fieldValue = String(r[field as keyof typeof r]);
        return fieldValue.toLowerCase() === value.toLowerCase();
      });
    }

    const limitMatch = sql.match(/limit\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]));
    }

    return {
      rows,
      fields: ['id', 'user_id', 'total_amount', 'status', 'order_date'],
    };
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    return [
      {
        name: 'users',
        rowCount: MOCK_USERS.length * 250, // Simulated larger count
        size: '144 KB',
        columns: [
          { name: 'id', type: 'integer', nullable: false, isPrimary: true },
          { name: 'email', type: 'varchar(255)', nullable: false, isPrimary: false },
          { name: 'full_name', type: 'varchar(255)', nullable: true, isPrimary: false },
          { name: 'created_at', type: 'timestamp', nullable: false, isPrimary: false },
        ],
        indexes: [
          { name: 'users_pkey', columns: ['id'], unique: true },
          { name: 'users_email_key', columns: ['email'], unique: true },
        ],
        foreignKeys: [],
      },
      {
        name: 'products',
        rowCount: MOCK_PRODUCTS.length * 90, // Simulated larger count
        size: '64 KB',
        columns: [
          { name: 'id', type: 'integer', nullable: false, isPrimary: true },
          { name: 'name', type: 'varchar(255)', nullable: false, isPrimary: false },
          { name: 'price', type: 'decimal(10,2)', nullable: false, isPrimary: false },
          { name: 'stock', type: 'integer', nullable: false, isPrimary: false },
          { name: 'category', type: 'varchar(100)', nullable: true, isPrimary: false },
        ],
        indexes: [
          { name: 'products_pkey', columns: ['id'], unique: true },
          { name: 'products_name_idx', columns: ['name'], unique: false },
        ],
        foreignKeys: [],
      },
      {
        name: 'orders',
        rowCount: MOCK_ORDERS.length * 1780, // Simulated larger count
        size: '1.2 MB',
        columns: [
          { name: 'id', type: 'integer', nullable: false, isPrimary: true },
          { name: 'user_id', type: 'integer', nullable: false, isPrimary: false },
          { name: 'total_amount', type: 'decimal(10,2)', nullable: false, isPrimary: false },
          { name: 'status', type: 'varchar(50)', nullable: false, isPrimary: false },
          { name: 'order_date', type: 'timestamp', nullable: false, isPrimary: false },
        ],
        indexes: [
          { name: 'orders_pkey', columns: ['id'], unique: true },
          { name: 'orders_user_id_idx', columns: ['user_id'], unique: false },
          { name: 'orders_status_idx', columns: ['status'], unique: false },
        ],
        foreignKeys: [
          { columnName: 'user_id', referencedTable: 'users', referencedColumn: 'id' },
        ],
      },
    ];
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    return {
      activeConnections: 12,
      databaseSize: '124 MB',
      cacheHitRatio: '98.5%',
      slowQueries: [
        {
          query: 'SELECT * FROM users JOIN orders ON users.id = orders.user_id...',
          calls: 150,
          avgTime: '301.3ms',
        },
        {
          query: 'UPDATE products SET stock = stock - 1 WHERE id = ?...',
          calls: 1200,
          avgTime: '10.4ms',
        },
        {
          query: 'SELECT COUNT(*) FROM orders WHERE status = ?...',
          calls: 890,
          avgTime: '45.2ms',
        },
      ],
      activeSessions: [
        {
          pid: 1234,
          user: 'app_user',
          database: 'demo_db',
          state: 'active',
          query: 'SELECT * FROM users WHERE id = 1',
          duration: '0.05s',
        },
        {
          pid: 5678,
          user: 'admin',
          database: 'demo_db',
          state: 'idle',
          query: 'BEGIN',
          duration: '2.3s',
        },
        {
          pid: 9012,
          user: 'app_user',
          database: 'demo_db',
          state: 'active',
          query: 'INSERT INTO orders (user_id, total_amount) VALUES (?, ?)',
          duration: '0.02s',
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
    // Simulate maintenance operation with delay
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));

    const messages: Record<MaintenanceType, string> = {
      vacuum: `VACUUM ${target || 'all tables'} completed. Reclaimed 12 MB of space.`,
      analyze: `ANALYZE ${target || 'all tables'} completed. Updated statistics for 3 tables.`,
      reindex: `REINDEX ${target || 'database'} completed. Rebuilt 8 indexes.`,
      kill: target ? `Terminated connection ${target}.` : 'No connection specified.',
      optimize: `OPTIMIZE ${target || 'all tables'} completed.`,
      check: `CHECK ${target || 'all tables'} completed. All tables are healthy.`,
    };

    return {
      success: true,
      executionTime: Math.round(500 + Math.random() * 1000),
      message: messages[type] || `${type.toUpperCase()} completed successfully.`,
    };
  }
}
