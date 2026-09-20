#!/usr/bin/env node
/**
 * Live-path check (requires a logged-in QwenWorkCN on this machine).
 *
 * Read-only by default: decrypted credentials are never printed or written.
 * `--refresh` actually calls the refresh endpoint (rotates refresh_token and writes back).
 *
 * Usage:
 *   node tools/live-check.mjs              # read-only: decrypt + account/quota/plan
 *   node tools/live-check.mjs --refresh    # also exercise the refresh path
 *   node tools/live-check.mjs --refresh --dry-run   # refresh without write-back
 */

import { loadCredentials, describeCredentials } from '../../lib/credentials.js';
import { getValidToken } from '../../lib/auth.js';
import { fetchAccountOverview, fetchAccountInfo } from '../../lib/rest.js';
import { isQwenAuthError } from '../../lib/errors.js';

const args = new Set(process.argv.slice(2));
const wantRefresh = args.has('--refresh');
const dryRun = args.has('--dry-run');

function line(k, v) { console.log(`  ${k.padEnd(24)} ${v}`); }

try {
  console.log('=== 1. credential decryption ===');
  const creds = loadCredentials();
  const d = describeCredentials(creds);
  for (const [k, v] of Object.entries(d)) line(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  console.log('  OK decrypted (token not printed)');

  console.log('\n=== 2. token validity ===');
  const now = Date.now();
  const expired = creds.expiresAt ? creds.expiresAt.getTime() <= now : false;
  line('expired', String(expired));
  line('days remaining', creds.expiresAt ? String(Math.round((creds.expiresAt.getTime() - now) / 86400000 * 10) / 10) : 'n/a');

  let token = creds.token;
  if (wantRefresh) {
    console.log('\n=== 3. refresh path (real call) ===');
    try {
      const r = await getValidToken({ credentials: creds, forceRefresh: true, dryRun });
      token = r.token;
      line('refreshed', String(r.refreshed));
      line('new token length', String(token.length));
      line('refresh token rotated', String(r.credentials.refreshToken !== creds.refreshToken));
      if (r.warning) line('warning', r.warning);
      console.log('  OK refresh endpoint works');
    } catch (e) {
      console.log(`  FAIL refresh: ${e.code} ${e.message}`);
      console.log(`    ${e.recovery ?? ''}`);
    }
  } else {
    console.log('\n=== 3. refresh path ===');
    console.log('  (skipped, pass --refresh to exercise)');
  }

  console.log('\n=== 4. REST queries ===');
  const overview = await fetchAccountOverview(token);
  line('degraded', String(overview.degraded));
  line('user.name', overview.user?.name ?? '(n/a)');
  line('plan.name', overview.plan?.name ?? '(n/a)');
  line('plan.pid', overview.plan?.pid ?? '(n/a)');
  line('quota.remaining', String(overview.quota?.remaining ?? '(n/a)'));
  line('quota.total', String(overview.quota?.total ?? '(n/a)'));
  line('quota.usedPercentage', String(overview.quota?.usedPercentage ?? '(n/a)'));
  line('page.quota', String(overview.page?.quota ?? '(n/a)'));

  const info = await fetchAccountInfo(token);
  console.log('\n  --- fetchAccountInfo() ---');
  line('name', info.name ?? '(n/a)');
  line('tier', info.tier ?? '(n/a)');
  line('planId', info.planId ?? '(n/a)');
  line('quota.remaining', String(info.quota?.remaining ?? '(n/a)'));

  console.log('\nAll checks passed');
} catch (e) {
  if (isQwenAuthError(e)) {
    console.error(`\nFAIL [${e.code}] ${e.message}`);
    if (e.recovery) console.error(`  recovery: ${e.recovery}`);
  } else {
    console.error('\nFAIL unexpected error:', e);
  }
  process.exit(1);
}
