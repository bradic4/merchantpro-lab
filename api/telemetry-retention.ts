import { retainTelemetry } from '../lib/telemetry.js';

export const config = { runtime: 'edge' };

export default async function handler(request: Request) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
  }
  try {
    const result = await retainTelemetry();
    console.log('[SD_TELEMETRY_RETENTION]', JSON.stringify(result));
    // A partial cleanup is visible and can be invoked again, never silently treated as complete.
    return new Response(JSON.stringify(result), { status: result.moreMayRemain ? 503 : 200, headers });
  } catch {
    console.error('[SD_TELEMETRY_RETENTION]', JSON.stringify({ outcome: 'failed' }));
    return new Response(JSON.stringify({ error: 'Retention failed' }), { status: 503, headers });
  }
}
