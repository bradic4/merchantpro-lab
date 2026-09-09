import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface JobItem {
  id: string;
  originalPath: string;
  originalSha256: string;
  originalBytes: number;
  originalDimensions?: { width: number; height: number };
  backupPath: string;
  optimizedPath: string;
  optimizedSha256?: string;
  optimizedBytes?: number;
  optimizedDimensions?: { width: number; height: number };
  savedBytes: number;
  savedPercent: number;
  status: 'optimized' | 'skipped' | 'failed';
  error?: string;
}

export interface OptimizationJob {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceDirectory: string;
  backupDirectory: string;
  totalOriginalBytes: number;
  totalOptimizedBytes: number;
  totalSavedBytes: number;
  items: JobItem[];
}

export function calcSha256(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function backupFile(
  sourcePath: string,
  backupDirectory: string
): Promise<{ backupPath: string; sha256: string; bytes: number; content: Buffer }> {
  const content = await readFile(sourcePath);
  const hash = calcSha256(content);
  const name = basename(sourcePath);
  const targetBackupPath = join(backupDirectory, `${hash}_${name}`);

  await mkdir(backupDirectory, { recursive: true });
  await writeFile(targetBackupPath, content);

  return {
    backupPath: targetBackupPath,
    sha256: hash,
    bytes: content.length,
    content,
  };
}

export async function saveJobManifest(
  job: OptimizationJob,
  destinationPath: string
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, JSON.stringify(job, null, 2) + '\n', 'utf8');
}

export async function loadJobManifest(manifestPath: string): Promise<OptimizationJob> {
  const text = await readFile(manifestPath, 'utf8');
  const job = JSON.parse(text) as OptimizationJob;
  if (!job || job.schemaVersion !== 1 || !Array.isArray(job.items)) {
    throw new Error(`Neispravan format manifesta posla: ${manifestPath}`);
  }
  return job;
}

export async function rollbackJob(
  jobManifestPath: string
): Promise<{ restoredCount: number; errors: string[] }> {
  const job = await loadJobManifest(jobManifestPath);
  let restoredCount = 0;
  const errors: string[] = [];

  for (const item of job.items) {
    if (item.status !== 'optimized') continue;
    try {
      // Export jobs never changed the original and need no restoration.
      if (resolve(item.optimizedPath) !== resolve(item.originalPath)) continue;
      const currentHash = calcSha256(await readFile(item.originalPath));
      if (currentHash === item.originalSha256) continue;
      if (!item.optimizedSha256 || currentHash !== item.optimizedSha256) {
        throw new Error('Konflikt: trenutni fajl ne odgovara rezultatu optimizacije; sačuvan je bez izmene.');
      }
      // Verify backup integrity before restoring
      const backupContent = await readFile(item.backupPath);
      const backupHash = calcSha256(backupContent);
      if (backupHash !== item.originalSha256) {
        throw new Error(
          `Backup heš (${backupHash}) ne odgovara originalnom SHA-256 (${item.originalSha256}) za ${item.originalPath}.`
        );
      }
      await writeFile(item.originalPath, backupContent);
      restoredCount++;
    } catch (err: any) {
      errors.push(`Greška pri vraćanju ${item.originalPath}: ${err.message}`);
    }
  }

  return { restoredCount, errors };
}
