import 'dotenv/config';
import fs from 'node:fs';
import { buildApiCandidatePayload } from './scraper.js';

const api = new URL(process.env.NUANU_API_URL || 'about:blank');
const key = process.env.NUANU_API_KEY;
if (api.protocol !== 'https:' || api.pathname !== '/api/candidates/import-seek' || !key || process.env.SCRAPE_ONLY === 'true')
  throw Error('Periksa NUANU_API_URL, NUANU_API_KEY, SCRAPE_ONLY di .env');

const file = 'scrape-checkpoint.json';
const cp = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(cp.candidates)) throw Error('Checkpoint tidak valid');

const pending = cp.candidates.filter(c => !c.imported);
const ready = pending.filter(c => c.name && String(c.phone || '').replace(/\D/g, '').length >= 10);
const excluded = pending.length - ready.length;

console.log(`Checkpoint=${cp.candidates.length}, pending=${pending.length}, valid=${ready.length}, invalid=${excluded}, CV URL=${ready.filter(c => c.resumeUrl).length}`);
if (!ready.length) process.exit(0);

try {
  const check = await fetch(new URL('/api/departments', api), {
    headers: {'x-api-key':key}, signal:AbortSignal.timeout(20000)
  });
  if (!check.ok) throw Error(`API preflight HTTP ${check.status}`);
  console.log('API reachable:', check.status);
} catch (e) {
  console.error('API ERROR:', e.message, e.cause?.code || '', e.cause?.message || '');
  process.exit(1);
}

const backup = `${file}.bak-${Date.now()}`;
fs.copyFileSync(file, backup);
console.log('Checkpoint backup:', backup);

let imported=0, skipped=0, completed=0;
for (let i=0; i<ready.length; i+=2) {
  const group = ready.slice(i,i+2);
  const body = JSON.stringify({
    candidates: group.map(c => buildApiCandidatePayload(c,{includeResume:false}))
  });

  console.log(`POST ${Math.floor(i/2)+1}/${Math.ceil(ready.length/2)} (${group.length} candidates; ${Buffer.byteLength(body)} bytes)`);

  try {
    const res = await fetch(api, {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':key},
      body, signal:AbortSignal.timeout(120000)
    });
    if (!res.ok) throw Error(`HTTP ${res.status}: ${(await res.text()).slice(0,150)}`);

    const result=(await res.json()).results || {};
    const a=Number(result.imported), b=Number(result.skipped), e=Number(result.errors);

    if (![a,b,e].every(Number.isFinite) || e!==0 || a+b!==group.length)
      throw Error(`Unconfirmed response: imported=${result.imported}, skipped=${result.skipped}, errors=${result.errors}`);

    group.forEach(c => { c.imported=true; delete c._seekDetailsBackfillNeeded; });
    fs.writeFileSync(file+'.tmp',JSON.stringify(cp,null,2));
    fs.renameSync(file+'.tmp',file);

    imported+=a; skipped+=b; completed+=group.length;
    console.log(`OK imported=${a}, skipped=${b}; confirmed=${completed}/${ready.length}`);
  } catch (err) {
    console.error('STOP:', err.message, err.cause?.code || '', err.cause?.message || '');
    process.exitCode=1;
    break;
  }
}
console.log(`TOTAL imported=${imported}, skipped=${skipped}, confirmed=${completed}/${ready.length}, excluded=${excluded}`);
if (excluded) process.exitCode=1;