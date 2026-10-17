import assert from 'node:assert/strict';
import { writeFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
assert.equal(process.env.PERF_ISOLATED,'1');
// A benchmark-only sampler reads the isolated PostgreSQL container's cgroup files.
const target=process.env.PERF_POSTGRES_CONTAINER;
assert.match(target ?? '',/^usage-perf-[a-f0-9]{12}-postgres-1$/);
const read=path=>execFileSync('docker',['exec',target,'cat',path],{encoding:'utf8',timeout:5000});
while (true) {
  const value={at_utc:new Date().toISOString(),cpu_stat:read('/sys/fs/cgroup/cpu.stat'),memory_current:Number(read('/sys/fs/cgroup/memory.current'))};
  await writeFile(process.env.PERF_TELEMETRY+'/postgres.tmp',JSON.stringify(value),{mode:0o600});
  await rename(process.env.PERF_TELEMETRY+'/postgres.tmp',process.env.PERF_TELEMETRY+'/postgres.json');
  await new Promise(resolve=>setTimeout(resolve,1000));
}
