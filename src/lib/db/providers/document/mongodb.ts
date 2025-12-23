/**
 * MongoDB Database Provider
 * Document database support using official MongoDB driver
 */

import { MongoClient, type Db, type Document, type MongoClientOptions } from 'mongodb';
import { BaseDatabaseProvider } from '../../base-provider';
import {
  type DatabaseConnection,
  type TableSchema,
  type ColumnSchema,
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
// Types
// ============================================================================

interface MongoQuery {
  collection: string;
  operation: 'find' | 'findOne' | 'aggregate' | 'count' | 'distinct' | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';
  filter?: Document;
  pipeline?: Document[];
  update?: Document;
  documents?: Document[];
  options?: {
    limit?: number;
    skip?: number;
    sort?: Document;
    projection?: Document;
  };
}

// ============================================================================
// MongoDB Provider
// ============================================================================

export class MongoDBProvider extends BaseDatabaseProvider {
  private client: MongoClient | null = null;
  private db: Db | null = null;

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
        throw new DatabaseConfigError('Host or connection string is required for MongoDB', 'mongodb');
      }
      if (!this.config.database) {
        throw new DatabaseConfigError('Database name is required for MongoDB', 'mongodb');
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.client && this.db) {
      return;
    }

    try {
      const connectionString = this.buildConnectionString();
      const options: MongoClientOptions = {
        maxPoolSize: this.poolConfig.max,
        minPoolSize: this.poolConfig.min,
        maxIdleTimeMS: this.poolConfig.idleTimeout,
        connectTimeoutMS: this.poolConfig.acquireTimeout,
        serverSelectionTimeoutMS: this.poolConfig.acquireTimeout,
      };

      this.client = new MongoClient(connectionString, options);
      await this.client.connect();

      // Get database name from connection string or config
      const dbName = this.getDatabaseName();
      this.db = this.client.db(dbName);

      // Test connection
      await this.db.command({ ping: 1 });

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to MongoDB: ${error instanceof Error ? error.message : error}`,
        'mongodb',
        this.config.host,
        this.config.port
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.setConnected(false);
    }
  }

  private buildConnectionString(): string {
    if (this.config.connectionString) {
      return this.config.connectionString;
    }

    const auth = this.config.user && this.config.password
      ? `${encodeURIComponent(this.config.user)}:${encodeURIComponent(this.config.password)}@`
      : '';

    const host = this.config.host || 'localhost';
    const port = this.config.port || 27017;
    const database = this.config.database || 'test';

    return `mongodb://${auth}${host}:${port}/${database}`;
  }

  private getDatabaseName(): string {
    if (this.config.database) {
      return this.config.database;
    }

    // Extract from connection string
    if (this.config.connectionString) {
      const match = this.config.connectionString.match(/\/([^/?]+)(\?|$)/);
      if (match) {
        return match[1];
      }
    }

    return 'test';
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  /**
   * Execute a MongoDB query
   * Accepts JSON-formatted MQL queries
   *
   * @example
   * // Find documents
   * {"collection": "users", "operation": "find", "filter": {"age": {"$gt": 18}}, "options": {"limit": 10}}
   *
   * // Aggregate
   * {"collection": "orders", "operation": "aggregate", "pipeline": [{"$group": {"_id": "$status", "count": {"$sum": 1}}}]}
   *
   * // Insert
   * {"collection": "users", "operation": "insertOne", "documents": [{"name": "John", "email": "john@example.com"}]}
   */
  public async query(queryStr: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const query = this.parseQuery(queryStr);
          const collection = this.db!.collection(query.collection);

          let rows: Document[] = [];
          let affectedCount = 0;

          switch (query.operation) {
            case 'find':
              const cursor = collection.find(query.filter || {});
              if (query.options?.projection) cursor.project(query.options.projection);
              if (query.options?.sort) cursor.sort(query.options.sort);
              if (query.options?.skip) cursor.skip(query.options.skip);
              if (query.options?.limit) cursor.limit(query.options.limit);
              else cursor.limit(100); // Default limit
              rows = await cursor.toArray();
              break;

            case 'findOne':
              const doc = await collection.findOne(query.filter || {}, {
                projection: query.options?.projection,
              });
              rows = doc ? [doc] : [];
              break;

            case 'aggregate':
              rows = await collection.aggregate(query.pipeline || []).toArray();
              break;

            case 'count':
              const count = await collection.countDocuments(query.filter || {});
              rows = [{ count }];
              break;

            case 'distinct':
              const field = query.options?.projection ? Object.keys(query.options.projection)[0] : '_id';
              const values = await collection.distinct(field, query.filter || {});
              rows = values.map(v => ({ [field]: v }));
              break;

            case 'insertOne':
              if (!query.documents || query.documents.length === 0) {
                throw new QueryError('Document is required for insertOne', 'mongodb');
              }
              const insertOneResult = await collection.insertOne(query.documents[0]);
              rows = [{ insertedId: insertOneResult.insertedId, acknowledged: insertOneResult.acknowledged }];
              affectedCount = insertOneResult.acknowledged ? 1 : 0;
              break;

            case 'insertMany':
              if (!query.documents || query.documents.length === 0) {
                throw new QueryError('Documents are required for insertMany', 'mongodb');
              }
              const insertManyResult = await collection.insertMany(query.documents);
              rows = [{ insertedCount: insertManyResult.insertedCount, insertedIds: insertManyResult.insertedIds }];
              affectedCount = insertManyResult.insertedCount;
              break;

            case 'updateOne':
              if (!query.update) {
                throw new QueryError('Update document is required for updateOne', 'mongodb');
              }
              const updateOneResult = await collection.updateOne(query.filter || {}, query.update);
              rows = [{ matchedCount: updateOneResult.matchedCount, modifiedCount: updateOneResult.modifiedCount }];
              affectedCount = updateOneResult.modifiedCount;
              break;

            case 'updateMany':
              if (!query.update) {
                throw new QueryError('Update document is required for updateMany', 'mongodb');
              }
              const updateManyResult = await collection.updateMany(query.filter || {}, query.update);
              rows = [{ matchedCount: updateManyResult.matchedCount, modifiedCount: updateManyResult.modifiedCount }];
              affectedCount = updateManyResult.modifiedCount;
              break;

            case 'deleteOne':
              const deleteOneResult = await collection.deleteOne(query.filter || {});
              rows = [{ deletedCount: deleteOneResult.deletedCount }];
              affectedCount = deleteOneResult.deletedCount;
              break;

            case 'deleteMany':
              const deleteManyResult = await collection.deleteMany(query.filter || {});
              rows = [{ deletedCount: deleteManyResult.deletedCount }];
              affectedCount = deleteManyResult.deletedCount;
              break;

            default:
              throw new QueryError(`Unsupported operation: ${query.operation}`, 'mongodb');
          }

          // Convert ObjectId to string for display
          const serializedRows = rows.map(row => this.serializeDocument(row));

          return {
            rows: serializedRows,
            fields: serializedRows.length > 0 ? Object.keys(serializedRows[0]) : [],
            affectedCount,
          };
        } catch (error) {
          if (error instanceof QueryError) throw error;
          throw mapDatabaseError(error, 'mongodb', queryStr);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields,
        rowCount: result.rows.length || result.affectedCount,
        executionTime,
      };
    });
  }

  private parseQuery(queryStr: string): MongoQuery {
    try {
      // Try to parse as JSON
      const parsed = JSON.parse(queryStr.trim());

      if (!parsed.collection) {
        throw new QueryError('Collection name is required in query', 'mongodb');
      }
      if (!parsed.operation) {
        throw new QueryError('Operation is required in query (find, findOne, aggregate, etc.)', 'mongodb');
      }

      return parsed as MongoQuery;
    } catch (error) {
      if (error instanceof QueryError) throw error;
      throw new QueryError(
        `Invalid MongoDB query format. Expected JSON with "collection" and "operation" fields. Example: {"collection": "users", "operation": "find", "filter": {}}`,
        'mongodb'
      );
    }
  }

  private serializeDocument(doc: Document): Record<string, unknown> {
    const serialized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(doc)) {
      if (value && typeof value === 'object') {
        if (value.constructor?.name === 'ObjectId') {
          serialized[key] = value.toString();
        } else if (value instanceof Date) {
          serialized[key] = value.toISOString();
        } else if (Array.isArray(value)) {
          serialized[key] = value.map(v =>
            typeof v === 'object' && v !== null ? this.serializeDocument(v) : v
          );
        } else {
          serialized[key] = this.serializeDocument(value as Document);
        }
      } else {
        serialized[key] = value;
      }
    }

    return serialized;
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  /**
   * Get schema by listing collections and sampling documents to infer field types
   */
  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const collections = await this.db!.listCollections().toArray();
    const schemas: TableSchema[] = [];

    for (const collInfo of collections) {
      const collName = collInfo.name;
      const collection = this.db!.collection(collName);

      // Get document count
      const rowCount = await collection.estimatedDocumentCount();

      // Get collection stats for size
      let sizeBytes = 0;
      try {
        const stats = await this.db!.command({ collStats: collName });
        sizeBytes = stats.size || 0;
      } catch {
        // Stats might not be available
      }

      // Sample documents to infer schema
      const sampleDocs = await collection.find({}).limit(100).toArray();
      const columns = this.inferSchemaFromDocuments(sampleDocs);

      // Get indexes
      const indexList = await collection.indexes();
      const indexes = indexList.map(idx => ({
        name: idx.name || 'unknown',
        columns: Object.keys(idx.key || {}),
        unique: idx.unique || false,
      }));

      schemas.push({
        name: collName,
        rowCount,
        size: formatBytes(sizeBytes),
        columns,
        indexes,
        foreignKeys: [], // MongoDB doesn't have foreign keys
      });
    }

    return schemas;
  }

  private inferSchemaFromDocuments(docs: Document[]): ColumnSchema[] {
    const fieldTypes = new Map<string, Set<string>>();

    for (const doc of docs) {
      this.extractFieldTypes(doc, '', fieldTypes);
    }

    const columns: ColumnSchema[] = [];

    for (const [fieldName, types] of fieldTypes) {
      const typeArray = Array.from(types);
      const type = typeArray.length === 1 ? typeArray[0] : `mixed(${typeArray.join('|')})`;

      columns.push({
        name: fieldName,
        type,
        nullable: types.has('null') || types.has('undefined'),
        isPrimary: fieldName === '_id',
        defaultValue: undefined,
      });
    }

    // Sort: _id first, then alphabetically
    columns.sort((a, b) => {
      if (a.name === '_id') return -1;
      if (b.name === '_id') return 1;
      return a.name.localeCompare(b.name);
    });

    return columns;
  }

  private extractFieldTypes(doc: Document, prefix: string, fieldTypes: Map<string, Set<string>>): void {
    for (const [key, value] of Object.entries(doc)) {
      const fieldName = prefix ? `${prefix}.${key}` : key;

      if (!fieldTypes.has(fieldName)) {
        fieldTypes.set(fieldName, new Set());
      }

      const type = this.getMongoType(value);
      fieldTypes.get(fieldName)!.add(type);

      // Don't recurse into nested objects for now (keep it flat)
      // Uncomment below to include nested fields
      // if (type === 'object' && value !== null && !Array.isArray(value)) {
      //   this.extractFieldTypes(value as Document, fieldName, fieldTypes);
      // }
    }
  }

  private getMongoType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'date';
    if (typeof value === 'object') {
      if (value.constructor?.name === 'ObjectId') return 'objectId';
      if (value.constructor?.name === 'Binary') return 'binary';
      if (value.constructor?.name === 'Decimal128') return 'decimal';
      return 'object';
    }
    return typeof value;
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    try {
      const serverStatus = await this.db!.admin().serverStatus();
      const dbStats = await this.db!.stats();

      // Get current operations
      const currentOps = await this.db!.admin().command({ currentOp: 1 });

      const activeSessions: ActiveSession[] = (currentOps.inprog || [])
        .slice(0, 10)
        .map((op: any) => ({
          pid: op.opid || 'N/A',
          user: op.client || 'N/A',
          database: op.ns || this.getDatabaseName(),
          state: op.active ? 'active' : 'idle',
          query: JSON.stringify(op.command || {}).substring(0, 100),
          duration: op.microsecs_running
            ? `${(op.microsecs_running / 1000000).toFixed(2)}s`
            : 'N/A',
        }));

      const slowQueries: SlowQuery[] = [];

      // Try to get slow query info from profiler
      try {
        const profilerDocs = await this.db!.collection('system.profile')
          .find({})
          .sort({ ts: -1 })
          .limit(5)
          .toArray();

        for (const doc of profilerDocs) {
          slowQueries.push({
            query: JSON.stringify(doc.command || doc.query || {}).substring(0, 100),
            calls: 1,
            avgTime: `${doc.millis || 0}ms`,
          });
        }
      } catch {
        slowQueries.push({
          query: 'Profiler not enabled. Run db.setProfilingLevel(1) to enable.',
          calls: 0,
          avgTime: 'N/A',
        });
      }

      return {
        activeConnections: serverStatus.connections?.current || 0,
        databaseSize: formatBytes(dbStats.dataSize || 0),
        cacheHitRatio: serverStatus.wiredTiger?.cache
          ? `${((1 - (serverStatus.wiredTiger.cache['pages read into cache'] || 0) /
              Math.max(1, serverStatus.wiredTiger.cache['pages requested from the cache'] || 1)) * 100).toFixed(1)}%`
          : 'N/A',
        slowQueries,
        activeSessions,
      };
    } catch (error) {
      this.logError('getHealth', error);
      return {
        activeConnections: 0,
        databaseSize: 'N/A',
        cacheHitRatio: 'N/A',
        slowQueries: [{ query: 'Error fetching health info', calls: 0, avgTime: 'N/A' }],
        activeSessions: [],
      };
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
      try {
        switch (type) {
          case 'analyze':
            // Validate collection
            if (target) {
              await this.db!.command({ validate: target });
              return { success: true, message: `Validated collection: ${target}` };
            } else {
              const collections = await this.db!.listCollections().toArray();
              for (const coll of collections) {
                await this.db!.command({ validate: coll.name });
              }
              return { success: true, message: `Validated ${collections.length} collections` };
            }

          case 'reindex':
            // Reindex collection
            if (target) {
              await this.db!.command({ reIndex: target });
              return { success: true, message: `Reindexed collection: ${target}` };
            } else {
              const collections = await this.db!.listCollections().toArray();
              for (const coll of collections) {
                await this.db!.command({ reIndex: coll.name });
              }
              return { success: true, message: `Reindexed ${collections.length} collections` };
            }

          case 'vacuum':
          case 'optimize':
            // Compact collection (similar to vacuum)
            if (target) {
              await this.db!.command({ compact: target });
              return { success: true, message: `Compacted collection: ${target}` };
            } else {
              const collections = await this.db!.listCollections().toArray();
              for (const coll of collections) {
                try {
                  await this.db!.command({ compact: coll.name });
                } catch {
                  // Some collections might not be compactable
                }
              }
              return { success: true, message: `Compacted collections` };
            }

          case 'check':
            // Run dbCheck
            const result = await this.db!.command({ dbCheck: this.getDatabaseName() });
            return {
              success: true,
              message: `Database check completed: ${JSON.stringify(result)}`
            };

          case 'kill':
            if (!target) {
              throw new QueryError('Operation ID is required for kill operation', 'mongodb');
            }
            await this.db!.admin().command({ killOp: 1, op: parseInt(target, 10) });
            return { success: true, message: `Killed operation: ${target}` };

          default:
            throw new QueryError(`Unsupported maintenance type for MongoDB: ${type}`, 'mongodb');
        }
      } catch (error) {
        if (error instanceof QueryError) throw error;
        throw mapDatabaseError(error, 'mongodb');
      }
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }
}
