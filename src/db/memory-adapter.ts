import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hashPassword } from '../auth.js';
import type {
  Store,
  User,
  TelemetrySession,
  StoreMetrics,
  StorageAdapter,
  VendorHealth,
} from './types.js';

export interface MemoryAdapterOptions {
  storageFile?: string;
  persist?: boolean;
}

export class MemoryStorageAdapter implements StorageAdapter {
  private stores: Map<string, Store> = new Map();
  private users: Map<string, User> = new Map();
  private telemetry: TelemetrySession[] = [];
  private initialized = false;
  private storageFile?: string;
  private persist: boolean;

  constructor(options: MemoryAdapterOptions = {}) {
    this.storageFile = options.storageFile;
    this.persist = options.persist ?? Boolean(options.storageFile);
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.persist && this.storageFile) {
      try {
        const content = await readFile(this.storageFile, 'utf8');
        const data = JSON.parse(content);
        if (data.stores) {
          for (const s of data.stores) this.stores.set(s.id, s);
        }
        if (data.users) {
          for (const u of data.users) this.users.set(u.email.toLowerCase(), u);
        }
        if (data.telemetry) {
          this.telemetry = data.telemetry;
        }
        this.initialized = true;
        return;
      } catch (_) {
        // File does not exist yet or parse failed, initialize defaults
      }
    }

