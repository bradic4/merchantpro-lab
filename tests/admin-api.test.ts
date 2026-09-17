import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import handler from '../index.js';

function startTestServer(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('Full Commercial API lifecycle: Auth, Tenant Isolation, Remote Config & Dynamic sd.js', async (t) => {
  const { server, url } = await startTestServer();
  t.after(() => server.close());

  // 1. Check UI routes respond with 200 HTML
  const loginHtmlRes = await fetch(`${url}/login`);
  assert.equal(loginHtmlRes.status, 200);
  const loginHtml = await loginHtmlRes.text();
  assert.ok(loginHtml.includes('MerchantPro Lab'));

  const dashHtmlRes = await fetch(`${url}/dashboard`);
  assert.equal(dashHtmlRes.status, 200);

  const adminHtmlRes = await fetch(`${url}/admin`);
  assert.equal(adminHtmlRes.status, 200);

  // 2. Auth: Client login
  const clientLoginRes = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'client@volimsvojdom.rs', password: 'client123' })
  });
  assert.equal(clientLoginRes.status, 200);
  const clientData = await clientLoginRes.json();
  assert.ok(clientData.token);
  assert.equal(clientData.user.role, 'CLIENT');
  assert.equal(clientData.user.storeId, 'volimsvojdom');
  const clientToken = clientData.token;

  // 3. Auth: Admin login
  const adminLoginRes = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@merchantpro.lab', password: 'admin123' })
  });
  assert.equal(adminLoginRes.status, 200);
  const adminData = await adminLoginRes.json();
  assert.equal(adminData.user.role, 'ADMIN');
  const adminToken = adminData.token;

  // 4. Invalid credentials rejected
  const badLoginRes = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'client@volimsvojdom.rs', password: 'wrongpassword' })
  });
  assert.equal(badLoginRes.status, 401);

  // 5. Client overview (Tenant access allowed for own store)
  const clientOverviewRes = await fetch(`${url}/api/client/overview`, {
    headers: { Authorization: `Bearer ${clientToken}` }
  });
  assert.equal(clientOverviewRes.status, 200);
  const overviewData = await clientOverviewRes.json();
  assert.equal(overviewData.store.id, 'volimsvojdom');
  assert.equal(overviewData.metrics.reductionPercent, -38.9);

  // 6. Tenant Isolation: Client CANNOT access admin API
  const clientToAdminRes = await fetch(`${url}/api/admin/stores`, {
    headers: { Authorization: `Bearer ${clientToken}` }
  });
  assert.equal(clientToAdminRes.status, 403);

  // 7. Admin lists all stores
  const adminStoresRes = await fetch(`${url}/api/admin/stores`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminStoresRes.status, 200);
  const storesData = await adminStoresRes.json();
  assert.ok(storesData.stores.length >= 2);

  // 8. Admin changes Canary percent to 5% and toggles TikTok off
  const updateConfigRes = await fetch(`${url}/api/admin/stores/volimsvojdom/config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      canaryPercent: 5,
      killSwitch: false,
      vendors: { meta: true, gtm: true, tiktok: false }
    })
  });
  assert.equal(updateConfigRes.status, 200);

  // 9. Verify /sd.js dynamically updated with 5% and TikTok disabled
  const sdJsRes = await fetch(`${url}/sd.js?store=volimsvojdom`, {
    headers: { 'x-vercel-ip-country': 'RS' }
  });
  assert.equal(sdJsRes.status, 200);
  const sdJsContent = await sdJsRes.text();
  assert.ok(sdJsContent.includes('CanaryRate: 5%'));
  assert.ok(sdJsContent.includes('roll < 5'));
  assert.ok(sdJsContent.includes('isTiktok = false'));

  // 10. Telemetry ingestion works and updates metrics
  const telemetryRes = await fetch(`${url}/api/telemetry`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-vercel-ip-country': 'RS'
    },
    body: JSON.stringify({
      storeId: 'volimsvojdom',
      cohort: 'domestic_canary',
      url: 'https://www.volimsvojdom.rs/test-page',
      longTaskBlockingMs: 310,
      errorsCount: 0,
      eventsBuffered: 3,
      meta: 'loaded',
      gtm: 'loaded',
      tiktok: 'idle'
    })
  });
  assert.equal(telemetryRes.status, 200);

  // Verify telemetry was recorded
  const clientUpdatedOverviewRes = await fetch(`${url}/api/client/overview`, {
    headers: { Authorization: `Bearer ${clientToken}` }
  });
  const updatedOverview = await clientUpdatedOverviewRes.json();
  assert.ok(updatedOverview.metrics.totalSessions >= 1);
  assert.ok(updatedOverview.metrics.recentSessions.length >= 1);
  assert.equal(updatedOverview.metrics.recentSessions[0].cohort, 'domestic_canary');
});
