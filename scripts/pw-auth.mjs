/**
 * pw-auth.mjs — mint a reusable Playwright authenticated session for the dashboard.
 *
 * The dashboard gates /api/* behind a user JWT (Bearer) stored in localStorage as
 * `mawjah_jwt`. This logs in a dedicated dev user (registering it once if absent) and
 * writes a Playwright storageState file so verify scripts (and ad-hoc runs) load straight
 * into the logged-in app instead of the auth gate.
 *
 * Env: BASE (default http://localhost:3000), PW_EMAIL / PW_PASSWORD (default dev creds).
 * Needs ALLOW_REGISTRATION=true on the server only the first time (to create the dev user).
 *
 * Run: node scripts/pw-auth.mjs   →   writes .playwright-auth.json
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const EMAIL = process.env.PW_EMAIL || 'pwtest@local';
const PASSWORD = process.env.PW_PASSWORD || 'devpassword123';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.playwright-auth.json');

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function main() {
  // 1) try login
  let { status, json } = await post('/auth/login', { identifier: EMAIL, password: PASSWORD });
  // 2) if the dev user doesn't exist yet, register it (requires ALLOW_REGISTRATION=true)
  if (status !== 200 || !json.token) {
    const reg = await post('/auth/register', { email: EMAIL, username: EMAIL.split('@')[0], password: PASSWORD, display_name: 'PW Test' });
    if (!reg.json.token) {
      console.error(`✗ Could not authenticate. Login failed and register returned: ${JSON.stringify(reg.json)}`);
      console.error(`  If registration is disabled, set ALLOW_REGISTRATION=true once, or pass existing PW_EMAIL/PW_PASSWORD.`);
      process.exit(1);
    }
    json = reg.json;
  }

  const origin = new URL(BASE).origin;
  const state = { cookies: [], origins: [{ origin, localStorage: [{ name: 'mawjah_jwt', value: json.token }] }] };
  writeFileSync(OUT, JSON.stringify(state, null, 2));
  console.log(`✓ Authenticated as ${EMAIL}. storageState → ${OUT}`);
  console.log(`  Load it: chromium.launchPersistentContext OR newContext({ storageState: '.playwright-auth.json' })`);
}
main();
