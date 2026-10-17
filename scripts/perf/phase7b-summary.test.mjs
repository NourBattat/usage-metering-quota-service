import test from 'node:test';
import assert from 'node:assert/strict';
import {median,observations} from './phase7b-summary.mjs';
test('median handles odd, even and missing samples without mutation',()=>{
  const input=[3,1,2];assert.equal(median(input),2);assert.deepEqual(input,[3,1,2]);assert.equal(median([4,2]),3);assert.equal(median([]),null);
});
function sample(t,cpu,acquisitions,ms) { return {backend:{monotonic_ms:t,pool:{max:10,total:10,idle:0,checked_out:10,waiting:20,acquisitions,acquisition_ms:ms,queued_acquisitions:acquisitions},cgroup_cpu_stat:`usage_usec ${cpu}\nnr_throttled 2`,memory:{rss:100},cgroup_memory_current:200},postgres:{at_utc:new Date(t).toISOString(),cpu_stat:`usage_usec ${cpu}\nnr_throttled 3`,memory_current:300},sessions:[{state:'active',wait_event_type:'Lock',wait_event:'transactionid',sessions:9,blocked:9}]}; }
test('observation rates use counter deltas and actual sample intervals',()=>{
  const result=observations([sample(1000,100000,10,50),sample(2000,600000,20,150)]);
  assert.equal(result.backend_cpu_percent_one_core,50);assert.equal(result.postgres_cpu_percent_one_core,50);
  assert.equal(result.mean_acquisition_ms,10);assert.equal(result.pool_peak_waiting,20);assert.equal(result.pg_peak_lock_wait,9);
  assert.equal(result.wait_events_peak_sessions['active/Lock/transactionid'],9);
});
test('one observation never fabricates a CPU rate or acquisition average',()=>{
  const result=observations([sample(1000,100000,10,50)]);assert.equal(result.postgres_cpu_percent_one_core,null);assert.equal(result.mean_acquisition_ms,null);
  assert.throws(()=>observations([]));
});
