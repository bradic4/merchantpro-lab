import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { User, UserRole } from './db/types.js';

const SESSION_SECRET = process.env.SESSION_SECRET || 'merchantpro-lab-auth-secret-key-v1-dev';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface AuthSession {
  userId: string;
  email: string;
  role: UserRole;
  storeId: string | null;
  expiresAt: number;
}

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const actualSalt = salt || randomBytes(16).toString('hex');
  const hmac = createHmac('sha256', actualSalt);
  hmac.update(password);
  const hash = hmac.digest('hex');
  return { hash, salt: actualSalt };
}

export function verifyPassword(password: string, expectedHash: string, salt: string): boolean {
  const { hash } = hashPassword(password, salt);
  const hashBuf = Buffer.from(hash, 'hex');
  const expBuf = Buffer.from(expectedHash, 'hex');
  if (hashBuf.length !== expBuf.length) return false;
  return timingSafeEqual(hashBuf, expBuf);
}

export function createSessionToken(user: Pick<User, 'id' | 'email' | 'role' | 'storeId'>): string {
  const session: AuthSession = {
    userId: user.id,
    email: user.email,
    role: user.role,
    storeId: user.storeId,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  const payloadStr = Buffer.from(JSON.stringify(session)).toString('base64url');
  const signature = createHmac('sha256', SESSION_SECRET).update(payloadStr).digest('base64url');
  return `${payloadStr}.${signature}`;
}

export function verifySessionToken(token: string): AuthSession | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadStr, signature] = parts;
  if (!payloadStr || !signature) return null;

  const expectedSig = createHmac('sha256', SESSION_SECRET).update(payloadStr).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const jsonStr = Buffer.from(payloadStr, 'base64url').toString('utf8');
    const session = JSON.parse(jsonStr) as AuthSession;
    if (session.expiresAt < Date.now()) {
      return null;
    }
    return session;
  } catch (_) {
    return null;
  }
}

/**
 * Enforces Tenant Isolation:
 * - ADMIN can access any store.
 * - CLIENT can ONLY access their designated storeId.
 * - Returns true if authorized, false otherwise.
 */
export function canAccessStore(session: AuthSession, targetStoreId: string): boolean {
  if (!session) return false;
  if (session.role === 'ADMIN') return true;
  if (session.role === 'CLIENT' && session.storeId === targetStoreId) return true;
  return false;
}

export function assertStoreAccess(session: AuthSession, targetStoreId: string): void {
  if (!canAccessStore(session, targetStoreId)) {
    const error: any = new Error(`Access denied for store '${targetStoreId}' (tenant isolation).`);
    error.statusCode = 403;
    throw error;
  }
}
