import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { report as baselineReport } from './report.mjs';
import { report as contentionReport } from './phase7b-report.mjs';
import { observations } from './phase7b-summary.mjs';
import { finalReport } from './final-report.mjs';

export const inputFiles = ['performance/baseline.json', 'performance/phase7b-tmpfs.json',
  'performance/phase7b-disk.json', 'performance/phase7b-verification.json',
  'performance/README.md', 'performance/phase7b-report.md'];
export const sha256 = text => createHash('sha256').update(text).digest('hex');
function close(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)), label);
}
function statistics(measured, samples) {
  assert.ok(samples.length > 0 && samples.every(n => Number.isFinite(n) && n >= 0), 'Invalid latency samples');
  assert.ok(Number.isFinite(measured.duration_seconds) && measured.duration_seconds > 0, 'Invalid duration');
  assert.equal(measured.total_requests, samples.length, 'Latency sample count');
  close(measured.throughput_rps, samples.length / measured.duration_seconds, 'Throughput formula');
  const sorted = [...samples].sort((a, b) => a - b);
  for (const [key, fraction] of [['p50', 0.5], ['p95', 0.95], ['p99', 0.99]]) {
    assert.equal(measured.latency_ms[key], sorted[Math.ceil(samples.length * fraction) - 1], `Nearest-rank ${key}`);
  }
  assert.equal(measured.latency_ms.minimum, sorted[0], 'Minimum latency');
  assert.equal(measured.latency_ms.maximum, sorted.at(-1), 'Maximum latency');
  close(measured.latency_ms.average, samples.reduce((a, b) => a + b, 0) / samples.length, 'Average latency');
}
function accountEvidence(account, accepted, rejected, users, allowance) {
  assert.equal(account.status, 'PASS', 'Saved account audit failed');
  assert.deepEqual(account.failures, [], 'Saved audit failures');
  assert.equal(account.accepted_decisions, accepted, 'Accepted history count');
  assert.equal(account.rejected_decisions, rejected, 'Rejected history count');
  assert.equal(account.original_decisions, accepted + rejected, 'Original history count');
  assert.equal(BigInt(account.account_units), BigInt(accepted), 'Account counter / accepted units');
  assert.ok(BigInt(account.account_units) <= BigInt(allowance), 'Account allowance');
  assert.equal(account.user_units.length, users.length, 'User counter count');
  for (let i = 0; i < users.length; i++) {
    assert.equal(account.user_units[i].user, i + 1, 'User audit ordering');
    if (users[i] !== null) assert.equal(BigInt(account.user_units[i].used_units), BigInt(users[i]), 'Independent user counter');
    else assert.ok(BigInt(account.user_units[i].used_units) >= 5n && BigInt(account.user_units[i].used_units) <= 55n, 'Mixed-workload user attempt bounds');
    assert.ok(BigInt(account.user_units[i].used_units) <= BigInt(allowance), 'User allowance');
  }
  assert.equal(account.user_units.reduce((sum, u) => sum + BigInt(u.used_units), 0n), BigInt(account.account_units), 'User/account sum');
  assert.equal(account.utc_months.length, 1, 'UTC month count');
  assert.match(account.utc_months[0], /^\d{4}-\d{2}-01$/, 'UTC month format');
}
const distribution = (total, size) => Array.from({ length: size }, (_, i) => Math.floor(total / size) + (i < total % size ? 1 : 0));

