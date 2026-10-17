export function median(values) {
  if(!values.length) return null;
  const s=values.toSorted((a,b)=>a-b),i=Math.floor(s.length/2);
  return s.length%2?s[i]:(s[i-1]+s[i])/2;
}
const counter=(text,key)=>Number(text.split('\n').find(line=>line.startsWith(key+' '))?.split(' ')[1]??0);
export function observations(samples) {
  if (!samples.length) throw new Error('Missing observations');
  const first=samples[0], last=samples.at(-1);
  const backendElapsed=last.backend.monotonic_ms-first.backend.monotonic_ms;
  const pgElapsed=Date.parse(last.postgres.at_utc)-Date.parse(first.postgres.at_utc);
  const acquisitions=last.backend.pool.acquisitions-first.backend.pool.acquisitions;
  const events={};
  for(const s of samples) for(const row of s.sessions) {
    const key=`${row.state}/${row.wait_event_type??'none'}/${row.wait_event??'none'}`;
    events[key]=Math.max(events[key]??0,row.sessions);
  }
  const peak=fn=>Math.max(...samples.map(fn));
  return {samples:samples.length,pool_max:last.backend.pool.max,pool_peak_total:peak(s=>s.backend.pool.total),
    pool_peak_checked_out:peak(s=>s.backend.pool.checked_out),pool_peak_idle:peak(s=>s.backend.pool.idle),pool_peak_waiting:peak(s=>s.backend.pool.waiting),
    sampled_acquisitions:acquisitions,queued_acquisitions_delta:last.backend.pool.queued_acquisitions-first.backend.pool.queued_acquisitions,
    mean_acquisition_ms:acquisitions>0?(last.backend.pool.acquisition_ms-first.backend.pool.acquisition_ms)/acquisitions:null,
    pg_peak_active:peak(s=>s.sessions.filter(r=>r.state==='active').reduce((n,r)=>n+r.sessions,0)),
    pg_peak_idle:peak(s=>s.sessions.filter(r=>r.state==='idle').reduce((n,r)=>n+r.sessions,0)),
    pg_peak_lock_wait:peak(s=>s.sessions.filter(r=>r.wait_event_type==='Lock').reduce((n,r)=>n+r.sessions,0)),
    pg_peak_blocked:peak(s=>s.sessions.reduce((n,r)=>n+r.blocked,0)),wait_events_peak_sessions:events,
    backend_cpu_percent_one_core:backendElapsed>0?(counter(last.backend.cgroup_cpu_stat,'usage_usec')-counter(first.backend.cgroup_cpu_stat,'usage_usec'))/backendElapsed/10:null,
    postgres_cpu_percent_one_core:pgElapsed>0?(counter(last.postgres.cpu_stat,'usage_usec')-counter(first.postgres.cpu_stat,'usage_usec'))/pgElapsed/10:null,
    backend_throttled_periods:counter(last.backend.cgroup_cpu_stat,'nr_throttled')-counter(first.backend.cgroup_cpu_stat,'nr_throttled'),
    postgres_throttled_periods:counter(last.postgres.cpu_stat,'nr_throttled')-counter(first.postgres.cpu_stat,'nr_throttled'),
    backend_peak_rss_bytes:peak(s=>s.backend.memory.rss),backend_peak_cgroup_bytes:peak(s=>s.backend.cgroup_memory_current),
    postgres_peak_cgroup_bytes:peak(s=>s.postgres.memory_current)};
}
