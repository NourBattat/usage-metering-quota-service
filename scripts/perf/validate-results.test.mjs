import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDataset, assertNoReportSecret } from './validate-results.mjs';
const baseline = JSON.parse(readFileSync(new URL('../../performance/baseline.json', import.meta.url), 'utf8'));
const tmpfs = JSON.parse(readFileSync(new URL('../../performance/phase7b-tmpfs.json', import.meta.url), 'utf8'));
// Resolve relative to scripts/perf rather than the caller's working directory.
test('saved original runs validate with separated measured, warmup and replay counts', () => {
  const result=validateDataset(baseline,'baseline');
  assert.equal(result.completed_runs,24); assert.equal(result.measured_requests,12000);
  assert.equal(result.warmup_requests,1200); assert.equal(result.replays,1497);
});
test('corrupted percentile and throughput cannot be accepted as saved evidence', () => {
  for(const corrupt of [d=>d.trials[0].measured.latency_ms.p95++, d=>d.trials[0].measured.throughput_rps++]) {
    const d=structuredClone(baseline);corrupt(d);assert.throws(()=>validateDataset(d,'baseline'));
  }
});
test('duplicate repetition and a replay charged as an original acceptance fail validation', () => {
  const duplicate=structuredClone(baseline);duplicate.trials[1]=structuredClone(duplicate.trials[0]);
  assert.throws(()=>validateDataset(duplicate,'baseline'));
  const charged=structuredClone(baseline);const replay=charged.trials.find(t=>t.scenario==='G');
  replay.correctness.account_units='550';assert.throws(()=>validateDataset(charged,'baseline'));
});
test('altered rejection counters and missing preservation checks fail validation', () => {
  const charged=structuredClone(baseline);charged.trials.find(t=>t.scenario==='H').correctness.user_units[0].used_units='1';
  assert.throws(()=>validateDataset(charged,'baseline'));
  const missing=structuredClone(baseline);delete missing.verification.checks.main_preserved;
  assert.throws(()=>validateDataset(missing,'baseline'));
});
test('altered completion windows and cached pool observations fail validation', () => {
  const window=structuredClone(tmpfs);window.trials[0].measured.windows[0].latency_ms.p99++;
  assert.throws(()=>validateDataset(window,'tmpfs'));
  const pool=structuredClone(tmpfs);pool.trials[0].observation_summary.pool_peak_waiting++;
  assert.throws(()=>validateDataset(pool,'tmpfs'));
});

test('report scan rejects known credentials and credential-valued fields without echoing them', () => {
  const fake='x'.repeat(43);
  assert.throws(()=>assertNoReportSecret('value='+fake,[fake]), /values withheld/);
  assert.throws(()=>assertNoReportSecret(JSON.stringify({api_key:fake})), /values withheld/);
  assert.doesNotThrow(()=>assertNoReportSecret('api_key is supplied privately; sha256: '+'a'.repeat(64)));
});
