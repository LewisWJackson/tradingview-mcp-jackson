/**
 * Sharia compliance data — AAOIFI standards + sector-based screening
 * Banking: classified per known Islamic/conventional bank status
 * Non-financial sectors: standard Sharia sector screens
 * 'review' items require verification with a qualified Islamic finance scholar.
 *
 * status: 'compliant' | 'non_compliant' | 'review' | 'unknown'
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Authoritative source of truth = Musaffa (AAOIFI), harvested by scripts/harvest_sharia.mjs
// into dashboard/sharia_data.json. The static COMPLIANCE map below is the FALLBACK for names
// Musaffa doesn't cover (US equity, commodities) or parse-misses.
let _musaffa;
function musaffaData() {
  if (_musaffa !== undefined) return _musaffa;
  try { _musaffa = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sharia_data.json'), 'utf8')).data || {}; }
  catch { _musaffa = {}; }
  return _musaffa;
}

const COMPLIANCE = new Map([
  // ── Fully Islamic banks ──────────────────────────────────────────────────────
  ["TADAWUL:1120", { status: "compliant",     basis: "Full Islamic bank (Al Rajhi) — AAOIFI certified" }],
  ["TADAWUL:1020", { status: "compliant",     basis: "Full Islamic bank (Bank AlJazira)" }],
  ["TADAWUL:1140", { status: "compliant",     basis: "Full Islamic bank (Al Bilad)" }],
  ["TADAWUL:1150", { status: "compliant",     basis: "Full Islamic bank (Alinma)" }],

  // ── Conventional banks (interest-based — non-compliant) ─────────────────────
  ["TADAWUL:1180", { status: "non_compliant", basis: "Conventional bank — earns interest (riba)" }],
  ["TADAWUL:1010", { status: "non_compliant", basis: "Conventional bank — earns interest (riba)" }],
  ["TADAWUL:1050", { status: "non_compliant", basis: "Conventional bank — earns interest (riba)" }],
  ["TADAWUL:1080", { status: "non_compliant", basis: "Conventional bank — earns interest (riba)" }],
  ["TADAWUL:1060", { status: "non_compliant", basis: "Conventional bank — earns interest (riba)" }],

  // ── Bank under Sharia transformation ────────────────────────────────────────
  ["TADAWUL:1030", { status: "review",        basis: "SABB — transitioning to Islamic model; verify current Sharia board status" }],

  // ── Takaful (Islamic insurance) ─────────────────────────────────────────────
  ["TADAWUL:1213", { status: "compliant",     basis: "Takaful — Islamic insurance model" }],

  // ── Cooperative / conventional insurance (verify) ───────────────────────────
  ["TADAWUL:8010", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8020", { status: "review",        basis: "Conventional health insurance — verify compliance with qualified scholar" }],

  // ── Non-financial sectors (pass standard Sharia screens) ────────────────────
  ...([
    "TADAWUL:2222","TADAWUL:2010","TADAWUL:2090","TADAWUL:2380","TADAWUL:2060","TADAWUL:2350",
    "TADAWUL:7010","TADAWUL:7020","TADAWUL:7030","TADAWUL:9200","TADAWUL:7203",
    "TADAWUL:5110","TADAWUL:6010",
    "TADAWUL:4200","TADAWUL:2050","TADAWUL:4190","TADAWUL:6070","TADAWUL:6090",
    "TADAWUL:4150","TADAWUL:4240","TADAWUL:4261",
    "TADAWUL:4002","TADAWUL:4007","TADAWUL:2160","TADAWUL:4009","TADAWUL:4013","TADAWUL:4017",
    "TADAWUL:4300","TADAWUL:4310","TADAWUL:4082","TADAWUL:3001",
    "TADAWUL:3010","TADAWUL:3020","TADAWUL:3030","TADAWUL:3040","TADAWUL:3050",
    "TADAWUL:2110","TADAWUL:2120","TADAWUL:2170","TADAWUL:4031","TADAWUL:2180",
  ].map(s => [s, { status: "compliant", basis: "Non-financial sector — passes standard Sharia screens" }])),

  // ── US Equity ────────────────────────────────────────────────────────────────
  ["NASDAQ:AAPL",  { status: "compliant",     basis: "Technology — passes debt/revenue screens (AAOIFI)" }],
  ["NASDAQ:NVDA",  { status: "compliant",     basis: "Technology — passes debt/revenue screens (AAOIFI)" }],
  ["NASDAQ:MSFT",  { status: "compliant",     basis: "Technology — passes debt/revenue screens (AAOIFI)" }],
  ["NASDAQ:AMZN",  { status: "compliant",     basis: "Technology/Retail — passes Sharia screens per Musaffa" }],
  ["NASDAQ:META",  { status: "compliant",     basis: "Technology — passes debt/revenue screens" }],
  ["NASDAQ:GOOGL", { status: "compliant",     basis: "Technology — passes debt/revenue screens" }],
  ["NASDAQ:TSLA",  { status: "compliant",     basis: "Automotive/Tech — passes Sharia screens per Musaffa" }],
  ["NASDAQ:AVGO",  { status: "compliant",     basis: "Semiconductors — passes Sharia screens" }],
  ["NASDAQ:COST",  { status: "compliant",     basis: "Retail — passes Sharia screens" }],
  ["NASDAQ:NFLX",  { status: "compliant",     basis: "Streaming/Tech — passes Sharia screens" }],
  ["NYSE:JPM",     { status: "non_compliant", basis: "Conventional bank — earns interest (riba)" }],
  ["NYSE:BAC",     { status: "non_compliant", basis: "Conventional bank — earns interest (riba)" }],
  ["NYSE:V",       { status: "review",        basis: "Payment processor — revenue from interest-bearing transactions; scholars differ" }],
  ["NYSE:MA",      { status: "review",        basis: "Payment processor — revenue from interest-bearing transactions; scholars differ" }],
  ["NYSE:UNH",     { status: "compliant",     basis: "Healthcare — passes Sharia screens" }],
  ["NYSE:JNJ",     { status: "compliant",     basis: "Healthcare/Pharma — passes Sharia screens" }],
  ["NYSE:XOM",     { status: "compliant",     basis: "Energy sector — passes Sharia screens" }],
  ["NYSE:WMT",     { status: "compliant",     basis: "Retail — passes Sharia screens" }],
  ["NYSE:PG",      { status: "compliant",     basis: "Consumer staples — passes Sharia screens" }],
  ["NYSE:HD",      { status: "compliant",     basis: "Retail — passes Sharia screens" }],

  // ── ETFs ─────────────────────────────────────────────────────────────────────
  ["NASDAQ:QQQ",  { status: "non_compliant", basis: "ETF — includes conventional financial sector holdings (banks, insurance)" }],
  ["NYSE:SPY",    { status: "non_compliant", basis: "ETF — includes conventional financial sector holdings" }],
  ["NYSE:IWM",    { status: "non_compliant", basis: "ETF — includes conventional financial sector holdings" }],
  ["NYSE:DIA",    { status: "non_compliant", basis: "ETF — includes conventional financial sector holdings" }],
  ["NYSE:VTI",    { status: "non_compliant", basis: "ETF — includes conventional financial sector holdings" }],
  ["NYSE:EEM",    { status: "non_compliant", basis: "ETF — includes conventional financial sector holdings" }],
  ["NYSE:IEMG",   { status: "non_compliant", basis: "ETF — includes conventional financial sector holdings" }],
  ["NASDAQ:ARKK", { status: "review",        basis: "Innovation ETF — excludes some conventional finance but not fully screened" }],
  ["NYSE:XLK",    { status: "compliant",     basis: "Technology sector ETF — generally passes Sharia screens (verify current holdings)" }],
  ["NYSE:XLF",    { status: "non_compliant", basis: "Financial sector ETF — conventional banks and insurance" }],
  ["NYSE:GLD",    { status: "review",        basis: "Gold ETF — physical gold is permissible; paper gold is debated" }],
  ["NYSE:SLV",    { status: "review",        basis: "Silver ETF — physical silver is permissible; paper silver is debated" }],
  ["NYSE:USO",    { status: "compliant",     basis: "Oil ETF — commodity-based, generally permissible" }],
  ["NYSE:TLT",    { status: "non_compliant", basis: "Treasury bond ETF — interest-bearing (riba)" }],

  // ── Crypto ───────────────────────────────────────────────────────────────────
  ["BITSTAMP:BTCUSD",  { status: "review",  basis: "Majority scholarly opinion leans permissible (Mufti Faraz Adam); debate ongoing" }],
  ["BITFINEX:XRPUSD",  { status: "review",  basis: "Concerns re: Ripple Labs centralized issuance; scholars differ on permissibility" }],
  ["COINBASE:ETHUSD",  { status: "review",  basis: "Ethereum PoS — scholars differ; staking income adds complexity" }],
  ["BINANCE:SOLUSDT",  { status: "review",  basis: "Crypto — no clear scholarly consensus; verify with Islamic finance scholar" }],
  ["BINANCE:BNBUSDT",  { status: "review",  basis: "Exchange token — utility use permissible but exchange activities add complexity" }],
  ["COINBASE:AVAXUSD", { status: "review",  basis: "Crypto — no clear scholarly consensus; verify with Islamic finance scholar" }],
  ["BINANCE:ADAUSDT",  { status: "review",  basis: "Crypto — no clear scholarly consensus; verify with Islamic finance scholar" }],

  // ── TASI — Banking (additional) ──────────────────────────────────────────────
  ["TADAWUL:1040", { status: "non_compliant", basis: "Conventional bank — earns interest (riba)" }],

  // ── TASI — Petrochemicals & Energy ───────────────────────────────────────────
  ["TADAWUL:2310", { status: "compliant",     basis: "Petrochemicals — passes standard Sharia sector screens (AAOIFI)" }],
  ["TADAWUL:2020", { status: "compliant",     basis: "Industrial/steel — passes standard Sharia sector screens" }],
  ["TADAWUL:2330", { status: "compliant",     basis: "Petrochemicals — passes standard Sharia sector screens (AAOIFI)" }],
  ["TADAWUL:2130", { status: "compliant",     basis: "Chemicals — passes standard Sharia sector screens (AAOIFI)" }],
  ["TADAWUL:1211", { status: "compliant",     basis: "Mining — passes standard Sharia sector screens" }],
  ["TADAWUL:2082", { status: "compliant",     basis: "Utilities/power — passes standard Sharia sector screens" }],
  ["TADAWUL:2083", { status: "compliant",     basis: "Utilities — passes standard Sharia sector screens" }],
  ["TADAWUL:2381", { status: "compliant",     basis: "Oil services — passes standard Sharia sector screens" }],
  ["TADAWUL:2382", { status: "compliant",     basis: "Oil services — passes standard Sharia sector screens" }],
  ["TADAWUL:2080", { status: "compliant",     basis: "Gas distribution — passes standard Sharia sector screens" }],
  ["TADAWUL:2223", { status: "compliant",     basis: "Lubricants/refining — passes standard Sharia sector screens" }],
  ["TADAWUL:2210", { status: "compliant",     basis: "Chemicals — passes standard Sharia sector screens (AAOIFI)" }],
  ["TADAWUL:2360", { status: "compliant",     basis: "Industrial — passes standard Sharia sector screens" }],

  // ── TASI — Food & Beverages ───────────────────────────────────────────────────
  ["TADAWUL:2280", { status: "compliant",     basis: "Dairy/food — halal certified, passes Sharia screens" }],
  ["TADAWUL:6002", { status: "compliant",     basis: "Halal fast food — halal certified operations" }],
  ["TADAWUL:2281", { status: "compliant",     basis: "Food processing — halal certified, passes Sharia screens" }],
  ["TADAWUL:2270", { status: "compliant",     basis: "Dairy/food — halal certified, passes Sharia screens" }],
  ["TADAWUL:1301", { status: "compliant",     basis: "Food distribution — passes standard Sharia sector screens" }],
  ["TADAWUL:2100", { status: "compliant",     basis: "Agricultural — passes standard Sharia sector screens" }],
  ["TADAWUL:2282", { status: "compliant",     basis: "Water — permissible commodity" }],
  ["TADAWUL:2283", { status: "compliant",     basis: "Milling/food — passes standard Sharia sector screens" }],
  ["TADAWUL:2284", { status: "compliant",     basis: "Milling/food — passes standard Sharia sector screens" }],
  ["TADAWUL:6001", { status: "compliant",     basis: "Food/confectionery — halal certified" }],
  ["TADAWUL:6014", { status: "compliant",     basis: "Food — passes standard Sharia sector screens" }],
  ["TADAWUL:6015", { status: "compliant",     basis: "Restaurants — halal certified operations in KSA" }],
  ["TADAWUL:6017", { status: "compliant",     basis: "Food delivery platform — passes standard Sharia sector screens" }],
  ["TADAWUL:6040", { status: "compliant",     basis: "Agricultural — passes standard Sharia sector screens" }],

  // ── TASI — Healthcare & Pharma ────────────────────────────────────────────────
  ["TADAWUL:4004", { status: "compliant",     basis: "Healthcare — passes standard Sharia sector screens" }],
  ["TADAWUL:4005", { status: "compliant",     basis: "Healthcare — passes standard Sharia sector screens" }],
  ["TADAWUL:4341", { status: "compliant",     basis: "Pharmacy retail — passes standard Sharia sector screens" }],
  ["TADAWUL:4338", { status: "compliant",     basis: "Supermarket retail — passes standard Sharia sector screens" }],
  ["TADAWUL:4015", { status: "compliant",     basis: "Pharmaceuticals — passes standard Sharia sector screens" }],
  ["TADAWUL:4016", { status: "compliant",     basis: "Pharmaceuticals — passes standard Sharia sector screens" }],
  ["TADAWUL:4018", { status: "compliant",     basis: "Healthcare — passes standard Sharia sector screens" }],
  ["TADAWUL:4019", { status: "compliant",     basis: "Healthcare — passes standard Sharia sector screens" }],
  ["TADAWUL:4021", { status: "compliant",     basis: "Healthcare — passes standard Sharia sector screens" }],
  ["TADAWUL:4024", { status: "compliant",     basis: "Healthcare — passes standard Sharia sector screens" }],
  ["TADAWUL:4163", { status: "compliant",     basis: "Pharmacy retail — passes standard Sharia sector screens" }],

  // ── TASI — Retail & Consumer ──────────────────────────────────────────────────
  ["TADAWUL:4180", { status: "review",        basis: "Luxury/jewellery holding — gold trading rules apply; verify with scholar" }],
  ["TADAWUL:4003", { status: "compliant",     basis: "Electronics retail — passes standard Sharia sector screens" }],
  ["TADAWUL:4260", { status: "compliant",     basis: "Fashion retail — passes standard Sharia sector screens" }],
  ["TADAWUL:4001", { status: "compliant",     basis: "Supermarket retail — passes standard Sharia sector screens" }],
  ["TADAWUL:4006", { status: "compliant",     basis: "Supermarket retail — passes standard Sharia sector screens" }],
  ["TADAWUL:4050", { status: "compliant",     basis: "Fuel stations/retail — passes standard Sharia sector screens" }],
  ["TADAWUL:4051", { status: "compliant",     basis: "Trading — passes standard Sharia sector screens" }],

  // ── TASI — Education & Sports ─────────────────────────────────────────────────
  ["TADAWUL:4291", { status: "compliant",     basis: "Education — passes standard Sharia sector screens" }],
  ["TADAWUL:1820", { status: "compliant",     basis: "Sports — passes standard Sharia sector screens" }],
  ["TADAWUL:1830", { status: "compliant",     basis: "Sports/fitness — passes standard Sharia sector screens" }],

  // ── TASI — Industrial & Manufacturing ────────────────────────────────────────
  ["TADAWUL:1304", { status: "compliant",     basis: "Steel manufacturing — passes standard Sharia sector screens" }],
  ["TADAWUL:1321", { status: "compliant",     basis: "Industrial pipes — passes standard Sharia sector screens" }],
  ["TADAWUL:2150", { status: "compliant",     basis: "Glass manufacturing — passes standard Sharia sector screens" }],
  ["TADAWUL:2200", { status: "compliant",     basis: "Packaging — passes standard Sharia sector screens" }],
  ["TADAWUL:2300", { status: "compliant",     basis: "Printing/packaging — passes standard Sharia sector screens" }],
  ["TADAWUL:1212", { status: "compliant",     basis: "Industrial conglomerate — passes standard Sharia sector screens" }],
  ["TADAWUL:1214", { status: "compliant",     basis: "HVAC/appliances — passes standard Sharia sector screens" }],
  ["TADAWUL:1302", { status: "compliant",     basis: "Industrial — passes standard Sharia sector screens" }],
  ["TADAWUL:2040", { status: "compliant",     basis: "Ceramics — passes standard Sharia sector screens" }],
  ["TADAWUL:2320", { status: "compliant",     basis: "Electrical/power — passes standard Sharia sector screens" }],
  ["TADAWUL:4030", { status: "compliant",     basis: "Printing/packaging — passes standard Sharia sector screens" }],
  ["TADAWUL:4142", { status: "compliant",     basis: "Cables — passes standard Sharia sector screens" }],

  // ── TASI — Cement ─────────────────────────────────────────────────────────────
  ["TADAWUL:3060", { status: "compliant",     basis: "Cement — passes standard Sharia sector screens" }],
  ["TADAWUL:3080", { status: "compliant",     basis: "Cement — passes standard Sharia sector screens" }],
  ["TADAWUL:3090", { status: "compliant",     basis: "Cement — passes standard Sharia sector screens" }],
  ["TADAWUL:3002", { status: "compliant",     basis: "Cement — passes standard Sharia sector screens" }],
  ["TADAWUL:3101", { status: "compliant",     basis: "Cement — passes standard Sharia sector screens" }],
  ["TADAWUL:3003", { status: "compliant",     basis: "Cement — passes standard Sharia sector screens" }],
  ["TADAWUL:3004", { status: "compliant",     basis: "Cement — passes standard Sharia sector screens" }],
  ["TADAWUL:3091", { status: "compliant",     basis: "Cement — passes standard Sharia sector screens" }],
  ["TADAWUL:3092", { status: "compliant",     basis: "Cement — passes standard Sharia sector screens" }],

  // ── TASI — Transport & Logistics ─────────────────────────────────────────────
  ["TADAWUL:4110", { status: "compliant",     basis: "Shipping/logistics — passes standard Sharia sector screens" }],
  ["TADAWUL:4040", { status: "compliant",     basis: "Transport — passes standard Sharia sector screens" }],
  ["TADAWUL:4262", { status: "compliant",     basis: "Car rental — passes standard Sharia sector screens" }],
  ["TADAWUL:4263", { status: "compliant",     basis: "Aviation services — passes standard Sharia sector screens" }],
  ["TADAWUL:4264", { status: "compliant",     basis: "Airline — halal operations, passes Sharia sector screens" }],
  ["TADAWUL:1810", { status: "compliant",     basis: "Travel/tourism — passes standard Sharia sector screens" }],

  // ── TASI — Financial Services (non-bank) ──────────────────────────────────────
  ["TADAWUL:1111", { status: "compliant",     basis: "Stock exchange operator — passes standard Sharia screens per most scholars" }],
  ["TADAWUL:4081", { status: "review",        basis: "Consumer finance — verify whether financing is Sharia-compliant (murabaha vs riba)" }],
  ["TADAWUL:4084", { status: "review",        basis: "Investment management — verify Sharia-compliance of managed products" }],
  ["TADAWUL:4130", { status: "compliant",     basis: "Fintech/payments — passes standard Sharia sector screens" }],
  ["TADAWUL:4280", { status: "review",        basis: "Diversified holding — verify proportion of non-compliant subsidiaries" }],

  // ── TASI — Insurance (Takaful = compliant; conventional = review) ─────────────
  ["TADAWUL:8160", { status: "compliant",     basis: "Takaful (Islamic insurance) — certified Sharia-compliant model" }],
  ["TADAWUL:8230", { status: "compliant",     basis: "Cooperative insurance (Al Rajhi) — AAOIFI-aligned model" }],
  ["TADAWUL:8050", { status: "compliant",     basis: "Salama Takaful — certified Islamic insurance model" }],
  ["TADAWUL:8030", { status: "review",        basis: "Cooperative insurance — verify current Sharia board certification" }],
  ["TADAWUL:8060", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8070", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8100", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8120", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8150", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8170", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8180", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8190", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8200", { status: "review",        basis: "Reinsurance — conventional reinsurance model; verify with scholar" }],
  ["TADAWUL:8240", { status: "review",        basis: "Conventional insurance (Chubb) — verify Sharia compliance" }],
  ["TADAWUL:8250", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8260", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8270", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8300", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],
  ["TADAWUL:8310", { status: "review",        basis: "Cooperative insurance — verify Sharia board certification" }],

  // ── TASI — Real Estate & Development ─────────────────────────────────────────
  ["TADAWUL:4020", { status: "compliant",     basis: "Real estate — passes standard Sharia sector screens" }],
  ["TADAWUL:4090", { status: "compliant",     basis: "Real estate (Makkah) — passes standard Sharia sector screens" }],
  ["TADAWUL:4100", { status: "compliant",     basis: "Real estate/construction — passes standard Sharia sector screens" }],
  ["TADAWUL:4220", { status: "compliant",     basis: "Real estate development — passes standard Sharia sector screens" }],
  ["TADAWUL:4250", { status: "compliant",     basis: "Real estate (Makkah) — passes standard Sharia sector screens" }],
  ["TADAWUL:4320", { status: "compliant",     basis: "Real estate — passes standard Sharia sector screens" }],
  ["TADAWUL:4321", { status: "compliant",     basis: "Real estate/malls — passes standard Sharia sector screens" }],
  ["TADAWUL:4322", { status: "compliant",     basis: "Real estate development — passes standard Sharia sector screens" }],
  ["TADAWUL:4323", { status: "compliant",     basis: "Real estate development — passes standard Sharia sector screens" }],
  ["TADAWUL:4324", { status: "compliant",     basis: "Real estate — passes standard Sharia sector screens" }],
  ["TADAWUL:4325", { status: "compliant",     basis: "Real estate — passes standard Sharia sector screens" }],

  // ── TASI — REITs (CMA requires Sharia board certification for listed REITs) ───
  ["TADAWUL:4330", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4331", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4332", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4333", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4334", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4335", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4336", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4339", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4340", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4342", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4344", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4345", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4346", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4347", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],
  ["TADAWUL:4348", { status: "compliant",     basis: "REIT — Sharia-certified by CMA requirement" }],

  // ── TASI — Media ─────────────────────────────────────────────────────────────
  ["TADAWUL:4072", { status: "review",        basis: "Media group — content permissibility varies; verify with scholar" }],
  ["TADAWUL:4210", { status: "review",        basis: "Media/publishing — content permissibility varies; verify with scholar" }],

  // ── TASI — Telecom & Technology ───────────────────────────────────────────────
  ["TADAWUL:7040", { status: "compliant",     basis: "Telecom — passes standard Sharia sector screens" }],
  ["TADAWUL:7202", { status: "compliant",     basis: "IT services — passes standard Sharia sector screens" }],
  ["TADAWUL:7204", { status: "compliant",     basis: "Technology — passes standard Sharia sector screens" }],
  ["TADAWUL:7211", { status: "compliant",     basis: "Technology — passes standard Sharia sector screens" }],

  // ── Commodities ──────────────────────────────────────────────────────────────
  ["TVC:GOLD",       { status: "compliant",     basis: "Physical gold — permissible as currency and store of value (AAOIFI)" }],
  ["TVC:SILVER",     { status: "compliant",     basis: "Physical silver — permissible as currency and store of value (AAOIFI)" }],
  ["TVC:USOIL",      { status: "compliant",     basis: "Crude oil commodity — permissible for trading" }],
  ["TVC:NATURALGAS", { status: "compliant",     basis: "Natural gas commodity — permissible for trading" }],
  ["TVC:COPPER",     { status: "compliant",     basis: "Copper commodity — permissible for trading" }],
]);

export function getShariaStatus(sym) {
  // 1. Authoritative: Musaffa AAOIFI harvest
  const m = musaffaData()[sym];
  if (m && m.status && m.status !== "unknown") {
    const r = m.ratios;
    const ind = (r && (r.debtRatio != null || r.cashRatio != null))
      ? ` · approx debt ${r.debtRatio != null ? Math.round(r.debtRatio * 100) + "%" : "—"}, cash ${r.cashRatio != null ? Math.round(r.cashRatio * 100) + "%" : "—"} (indicative)`
      : "";
    const srcName = m.source === "muslimxchange" ? "MuslimXchange" : "Musaffa";
    return {
      status: m.status,
      basis: `${srcName} AAOIFI screening${m.asOf ? ` (as of ${m.asOf})` : ""}${ind}`,
      source: m.source || "musaffa", asOf: m.asOf, label: m.label, ratios: r, flag: m.flag,
    };
  }
  // 2. Fallback: static hand-classified map (US equity, commodities, Musaffa parse-misses)
  const stat = COMPLIANCE.get(sym);
  if (stat) return { ...stat, source: "static", basis: stat.basis + (m ? " (Musaffa unavailable — static fallback)" : "") };
  // 3. Nothing — conservative unknown (excluded from compliant-only screens)
  return { status: "unknown", basis: "No data — verify with an Islamic finance scholar", source: "none" };
}

export function getAllStatuses() {
  const out = {};
  for (const [sym, data] of COMPLIANCE) out[sym] = data;
  return out;
}