export function validateDataset(data, kind) {
  const baseline = kind === 'baseline';
  assert.ok(['baseline', 'tmpfs', 'disk'].includes(kind));
  assert.equal(data.status, 'PASS');
  assert.equal(data.predefined_plans_unchanged, true);
  assert.equal(data.verification.status, 'PASS');
  for (const key of ['build','unit','isolation','database_regressions','benchmarks','cleanup','main_preserved','private_files_removed']) assert.equal(data.verification.checks[key], 'PASS', `Environment check ${key}`);
  const config = data.configuration;
  assert.equal(config.requests_per_trial, 500); assert.equal(config.repeats, 3); assert.equal(config.units, 1);
  assert.equal(baseline ? config.warmup_requests_per_trial : config.warmup, 50);
  assert.equal(baseline ? config.timeout_ms : config.request_timeout_ms, 5000);
  assert.equal(baseline ? config.scenario_deadline_ms : config.batch_deadline_ms, 120000);
  assert.equal(data.trials.length, baseline ? 24 : 44, 'Completed trial count');
  if (!baseline) {
    assert.equal(data.storage, kind); assert.equal(config.sustained_duration_ms, 60000); assert.equal(config.sustained_max_requests, 20000);
    assert.equal(config.window_ms, 5000); assert.equal(config.sampling_ms, 250);
  }
  if (baseline) assert.deepEqual(config.definitions.map(d=>[d.id,d.concurrency,d.users]), [['A',1,1],['B',5,1],['C',20,1],['D',50,1],['E',20,10],['F',20,1],['G',20,1],['H',20,1]]);
  const keys = new Set();
  const totals = { completed_runs: data.trials.length, measured_requests: 0, warmup_requests: data.trials.length * 50,
    accepted: 0, rejected: 0, replays: 0, http_errors: 0, transport_errors: 0, timeouts: 0,
    warmup_accepted: 0, warmup_rejected: 0, stored_original_decisions: 0, charged_units_including_warmup: 0 };
  const baselineConcurrencies = { A: 1, B: 5, C: 20, D: 50, E: 20, F: 20, G: 20, H: 20 };
  for (const trial of data.trials) {
    const m = trial.measured;
    statistics(m, m.latencies_ms);
    for (const key of ['accepted', 'quota_rejected', 'idempotent_replays', 'http_errors', 'network_errors', 'timeouts']) {
      assert.ok(Number.isInteger(m[key]) && m[key] >= 0, `Invalid ${key}`);
    }
    assert.equal(m.accepted + m.quota_rejected + m.idempotent_replays + m.http_errors + m.network_errors + m.timeouts, m.total_requests, 'Disjoint outcomes');
    assert.equal(m.http_errors + m.network_errors + m.timeouts, 0, 'Unexpected HTTP/transport failure or timeout');
    assert.equal(m.accepted_http_responses, m.accepted + m.idempotent_replays, 'HTTP 200 count');
    assert.equal(trial.correctness.status, 'PASS'); assert.deepEqual(trial.correctness.failures, []);
    let accepted, rejected, replays = 0, warmingAccepted = 50, warmingRejected = 0, accounts;
    if (baseline) {
      assert.ok(Object.hasOwn(baselineConcurrencies, trial.scenario), 'Unknown baseline scenario');
      assert.ok([1, 2, 3].includes(trial.repeat)); assert.equal(trial.concurrency, baselineConcurrencies[trial.scenario]);
      assert.equal(trial.users, trial.scenario === 'E' ? 10 : 1);
      keys.add(`${trial.scenario}/${trial.repeat}`);
      assert.equal(m.total_requests, 500);
      const id = trial.scenario;
      accepted = id === 'H' ? 0 : id === 'G' ? 1 : ['E', 'F'].includes(id) ? 250 : 500;
      rejected = id === 'H' ? 500 : ['E', 'F'].includes(id) ? 250 : 0;
      replays = id === 'G' ? 499 : 0;
      warmingAccepted = id === 'H' ? 0 : 50; warmingRejected = id === 'H' ? 50 : 0;
      assert.deepEqual(trial.warmup, { requests: 50, accepted: warmingAccepted, rejected: warmingRejected });
      accounts = [trial.correctness];
      // E acceptance order is concurrent; saved per-user history is unavailable offline.
      accountEvidence(accounts[0], accepted + warmingAccepted, rejected + warmingRejected,
        id === 'E' ? Array(10).fill(null) : distribution(accepted + warmingAccepted, trial.users), ['E', 'F'].includes(id) ? 300 : 560);
    } else {
      assert.ok(['A', 'B', 'C'].includes(trial.layout));
      assert.equal(trial.sustained, trial.experiment === 'sustained');
      assert.equal(typeof trial.reject, 'boolean');
      if (trial.experiment === 'contention') {
        assert.ok([1, 5, 20, 50].includes(trial.concurrency)); assert.ok([1, 2, 3].includes(trial.repeat)); assert.equal(trial.reject, false);
      } else if (trial.experiment === 'quota-cost') {
        assert.equal(trial.layout, 'A'); assert.equal(trial.concurrency, 20); assert.ok([1, 2, 3].includes(trial.repeat));
      } else {
        assert.equal(trial.experiment, 'sustained'); assert.ok(['A', 'C'].includes(trial.layout));
        assert.equal(trial.concurrency, 20); assert.equal(trial.repeat, 1); assert.equal(trial.reject, false);
      }
      keys.add(`${trial.experiment}/${trial.layout}/${trial.concurrency}/${trial.repeat}/${trial.reject}`);
      if (trial.sustained) { assert.ok(m.total_requests > 0 && m.total_requests < 20000); assert.ok(m.duration_seconds >= 60 && m.duration_seconds < 66); }
      else assert.equal(m.total_requests, 500);
      accepted = trial.reject ? 0 : m.total_requests; rejected = trial.reject ? m.total_requests : 0;
      warmingAccepted = trial.reject ? 0 : 50; warmingRejected = trial.reject ? 50 : 0;
      accounts = trial.correctness.accounts;
      const count = trial.layout === 'C' ? 10 : 1;
      assert.equal(accounts.length, count);
      const measuredSplit = distribution(m.total_requests, count), warmSplit = distribution(50, count);
      accounts.forEach((account, i) => accountEvidence(account, trial.reject ? 0 : measuredSplit[i] + warmSplit[i],
        trial.reject ? measuredSplit[i] + warmSplit[i] : 0,
        distribution(trial.reject ? 0 : measuredSplit[i] + warmSplit[i], trial.layout === 'B' ? 10 : 1), 20100));
      assert.deepEqual(observations(trial.observations), trial.observation_summary, 'Cached observation summary');
      for (const sample of trial.observations) {
        const p = sample.backend.pool;
        assert.equal(p.max, 10); assert.equal(p.connection_timeout_ms, 5000); assert.equal(p.idle_timeout_ms, 30000);
        assert.ok(p.total <= 10 && p.idle <= p.total && p.waiting >= 0); assert.equal(p.checked_out, p.total - p.idle);
      }
      let offset = 0;
      for (let i = 0; i < m.windows.length; i++) {
        const window = m.windows[i]; assert.equal(window.start_seconds, i * 5);
        close(window.duration_seconds, Math.min(5, m.duration_seconds - i * 5), 'Completion window duration');
        assert.equal(window.errors + window.timeouts, 0);
        if (window.total_requests) statistics(window, m.latencies_ms.slice(offset, offset + window.total_requests));
        else { assert.equal(window.throughput_rps, 0); assert.equal(window.latency_ms, null); }
        offset += window.total_requests;
      }
      assert.equal(m.windows.length, Math.ceil(m.duration_seconds / 5)); assert.equal(offset, m.total_requests, 'Completion windows cover all samples');
    }
    assert.equal(m.accepted, accepted); assert.equal(m.quota_rejected, rejected); assert.equal(m.idempotent_replays, replays);
    totals.measured_requests += m.total_requests; totals.accepted += accepted; totals.rejected += rejected; totals.replays += replays;
    totals.warmup_accepted += warmingAccepted; totals.warmup_rejected += warmingRejected;
    totals.stored_original_decisions += accounts.reduce((sum, a) => sum + a.original_decisions, 0);
    totals.charged_units_including_warmup += accounts.reduce((sum, a) => sum + Number(a.account_units), 0);
  }
  assert.equal(keys.size, data.trials.length, 'Missing/duplicate configuration or repetition');
  assert.equal(totals.stored_original_decisions, totals.measured_requests - totals.replays + totals.warmup_requests);
  assert.equal(totals.charged_units_including_warmup, totals.accepted + totals.warmup_accepted);
  return { status: 'PASS', ...totals };
}

