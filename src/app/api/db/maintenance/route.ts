import { getSession } from '@/lib/auth';
import { NextResponse } from 'next/server';
import {
  getOrCreateProvider,
  isDatabaseError,
  DatabaseConfigError,
  type MaintenanceType,
} from '@/lib/db';

export async function POST(request: Request) {
  // Check admin authorization
  const session = await getSession();

  if (!session || session.role !== 'admin') {
    return NextResponse.json(
      { error: 'Unauthorized. Admin access required.' },
      { status: 403 }
    );
  }

  try {
    const { type, target, connection } = await request.json();

    // Validate maintenance type
    const validTypes: MaintenanceType[] = ['vacuum', 'analyze', 'reindex', 'kill', 'optimize', 'check'];
    if (!type || !validTypes.includes(type)) {
      return NextResponse.json(
        { error: `Invalid maintenance type. Valid types: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate connection
    if (!connection) {
      return NextResponse.json(
        { error: 'Connection is required' },
        { status: 400 }
      );
    }

    // Check if maintenance is supported for this database type
    const maintenanceSupportedTypes = ['postgres', 'mysql', 'sqlite', 'demo'];
    if (!maintenanceSupportedTypes.includes(connection.type)) {
      return NextResponse.json(
        { error: `Maintenance operations not supported for ${connection.type}` },
        { status: 400 }
      );
    }

    const provider = await getOrCreateProvider(connection);
    const result = await provider.runMaintenance(type, target);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[API:maintenance] Error:', error);

    if (error instanceof DatabaseConfigError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
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
