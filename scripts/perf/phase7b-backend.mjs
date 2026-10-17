import assert from 'node:assert/strict';
import { writeFile, rename, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pool } from '../../dist/db/pool.js';
import { buildApp } from '../../dist/app.js';
assert.equal(process.env.PERF_ISOLATED, '1');
assert.match(process.env.PGDATABASE ?? '', /^usage_perf_[a-f0-9]{12}$/);
assert.equal(process.env.PGHOST, 'postgres');
// Benchmark-only observation. Preserve callback/Promise behavior and all pool settings.
const connect = pool.connect.bind(pool);
let acquisitions = 0, acquisitionMs = 0, maxAcquisitionMs = 0, queuedAcquisitions = 0;
pool.connect = function(callback) {
  const start = performance.now();
  if (pool.idleCount === 0 && pool.totalCount >= pool.options.max) queuedAcquisitions++;
  const record = () => { const ms = performance.now()-start; acquisitions++; acquisitionMs+=ms; maxAcquisitionMs=Math.max(maxAcquisitionMs,ms); };
  if (typeof callback === 'function') return connect((error,client,release) => { record(); callback(error,client,release); });
  return connect().then(client => { record(); return client; },error=>{ record(); throw error; });
};
const app = buildApp();
await app.listen({host:'0.0.0.0',port:3000});
let busy = false;
const timer = setInterval(async () => {
  if (busy) return; busy=true;
  try {
    const metrics = { at_utc:new Date().toISOString(), monotonic_ms:performance.now(), pool:{ max:pool.options.max,
      connection_timeout_ms:pool.options.connectionTimeoutMillis, idle_timeout_ms:pool.options.idleTimeoutMillis,
      total:pool.totalCount,idle:pool.idleCount,checked_out:pool.totalCount-pool.idleCount,waiting:pool.waitingCount,
      acquisitions,acquisition_ms:acquisitionMs,max_acquisition_ms:maxAcquisitionMs,queued_acquisitions:queuedAcquisitions },
      process_cpu_us:process.cpuUsage(),memory:process.memoryUsage(),
      cgroup_cpu_stat:await readFile('/sys/fs/cgroup/cpu.stat','utf8'),
      cgroup_memory_current:Number(await readFile('/sys/fs/cgroup/memory.current','utf8')) };
    await writeFile('/telemetry/current.tmp',JSON.stringify(metrics),{mode:0o600});
    await rename('/telemetry/current.tmp','/telemetry/current.json');
  } finally { busy=false; }
},100);
timer.unref();