    this.seedDefaults();
    this.initialized = true;
    if (this.persist && this.storageFile) {
      await this.saveToFile();
    }
  }

  private seedDefaults() {
    // 1. Seed Stores
    const vVolimSvojDom: Store = {
      id: 'volimsvojdom',
      name: 'VolimSvojDom.rs',
      domain: 'www.volimsvojdom.rs',
      platform: 'merchantpro',
      status: 'live',
      canaryPercent: 1, // Active 1% Domestic Canary
      killSwitch: false,
      vendors: { meta: true, gtm: true, tiktok: true },
      baselineBlockingMs: 11300,
      optimizedBlockingMs: 6900,
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
    };

    const vBaldino: Store = {
      id: 'baldino',
      name: 'Baldino.rs',
      domain: 'baldino.rs',
      platform: 'shopify',
      status: 'pilot',
      canaryPercent: 0,
      killSwitch: false,
      vendors: { meta: true, gtm: true, tiktok: false },
      baselineBlockingMs: 8400,
      optimizedBlockingMs: 4850,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
    };

    this.stores.set(vVolimSvojDom.id, vVolimSvojDom);
    this.stores.set(vBaldino.id, vBaldino);

    // 2. Seed Users
    // Default admin: admin@merchantpro.lab / admin123
    const adminAuth = hashPassword('admin123', 'admin_salt_fixed');
    const adminUser: User = {
      id: 'usr_admin',
      email: 'admin@merchantpro.lab',
      passwordHash: `${adminAuth.hash}:${adminAuth.salt}`,
      name: 'Ivan (Administrator)',
      role: 'ADMIN',
      storeId: null,
      createdAt: '2026-09-08T00:00:00.000Z',
    };

    // Default client: client@volimsvojdom.rs / client123
    const clientAuth = hashPassword('client123', 'client_salt_fixed');
    const clientUser: User = {
      id: 'usr_vsd_client',
      email: 'client@volimsvojdom.rs',
      passwordHash: `${clientAuth.hash}:${clientAuth.salt}`,
      name: 'VolimSvojDom Owner',
      role: 'CLIENT',
      storeId: 'volimsvojdom',
      createdAt: '2026-09-08T00:00:00.000Z',
    };

    this.users.set(adminUser.email.toLowerCase(), adminUser);
    this.users.set(clientUser.email.toLowerCase(), clientUser);
  }

  private async saveToFile(): Promise<void> {
    if (!this.storageFile) return;
    try {
      await mkdir(dirname(this.storageFile), { recursive: true });
      const payload = {
        stores: Array.from(this.stores.values()),
        users: Array.from(this.users.values()),
        telemetry: this.telemetry.slice(-5000), // Retain last 5000 sessions
      };
      await writeFile(this.storageFile, JSON.stringify(payload, null, 2), 'utf8');
    } catch (_) {}
  }

  async getStore(storeId: string): Promise<Store | null> {
    await this.init();
    return this.stores.get(storeId) || null;
  }

  async listStores(): Promise<Store[]> {
    await this.init();
    return Array.from(this.stores.values());
  }

  async updateStoreConfig(
    storeId: string,
    updates: Partial<Pick<Store, 'canaryPercent' | 'killSwitch' | 'vendors' | 'status'>>
  ): Promise<Store> {
    await this.init();
    const existing = this.stores.get(storeId);
    if (!existing) {
      throw new Error(`Store with id '${storeId}' not found.`);
    }

    const updated: Store = {
      ...existing,
      canaryPercent: typeof updates.canaryPercent === 'number' ? updates.canaryPercent : existing.canaryPercent,
      killSwitch: typeof updates.killSwitch === 'boolean' ? updates.killSwitch : existing.killSwitch,
      status: updates.status || existing.status,
      vendors: updates.vendors ? { ...existing.vendors, ...updates.vendors } : existing.vendors,
      updatedAt: new Date().toISOString(),
    };

    this.stores.set(storeId, updated);
    if (this.persist) await this.saveToFile();
    return updated;
  }

  async recordTelemetry(sessionData: Omit<TelemetrySession, 'id'>): Promise<TelemetrySession> {
    await this.init();
    const session: TelemetrySession = {
      ...sessionData,
      id: `tel_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    };

    this.telemetry.push(session);
    if (this.telemetry.length > 5000) {
      this.telemetry.shift();
    }

    if (this.persist) await this.saveToFile();
    return session;
  }

  async getStoreMetrics(storeId: string, windowHours = 24): Promise<StoreMetrics> {
    await this.init();
    const store = this.stores.get(storeId);
    if (!store) {
      throw new Error(`Store '${storeId}' not found.`);
    }

    const cutoff = Date.now() - windowHours * 3600 * 1000;
    const storeTelemetry = this.telemetry.filter(
      (t) => t.storeId === storeId && t.timestamp >= cutoff
    );

    let totalSessions = storeTelemetry.length;
    let optimizedSessions = 0;
    let baselineSessions = 0;
    let crawlerSessions = 0;
    let totalErrors = 0;
    const countryBreakdown: Record<string, number> = {};

    let metaErrors = 0;
    let metaBuffered = 0;
    let gtmErrors = 0;
    let gtmBuffered = 0;
    let tiktokErrors = 0;
    let tiktokBuffered = 0;

    for (const item of storeTelemetry) {
      if (item.cohort.includes('canary')) optimizedSessions++;
      else if (item.cohort === 'search_engine_baseline') crawlerSessions++;
      else baselineSessions++;

      totalErrors += item.errorsCount || 0;
      const c = item.country || 'unknown';
      countryBreakdown[c] = (countryBreakdown[c] || 0) + 1;

      if (item.meta === 'failed') metaErrors++;
      if (item.meta === 'deferred' || item.meta === 'loaded') metaBuffered += item.eventsBuffered || 0;
      if (item.gtm === 'failed') gtmErrors++;
      if (item.tiktok === 'failed') tiktokErrors++;
    }

    const reductionPercent =
      store.baselineBlockingMs > 0
        ? Math.round(((store.optimizedBlockingMs - store.baselineBlockingMs) / store.baselineBlockingMs) * 1000) / 10
        : 0;

    const vendorHealth: {
      meta: VendorHealth;
      gtm: VendorHealth;
      tiktok: VendorHealth;
    } = {
      meta: {
        status: metaErrors > 0 ? 'degraded' : 'healthy',
        eventsBuffered: metaBuffered,
        errorsCount: metaErrors,
      },
      gtm: {
        status: gtmErrors > 0 ? 'degraded' : 'healthy',
        eventsBuffered: gtmBuffered,
        errorsCount: gtmErrors,
      },
      tiktok: {
        status: tiktokErrors > 0 ? 'degraded' : 'healthy',
        eventsBuffered: tiktokBuffered,
        errorsCount: tiktokErrors,
      },
    };

    const recentSessions = storeTelemetry
      .slice(-50)
      .sort((a, b) => b.timestamp - a.timestamp);

    return {
      storeId,
      totalSessions,
      optimizedSessions,
      baselineSessions,
      crawlerSessions,
      totalErrors,
      baselineBlockingMs: store.baselineBlockingMs,
      optimizedBlockingMs: store.optimizedBlockingMs,
      reductionPercent,
      vendorHealth,
      recentSessions,
      countryBreakdown,
    };
  }

  async getUserByEmail(email: string): Promise<User | null> {
    await this.init();
    return this.users.get(email.toLowerCase()) || null;
  }

  async getUserById(id: string): Promise<User | null> {
    await this.init();
    for (const u of this.users.values()) {
      if (u.id === id) return u;
    }
    return null;
  }
}
