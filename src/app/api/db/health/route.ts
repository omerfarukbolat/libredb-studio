import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  isDatabaseError,
  ConnectionError,
} from '@/lib/db';

/**
 * GET /api/db/health
 * Simple health check for load balancers and container orchestration (Render, K8s, etc.)
 * Returns 200 OK if the service is running
 */
export async function GET() {
  return NextResponse.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'libredb-studio',
  });
}

/**
 * POST /api/db/health
 * Detailed health check for a specific database connection
 */
export async function POST(req: NextRequest) {
  try {
    const { connection } = await req.json();

    if (!connection || !connection.type) {
      return NextResponse.json(
        { error: 'Valid connection configuration is required' },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);
    const health = await provider.getHealth();

    return NextResponse.json(health);
  } catch (error) {
    console.error('[API:health] Error:', error);

    if (error instanceof ConnectionError) {
      return NextResponse.json(
        {
          error: `Connection failed: ${error.message}`,
          activeConnections: 0,
          databaseSize: 'N/A',
          cacheHitRatio: 'N/A',
          slowQueries: [],
          activeSessions: [],
        },
        { status: 503 }
      );
    }

    if (isDatabaseError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 500 }
      );
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
