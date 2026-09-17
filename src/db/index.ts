import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStorageAdapter } from './memory-adapter.js';
import type { StorageAdapter } from './types.js';

export * from './types.js';
export * from './memory-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultStoragePath = resolve(__dirname, '../../data/app-data.json');

let defaultAdapter: StorageAdapter | null = null;

export function getStorage(storageFile?: string): StorageAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new MemoryStorageAdapter({
      storageFile: storageFile || defaultStoragePath,
      persist: true,
    });
  }
  return defaultAdapter;
}

export function resetStorage(): void {
  defaultAdapter = null;
}
