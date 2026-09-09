import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { publicUrl } from './manifest.js';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
export interface AuditJob {
  id: string; url: string; device: 'mobile' | 'desktop'; status: JobStatus;
  createdAt: string; updatedAt: string; error: string | null; parentId: string | null;
}
export type AuditExecutor = (job: AuditJob) => Promise<unknown>;
export class AuditJobs {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private fatal?: Error;
  private constructor(private db: DatabaseSync, private execute: AuditExecutor) {}
  static async open(path: string, execute: AuditExecutor, start = true) {
    await mkdir(dirname(path), {recursive:true});
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS worker (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, device TEXT NOT NULL, status TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, error TEXT, parentId TEXT, result TEXT);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,createdAt);`);
    try {
      db.exec('BEGIN IMMEDIATE');
      const owner = db.prepare('SELECT pid FROM worker WHERE id=1').get() as {pid:number}|undefined;
      if (owner) {
        let alive = true;
        try { process.kill(owner.pid,0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new Error('Drugi servis već upravlja ovim redom poslova.');
      }
      db.prepare('INSERT OR REPLACE INTO worker VALUES (1,?)').run(process.pid);
      db.prepare("UPDATE jobs SET status='interrupted', updatedAt=?, error=? WHERE status='running'")
        .run(new Date().toISOString(),'Servis je prekinut tokom analize. Ponovite kao novu analizu.');
      db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); db.close(); throw e; }
    const queue = new AuditJobs(db,execute);
    if (start) queue.start();
    return queue;
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(()=>this.kick(),250);
    this.timer.unref(); this.kick();
  }
  private ensureWritable() {
    if (this.stopped || this.fatal) throw this.fatal ?? new Error('Servis se zaustavlja.');
  }
  enqueue(input: {url: unknown; device?: unknown}, parentId: string|null = null): AuditJob {
    this.ensureWritable();
    const value = typeof input.url === 'string' && !input.url.includes('://') ? `https://${input.url}` : input.url;
    const url = publicUrl(value).href;
    const device = input.device ?? 'mobile';
    if (device !== 'mobile' && device !== 'desktop') throw new Error('Profil mora biti mobile ili desktop.');
    const count = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as {n:number};
    if (count.n >= 20) throw new Error('Red je pun (najviše 20 aktivnih poslova).');
    const now = new Date().toISOString(); const id = randomUUID();
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,NULL)').run(id,url,device,'queued',now,now,null,parentId);
    return this.get(id)!;
  }
  list(): AuditJob[] {
    return this.db.prepare('SELECT id,url,device,status,createdAt,updatedAt,error,parentId FROM jobs ORDER BY createdAt DESC,rowid DESC LIMIT 200').all() as unknown as AuditJob[];
  }
  get(id: string): AuditJob | undefined {
    return this.db.prepare('SELECT id,url,device,status,createdAt,updatedAt,error,parentId FROM jobs WHERE id=?').get(id) as unknown as AuditJob|undefined;
  }
  result(id: string): unknown {
    const row = this.db.prepare("SELECT result FROM jobs WHERE id=? AND status='succeeded'").get(id) as {result:string}|undefined;
    if (!row) throw new Error('Rezultat još nije dostupan.');
    return JSON.parse(row.result);
  }
  cancel(id: string) {
    this.ensureWritable();
    const changed = this.db.prepare("UPDATE jobs SET status='cancelled',updatedAt=? WHERE id=? AND status='queued'").run(new Date().toISOString(),id);
    if (!changed.changes) throw new Error('Otkazivanje je dostupno dok posao čeka u redu.');
    return this.get(id);
  }
  retry(id: string) {
    const job = this.get(id);
    if (!job || !['failed','interrupted','cancelled'].includes(job.status)) throw new Error('Ovaj posao nije moguće ponoviti.');
    return this.enqueue(job,id);
  }
  private kick() {
    if (this.active || this.stopped || this.fatal) return;
    this.active = this.runNext().catch(e=>{this.fatal = e instanceof Error ? e : new Error(String(e)); console.error('Red analiza je zaustavljen:',this.fatal.message);}).finally(()=>{this.active=undefined;});
  }
  private async runNext() {
    const row = this.db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY createdAt,rowid LIMIT 1").get() as {id:string}|undefined;
    if (!row) return;
    this.db.prepare("UPDATE jobs SET status='running',updatedAt=? WHERE id=?").run(new Date().toISOString(),row.id);
    const job = this.get(row.id)!;
    let result: unknown;
    try { result = await this.execute(job); }
    catch (e) {
      this.db.prepare("UPDATE jobs SET status='failed',updatedAt=?,error=? WHERE id=?")
        .run(new Date().toISOString(),(e instanceof Error ? e.message : 'Analiza nije uspela.').slice(0,2000),job.id);
      return;
    }
    // Result and completion status commit together, so success never points at a missing result.
    this.db.prepare("UPDATE jobs SET status='succeeded',updatedAt=?,result=? WHERE id=?")
      .run(new Date().toISOString(),JSON.stringify(result),job.id);
  }
  async close() {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    await this.active;
    this.db.prepare('DELETE FROM worker WHERE id=1 AND pid=?').run(process.pid);
    this.db.close();
  }
}