export function assertNoReportSecret(text, knownSecrets = []) {
  if (knownSecrets.some(secret => secret.length >= 16 && text.includes(secret))
    || /["'](?:api_key|provisioning_token|postgres_password|pgpassword)["']\s*:\s*["'][A-Za-z0-9_-]{32,}["']/i.test(text)) {
    throw new Error('Potential sensitive content in report; values withheld');
  }
}
async function scanReports(finalText) {
  let local = '';
  try { local = await readFile('.env', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const known = local.split('\n').filter(line => /^(?:POSTGRES_PASSWORD|PROVISIONING_TOKEN|USAGE_API_KEY)=/.test(line))
    .map(line => line.slice(line.indexOf('=') + 1).trim().replace(/^(["'])(.*)\1$/, '$2'));
  const paths = ['README.md'];
  for (const directory of ['docs', 'performance']) for (const file of await readdir(directory, { withFileTypes: true })) {
    if (file.isFile() && /\.(md|json|txt)$/.test(file.name)) paths.push(`${directory}/${file.name}`);
  }
  for (const path of paths) assertNoReportSecret(await readFile(path, 'utf8'), known);
  assertNoReportSecret(finalText, known);
  return { status: 'PASS', files_checked: paths.length, scope: 'Known local environment values and credential-valued JSON/Markdown fields; not a universal secret detector.' };
}

export async function validateSavedResults() {
  const texts = Object.fromEntries(await Promise.all(inputFiles.map(async path => [path, await readFile(path, 'utf8')])));
  const inputs = Object.fromEntries(inputFiles.map(path => [path, sha256(texts[path])]));
  const datasets = ['baseline', 'phase7b-tmpfs', 'phase7b-disk'].map(name => JSON.parse(texts[`performance/${name}.json`]));
  const summaries = datasets.map((d, i) => validateDataset(d, ['baseline', 'tmpfs', 'disk'][i]));
  const previous = JSON.parse(texts['performance/phase7b-verification.json']);
  assert.equal(previous.status, 'PASS'); assert.equal(previous.phase7a_preserved, true);
  assert.deepEqual(previous.phase7a_files_before, previous.phase7a_files_after);
  for (const [path, hash] of Object.entries(previous.phase7a_files_after)) assert.equal(sha256(await readFile(path)), hash, 'Historical Phase 7A preservation fingerprint');
  assert.equal(baselineReport(datasets[0]), texts['performance/README.md'], 'Phase 7A Markdown differs from saved measurements/render');
  assert.equal(contentionReport(datasets.slice(1), previous), texts['performance/phase7b-report.md'], 'Phase 7B Markdown differs from saved measurements/render');
  const result = { status: 'PASS', validated_at_utc: new Date().toISOString(), input_sha256: inputs,
    phase7a: summaries[0], phase7b_tmpfs: summaries[1], phase7b_disk: summaries[2],
    historical_reports_match_render: true, raw_files_unchanged: true, measurement_inconsistencies: [], targeted_rerun_needed: false,
    evidence_limits: ['Original disposable databases and full HTTP decision bodies are not retained; persisted runtime audit summaries are validated, not the deleted databases.',
      'Completion-window membership is reconstructed from completion-ordered latency samples and saved window counts; original completion timestamps are not retained.',
      'Phase 7B warmup outcomes are inferred from saved original-decision audit counts and checked against the fixed workload; no separate per-trial warmup HTTP log is retained.',
      'Archived Phase 6/7A documents describe status at their recording time; their later-phase-not-started wording is historical.'] };
  for (const path of inputFiles) assert.equal(sha256(await readFile(path)), inputs[path], 'Input changed during validation');
  let verification;
  try { verification=JSON.parse(await readFile('performance/phase7c-verification.json','utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
  const markdown=finalReport(datasets,result,verification);
  result.report_secret_scan=await scanReports(markdown);
  await writeFile('performance/phase7c-validation.json', JSON.stringify(result, null, 2) + '\n');
  await writeFile('performance/final-report.md', markdown);
  console.log(JSON.stringify({ status: result.status, phase7a: summaries[0], phase7b_tmpfs: summaries[1], phase7b_disk: summaries[2], targeted_rerun_needed: false }, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await validateSavedResults(); } catch { console.error('Saved performance validation FAILED. Existing measurements were not changed.'); process.exitCode = 1; }
}
