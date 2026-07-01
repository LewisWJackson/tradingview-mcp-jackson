// Verify the Fyers connection: profile + funds + a quote. Read-only, no orders.
//   node fyers-check.js
import { getFunds, getProfile, getQuotes, DRY_RUN } from "./fyers-client.js";

const profile = await getProfile();
const name = profile.data?.name || "unknown";
console.log(`\n✅ Connected as: ${name}`);

const funds = await getFunds();
const avail = funds.fund_limit?.find((f) => f.title?.includes("Available"));
if (avail) console.log(`💰 Available balance: ₹${avail.equityAmount ?? avail.commodityAmount}`);

const q = await getQuotes("NSE:NIFTY50-INDEX");
const ltp = q.d?.[0]?.v?.lp;
if (ltp != null) console.log(`📈 NIFTY50 LTP: ${ltp}`);

console.log(`🧪 DRY_RUN (orders simulated): ${DRY_RUN}\n`);
