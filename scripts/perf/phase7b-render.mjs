import {readFile,writeFile} from 'node:fs/promises';
import {report} from './phase7b-report.mjs';
const results=await Promise.all(['tmpfs','disk'].map(async mode=>JSON.parse(await readFile(`performance/phase7b-${mode}.json`,'utf8'))));
const verification=JSON.parse(await readFile('performance/phase7b-verification.json','utf8'));
await writeFile('performance/phase7b-report.md',report(results,verification));
console.log('Rendered Phase 7B report from existing measurements; no workload executed.');
