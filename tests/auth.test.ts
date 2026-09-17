import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  canAccessStore,
  assertStoreAccess,
  type AuthSession,
} from '../src/auth.js';

test('hashPassword generates distinct salt and verifies correctly', () => {
  const { hash, salt } = hashPassword('supersecret');
  assert.ok(hash);
  assert.ok(salt);
  assert.equal(verifyPassword('supersecret', hash, salt), true);
  assert.equal(verifyPassword('wrongpassword', hash, salt), false);
});

test('session tokens sign and verify with payload integrity', () => {
  const token = createSessionToken({
    id: 'usr_1',
    email: 'test@volimsvojdom.rs',
    role: 'CLIENT',
    storeId: 'volimsvojdom',
  });

  const session = verifySessionToken(token);
  assert.ok(session);
  assert.equal(session.email, 'test@volimsvojdom.rs');
  assert.equal(session.role, 'CLIENT');
  assert.equal(session.storeId, 'volimsvojdom');

  // Tampered signature fails
  const [payload] = token.split('.');
  assert.equal(verifySessionToken(`${payload}.forged_signature`), null);
  assert.equal(verifySessionToken('malformed_token'), null);
});

test('tenant isolation enforces strict store-level boundaries', () => {
  const clientSession: AuthSession = {
    userId: 'usr_client',
    email: 'client@volimsvojdom.rs',
    role: 'CLIENT',
    storeId: 'volimsvojdom',
    expiresAt: Date.now() + 100000,
  };

  const adminSession: AuthSession = {
    userId: 'usr_admin',
    email: 'admin@merchantpro.lab',
    role: 'ADMIN',
    storeId: null,
    expiresAt: Date.now() + 100000,
  };

  // Client CAN access own store
  assert.equal(canAccessStore(clientSession, 'volimsvojdom'), true);
  assert.doesNotThrow(() => assertStoreAccess(clientSession, 'volimsvojdom'));

  // Client CANNOT access another store (Shop #2 / Baldino)
  assert.equal(canAccessStore(clientSession, 'baldino'), false);
  assert.throws(() => assertStoreAccess(clientSession, 'baldino'), (err: any) => {
    return err.statusCode === 403;
  });

  // Admin CAN access ANY store
  assert.equal(canAccessStore(adminSession, 'volimsvojdom'), true);
  assert.equal(canAccessStore(adminSession, 'baldino'), true);
  assert.equal(canAccessStore(adminSession, 'any_future_store'), true);
});
