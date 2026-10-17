import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { inputFiles, sha256 } from './validate-results.mjs';
const protectedFiles=[...inputFiles,'src/routes/consumptions.ts','src/db/pool.ts','Dockerfile','compose.yaml'];
const fingerprints=async()=>Object.fromEntries(await Promise.all(protectedFiles.map(async path=>[path,sha256(await readFile(path))])));
const protectedBefore=await fingerprints();

const root = process.cwd();
const directory = await mkdtemp(join(os.tmpdir(), 'usage-perf-'));
const nonce = randomBytes(6).toString('hex');
const project = `usage-perf-${nonce}`;
const env = { ...process.env, POSTGRES_DB: `usage_perf_${nonce}`, POSTGRES_USER: 'performance',
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'), PROVISIONING_TOKEN: randomBytes(32).toString('hex') };
const evidence = { status: 'RUNNING', checks: {}, started_at_utc: new Date().toISOString() };
function run(args, capture = false) {
  if (!capture) console.log(`COMMAND ${args.join(' ')}`);
  const result = spawnSync(args[0], args.slice(1), { cwd: root, env, encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, stdio: capture ? ['ignore','pipe','pipe'] : 'inherit', timeout: 600000 });
  if (result.error || result.status !== 0) throw new Error(`Command ${args[0]} ${args[1] ?? ''} failed; captured diagnostics withheld to protect secrets`);
  return result.stdout;
}
const inspect = id => JSON.parse(run(['docker','inspect',id], true))[0];
let config, mainPg, mainBackend, before, volumes, volumeBefore, inventoryBefore, started = false;

function sql(query) {
  return run(['docker','exec',mainPg.Id,'sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt -v ON_ERROR_STOP=1 -c "$1"','sh',query], true);
}
function fingerprint() {
  return ['accounts','users','account_plans','user_plans','account_monthly_usage','user_monthly_usage','consumption_requests','pgmigrations']
    .map(table => sql(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]')) FROM ${table} t`)).join(':');
}
try {
  config = JSON.parse(run(['docker','compose','config','--format','json'], true));
  mainPg = inspect(`${config.name}-postgres-1`); mainBackend = inspect(`${config.name}-backend-1`);
  before = fingerprint(); inventoryBefore = sql('SELECT datname FROM pg_database ORDER BY datname');
  volumes = mainPg.Mounts.filter(m => m.Type === 'volume').map(m => m.Name); assert.ok(volumes.length);
  volumeBefore = run(['docker','volume','inspect',...volumes], true);
  config.name = project; config.networks = { default: { name: `${project}_default` } }; config.volumes = {};
  config.services = Object.fromEntries(['postgres','migrate','backend'].map(name => [name,config.services[name]]));
  config.services.postgres.volumes = []; config.services.postgres.tmpfs = ['/var/lib/postgresql/data'];
  for (const name of ['backend','migrate']) {
    Object.assign(config.services[name], { image: `${project}-backend:phase7c`, build: { context: root, dockerfile: 'Dockerfile', target: 'runtime' }, volumes: [] });
  }
  config.services.backend.ports = [];
  for (const name of ['postgres','backend']) Object.assign(config.services[name], { cpus: 1, mem_limit: name === 'postgres' ? '512m' : '256m', restart: 'no' });
  const configFile = join(directory,'compose.json'); await writeFile(configFile,JSON.stringify(config),{mode:0o600});
  env.COMPOSE_FILE = configFile; env.COMPOSE_PROJECT_NAME = project;
  run(['npm','run','build']); evidence.checks.build = 'PASS';
  run(['npm','test']); evidence.checks.unit = 'PASS';
  run(['docker','compose','build','backend']);
  started = true; run(['docker','compose','up','-d','backend']);
  const backendId = run(['docker','compose','ps','-q','backend'],true).trim();
  const pgId = run(['docker','compose','ps','-q','postgres'],true).trim();
  for (let i=0; ;i++) {
    if (inspect(backendId).State.Health?.Status === 'healthy') break;
    assert.ok(i < 180,'Isolated backend health timeout'); await new Promise(resolve => setTimeout(resolve,500));
  }
  const isolatedPg = inspect(pgId); const isolatedBackend = inspect(backendId);
  assert.notEqual(pgId,mainPg.Id); assert.notEqual(backendId,mainBackend.Id);
  assert.ok(Object.hasOwn(isolatedPg.HostConfig.Tmpfs,'/var/lib/postgresql/data'));
  run(['docker','exec',pgId,'awk','$2=="/var/lib/postgresql/data" && $3=="tmpfs" {ok=1} END {exit !ok}','/proc/mounts'],true);
  for (const container of [isolatedPg,isolatedBackend]) {
    assert.deepEqual(Object.keys(container.NetworkSettings.Networks),[`${project}_default`]);
    assert.ok(container.Mounts.every(m => m.Type === 'tmpfs'));
    assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length,0);
  }
  evidence.checks.isolation = 'PASS';
  const inventory = () => run(['docker','compose','exec','-T','postgres','psql','-U',env.POSTGRES_USER,'-d',env.POSTGRES_DB,'-qAt','-c','SELECT datname FROM pg_database ORDER BY datname'],true);
  const dbBefore = inventory(); run(['npm','run','test:db:isolated']); assert.equal(inventory(),dbBefore); evidence.checks.database_regressions = 'PASS';
  evidence.docker = JSON.parse(run(['docker','info','--format','{{json .}}'],true));
  evidence.docker = Object.fromEntries(['ServerVersion','NCPU','MemTotal','Driver','OSType','Architecture'].map(k=>[k,evidence.docker[k]]));
  evidence.host = { node: process.version, cpu_models: [...new Set(os.cpus().map(c=>c.model))], cpu_count: os.cpus().length, memory_bytes: os.totalmem(), kernel:os.release() };
  evidence.containers = Object.fromEntries([['postgres',isolatedPg],['backend',isolatedBackend]].map(([name,c])=>[name,{ image:c.Config.Image, image_id:c.Image, nano_cpus:c.HostConfig.NanoCpus, memory_bytes:c.HostConfig.Memory, log_driver:c.HostConfig.LogConfig.Type }]));
  evidence.backend_node = run(['docker','exec',backendId,'node','--version'],true).trim();
  evidence.source_commit = run(['git','rev-parse','HEAD'],true).trim();
  evidence.storage = 'Disposable PostgreSQL tmpfs; no persistent volumes or host ports';
  run(['npm','run','perf:validate']); evidence.checks.saved_results_validation='PASS';
  run(['git','diff','--exit-code','--','src','client','migrations','Dockerfile','compose.yaml','package-lock.json'],true);
  evidence.checks.production_diff='PASS';
  evidence.status='PASS';
} catch (error) {
  evidence.status = 'FAILED'; evidence.failure = error.message;
  console.error(error.message); process.exitCode = 1;
} finally {
  try {
    if (started) {
      run(['docker','compose','down','--timeout','10']);
      assert.equal(run(['docker','ps','-aq','--filter',`label=com.docker.compose.project=${project}`],true).trim(),'');
      assert.equal(run(['docker','network','ls','-q','--filter',`label=com.docker.compose.project=${project}`],true).trim(),'');
      evidence.checks.cleanup = 'PASS';
    }
  } catch { evidence.checks.cleanup = 'FAILED'; evidence.status = 'FAILED'; process.exitCode = 1; }
  try {
    assert.ok(before); assert.equal(fingerprint(),before);
    assert.equal(sql('SELECT datname FROM pg_database ORDER BY datname'),inventoryBefore);
    assert.equal(run(['docker','volume','inspect',...volumes],true),volumeBefore);
    for (const original of [mainPg,mainBackend]) {
      const current = inspect(original.Name.slice(1)); assert.equal(current.Id,original.Id); assert.equal(current.State.Running,true); assert.equal(current.State.StartedAt,original.State.StartedAt); assert.equal(current.State.Health.Status,'healthy');
    }
    evidence.checks.main_preserved = 'PASS';
    evidence.main_container_start_times={postgres:mainPg.State.StartedAt,backend:mainBackend.State.StartedAt};
  } catch { evidence.checks.main_preserved = 'FAILED'; evidence.status = 'FAILED'; process.exitCode = 1; }
  await rm(directory,{recursive:true,force:true}); evidence.checks.private_files_removed = 'PASS';
  const protectedAfter=await fingerprints();
  evidence.protected_files_before=protectedBefore; evidence.protected_files_after=protectedAfter;
  try { assert.deepEqual(protectedAfter,protectedBefore); evidence.checks.saved_artifacts_preserved='PASS'; }
  catch { evidence.checks.saved_artifacts_preserved='FAILED'; evidence.status='FAILED'; process.exitCode=1; }
  evidence.finished_at_utc=new Date().toISOString();
  const serialized=JSON.stringify(evidence,null,2)+'\n';
  for(const secret of [env.POSTGRES_PASSWORD,env.PROVISIONING_TOKEN]) assert.ok(!serialized.includes(secret));
  await writeFile(join(root,'performance/phase7c-verification.json'),serialized);
}
console.log(`Phase 7C verification ${evidence.status}; no benchmark workloads executed.`);
