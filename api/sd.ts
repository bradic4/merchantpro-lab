import { resolveCohort, generateEdgeScript, type EdgeGeoContext } from '../src/edge-runtime.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const country = request.headers.get('x-vercel-ip-country') || 'unknown';
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const host = request.headers.get('host') || url.host;
  const userAgent = request.headers.get('user-agent') || '';

  const query: Record<string, string> = {};
  url.searchParams.forEach((val, key) => {
    query[key] = val;
  });

  const ctx: EdgeGeoContext = {
    country,
    ip,
    host,
    url: request.url,
    userAgent,
    query,
  };

  const script = generateEdgeScript(ctx);

  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      'Vary': 'x-vercel-ip-country',
    },
  });
}
