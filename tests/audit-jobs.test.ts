import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AuditJobs } from '../src/audit-jobs.js';
import { startServer } from '../src/server.js';
async function until(fn:()=>boolean) {
  const deadline=Date.now()+5000;
  while (!fn()) { if(Date.now()>deadline) throw new Error('Timed out'); await new Promise(r=>setTimeout(r,25)); }
}
test('queue survives reopening, executes sequentially and commits persistent results',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'audit-queue-')); const path=join(dir,'jobs.sqlite');
  let queue:AuditJobs|undefined;
  try {
    queue=await AuditJobs.open(path,async()=>({}),false);
    const a=queue.enqueue({url:'https://example.com/one'});
    const b=queue.enqueue({url:'https://example.com/two',device:'desktop'});
    await assert.rejects(AuditJobs.open(path,async()=>({})),/Drugi servis/);
    await queue.close(); queue=undefined;
    const order:string[]=[]; let active=0;
    queue=await AuditJobs.open(path,async job=>{
      assert.equal(++active,1); order.push(job.id);
      await new Promise(r=>setTimeout(r,30)); active--; return {id:job.id,score:42};
    });
    await until(()=>queue!.get(b.id)?.status==='succeeded');
    assert.deepEqual(order,[a.id,b.id]);
    await queue.close(); queue=await AuditJobs.open(path,async()=>assert.fail('Completed jobs reran'));
    assert.deepEqual(queue.result(a.id),{id:a.id,score:42});
    assert.equal(queue.list().length,2);
  } finally {await queue?.close();await rm(dir,{recursive:true,force:true});}
});
test('interrupted attempts remain in history; retry creates a new job; cancelled jobs do not execute',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'audit-recovery-')); const path=join(dir,'jobs.sqlite');
  let queue:AuditJobs|undefined;
  try {
    queue=await AuditJobs.open(path,async()=>({}),false);
    const a=queue.enqueue({url:'https://example.com'}); await queue.close(); queue=undefined;
    const db=new DatabaseSync(path); db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(a.id); db.close();
    queue=await AuditJobs.open(path,async()=>{throw new Error('capture failure');},false);
    assert.equal(queue.get(a.id)?.status,'interrupted');
    const retry=queue.retry(a.id); assert.equal(retry.parentId,a.id); assert.notEqual(retry.id,a.id);
    const cancelled=queue.enqueue({url:'https://example.com/cancel'}); queue.cancel(cancelled.id);
    assert.throws(()=>queue.enqueue({url:'http://localhost'}));
    queue.start(); await until(()=>queue!.get(retry.id)?.status==='failed');
    assert.equal(queue.get(retry.id)?.error,'capture failure');
    assert.equal(queue.get(cancelled.id)?.status,'cancelled');
    assert.throws(()=>queue!.result(retry.id));
  } finally {await queue?.close();await rm(dir,{recursive:true,force:true});}
});
test('HTTP audit returns 202 and result remains available after server restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'audit-api-'));
  let h=await startServer({port:0,dataDirectory:dir,auditExecutor:async job=>({id:job.id,score:77})});
  try {
    const r=await fetch(h.url+'/api/audit/run',{method:'POST',headers:{'Content-Type':'application/json','X-MerchantPro-Request':'1'},body:JSON.stringify({url:'https://example.com'})});
    assert.equal(r.status,202); const job=await r.json();
    let done=false;
    for(let i=0;i<50;i++) {const result=await fetch(h.url+`/api/jobs/${job.id}/result`); if(result.ok){done=true;break;} await new Promise(r=>setTimeout(r,30));}
    assert.ok(done); await h.close();
    h=await startServer({port:0,dataDirectory:dir,auditExecutor:async()=>assert.fail('Unexpected rerun')});
    const result=await fetch(h.url+`/api/jobs/${job.id}/result`);
    assert.deepEqual(await result.json(),{id:job.id,score:77});
  } finally {await h.close();await rm(dir,{recursive:true,force:true});}
});

test('abrupt process exit recovers its running job and preserves queued work',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'audit-crash-')); const path=join(dir,'jobs.sqlite');
  let queue:AuditJobs|undefined;
  try {
    const code = `import { AuditJobs } from './src/audit-jobs.ts';
      const q = await AuditJobs.open(process.env.TEST_QUEUE_PATH,async()=>{process.exit(0)},false);
      q.enqueue({url:'https://example.com/running'});
      q.enqueue({url:'https://example.com/queued'});
      q.start(); setInterval(()=>{},1000);`;
    execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{
      env:{...process.env,TEST_QUEUE_PATH:path},timeout:10000,stdio:'pipe'});
    queue=await AuditJobs.open(path,async job=>({url:job.url}),false);
    assert.equal(queue.list().find(j=>j.url.endsWith('/running'))?.status,'interrupted');
    const queued=queue.list().find(j=>j.url.endsWith('/queued'))!;
    assert.equal(queued.status,'queued'); queue.start();
    await until(()=>queue!.get(queued.id)?.status==='succeeded');
  } finally {await queue?.close();await rm(dir,{recursive:true,force:true});}
});
