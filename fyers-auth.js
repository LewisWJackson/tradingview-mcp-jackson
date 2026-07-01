// Fyers OAuth helper — mint a daily access token.
//
// Fyers access tokens expire at the end of each trading day, so this needs to
// be re-run once per morning.
//
//   Step 1:  node fyers-auth.js
//            → prints the login URL. Open it, log in, approve.
//            → Fyers redirects to your REDIRECT_URI with ?auth_code=XXXX
//
//   Step 2:  node fyers-auth.js "<auth_code>"
//            → exchanges the code for an access token and appends
//              FYERS_ACCESS_TOKEN to your .env
//
// Requires FYERS_APP_ID, FYERS_SECRET_ID, FYERS_REDIRECT_URI in .env.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { exchangeAuthCode, loginUrl } from "./fyers-client.js";

const authCode = process.argv[2];

if (!authCode) {
  console.log("\n🔑 Fyers login — Step 1 of 2\n");
  console.log("Open this URL in your browser, log in, and approve:\n");
  console.log("  " + loginUrl() + "\n");
  console.log(
    "After approving you'll be redirected to your callback URL. Copy the",
  );
  console.log("`auth_code` value from that URL, then run:\n");
  console.log('  node fyers-auth.js "<auth_code>"\n');
  process.exit(0);
}

const token = await exchangeAuthCode(authCode);

// Upsert FYERS_ACCESS_TOKEN in .env
const envPath = new URL(".env", import.meta.url);
const line = `FYERS_ACCESS_TOKEN=${token}`;
if (existsSync(envPath)) {
  const cur = readFileSync(envPath, "utf8");
  const next = /^FYERS_ACCESS_TOKEN=.*$/m.test(cur)
    ? cur.replace(/^FYERS_ACCESS_TOKEN=.*$/m, line)
    : cur.replace(/\n?$/, "\n") + line + "\n";
  writeFileSync(envPath, next);
} else {
  appendFileSync(envPath, line + "\n");
}

console.log("\n✅ Access token saved to .env (FYERS_ACCESS_TOKEN).");
console.log("   Token is valid for today's session — re-run tomorrow.\n");
