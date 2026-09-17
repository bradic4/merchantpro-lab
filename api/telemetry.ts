import { shadowWrite } from '../lib/telemetry.js';

export const config = {
  runtime: 'edge',
};

export function createTelemetryHandler(persist = shadowWrite) {
return async function handler(request: Request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  try {
    const text = await request.text();
    const data = text ? JSON.parse(text) : {};
    const country = request.headers.get('x-vercel-ip-country') || 'unknown';
    const clientIp = request.headers.get('x-forwarded-for') || 'unknown';

    console.log('[SD_TELEMETRY]', JSON.stringify({
      loggedAt: new Date().toISOString(),
      country,
      clientIp,
      ...data,
    }));

    // Additive shadow write. Preserve the original log and all production responses.
    // Separate context prevents payload fields from overwriting trusted receipt metadata.
    try { await persist(data, { receivedAt: Date.now(), edgeCountry: country }); }
    catch { /* Fail open even if an injected adapter fails unexpectedly. */ }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Invalid payload' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
}

export default createTelemetryHandler();
