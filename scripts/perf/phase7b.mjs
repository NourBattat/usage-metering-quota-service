import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {report} from './phase7b-report.mjs';
const preserved=['performance/baseline.json','performance/README.md','scripts/perf/driver.mjs','scripts/perf/environment.mjs','scripts/perf/metrics.mjs','scripts/perf/report.mjs'];
const fingerprints=async()=>Object.fromEntries(await Promise.all(preserved.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));
const before=await fingerprints();
const results=[];
let failed=false;
try {
  for(const storage of ['tmpfs','disk']) {
    console.log(`COMMAND isolated Phase 7B ${storage}`);
    const launchedAt=Date.now();
    const child=spawnSync(process.execPath,['scripts/perf/phase7b-environment.mjs'],{env:{...process.env,PERF_STORAGE:storage},stdio:'inherit',timeout:1500000});
    try { const result=JSON.parse(await readFile(`performance/phase7b-${storage}.json`,'utf8'));
      assert.ok(Date.parse(result.verification.started_at_utc)>=launchedAt,'Stale artifact'); results.push(result); } catch { /* Failed startup may have no artifact. */ }
    assert.ifError(child.error);assert.equal(child.status,0,'Isolated experiment failed');
  }
} catch { failed=true; process.exitCode=1; }
finally {
  const after=await fingerprints();
  const verification={status:!failed&&results.length===2&&results.every(r=>r.status==='PASS')?'PASS':'FAILED',phase7a_files_before:before,phase7a_files_after:after,phase7a_preserved:JSON.stringify(before)===JSON.stringify(after)};
  if(!verification.phase7a_preserved) {verification.status='FAILED';process.exitCode=1;}
  if(verification.status!=='PASS') process.exitCode=1;
  await writeFile('performance/phase7b-verification.json',JSON.stringify(verification,null,2)+'\n');
  await writeFile('performance/phase7b-report.md',report(results,verification));
  console.log(`Phase 7B ${verification.status}; performance/phase7b-report.md`);
}
