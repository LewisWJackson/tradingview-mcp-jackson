/**
 * TASI Stock Screener
 * Scans major Tadawul stocks for bullish buying opportunities
 * using the Multi-Market Trend Strategy criteria (EMA 13/34/89/200, RSI, MACD, Volume).
 *
 * Usage: node scripts/tasi_screener.mjs
 */

// ── Yahoo Finance data layer (replaces TradingView CDP for screening) ─────────
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// Map TradingView symbol format → Yahoo Finance ticker
export function toYahooSym(sym) {
  if (!sym) return null;
  // TADAWUL stocks: TADAWUL:1120 → 1120.SR
  if (sym.startsWith('TADAWUL:')) return sym.replace('TADAWUL:', '') + '.SR';
  // TASI index
  if (sym === 'TADAWUL:TASI' || sym.endsWith(':TASI')) return '^TASI';
  // Crypto: BITSTAMP:BTCUSD or BINANCE:BTCUSDT → BTC-USD
  if (sym.includes('BTC')) return 'BTC-USD';
  if (sym.includes('ETH')) return 'ETH-USD';
  if (sym.includes('SOL')) return 'SOL-USD';
  if (sym.includes('XRP')) return 'XRP-USD';
  if (sym.includes('BNB')) return 'BNB-USD';
  // Commodities
  if (sym.includes('GOLD') || sym.includes('GC')) return 'GC=F';
  if (sym.includes('SILVER') || sym.includes('SI1')) return 'SI=F';
  if (sym.includes('CL') || sym.includes('OIL')) return 'CL=F';
  if (sym.includes('NG') || sym.includes('NGAS')) return 'NG=F';
  if (sym.includes('HG') || sym.includes('COPPER')) return 'HG=F';
  // US indices
  if (sym.includes('SPY') || sym.includes('SPX') || sym.includes('GSPC')) return 'SPY';
  if (sym.includes('QQQ') || sym.includes('NDX')) return 'QQQ';
  // Generic: strip exchange prefix
  const base = sym.includes(':') ? sym.split(':')[1] : sym;
  return base.replace(/1!$/, '=F'); // futures continuous contracts
}

// Yahoo Finance index symbols for each market
const YAHOO_INDEX = {
  tasi:      '^TASI.SR',
  us:        '^GSPC',
  etf:       '^GSPC',
  crypto:    'BTC-USD',
  commodity: 'GC=F',
};

export async function fetchYahooOHLCV(yahooSym, interval = '1d', count = 260) {
  const range = interval === '1wk' ? '6y' : '2y';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${yahooSym}`);
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`No Yahoo data for ${yahooSym}`);
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = timestamps.map((t, i) => ({
    time:   t,
    open:   q.open?.[i]   ?? null,
    high:   q.high?.[i]   ?? null,
    low:    q.low?.[i]    ?? null,
    close:  q.close?.[i]  ?? null,
    volume: q.volume?.[i] ?? 0,
  })).filter(b => b.close != null && b.close > 0 && b.high != null && b.low != null);
  return bars.slice(-count);
}

// Run up to `limit` async tasks concurrently
async function withConcurrency(items, fn, limit = 12) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── TASI Universe (~85 most liquid stocks by sector) ─────────────────────────
const TASI_STOCKS = [
  // Banking
  { sym: "TADAWUL:1120", name: "Al Rajhi Bank", ar: "الراجحي" },
  { sym: "TADAWUL:1180", name: "SNB", ar: "الأهلي" },
  { sym: "TADAWUL:1010", name: "Riyad Bank", ar: "الرياض" },
  { sym: "TADAWUL:1030", name: "SABB", ar: "ساب" },
  { sym: "TADAWUL:1050", name: "Saudi Fransi", ar: "الفرنسي" },
  { sym: "TADAWUL:1040", name: "Arab National Bank (ANB)", ar: "العربي الوطني" },
  { sym: "TADAWUL:1080", name: "Saudi Awwal Bank", ar: "أول" },
  { sym: "TADAWUL:1140", name: "Al Bilad Bank", ar: "البلاد" },
  { sym: "TADAWUL:1150", name: "Alinma Bank", ar: "الإنماء" },
  { sym: "TADAWUL:1060", name: "Saudi Investment Bank", ar: "الاستثمار" },
  { sym: "TADAWUL:1020", name: "Bank AlJazira", ar: "الجزيرة" },

  // Energy
  { sym: "TADAWUL:2222", name: "Saudi Aramco", ar: "أرامكو" },

  // Petrochemicals / Industrial
  { sym: "TADAWUL:2010", name: "SABIC", ar: "سابك" },
  { sym: "TADAWUL:2060", name: "Tasnee", ar: "التصنيع" },           // National Industrialization Co.
  { sym: "TADAWUL:2310", name: "Sahara Petrochemical", ar: "صحارى" }, // formerly Sipchem
  { sym: "TADAWUL:2380", name: "Petro Rabigh", ar: "بترورابغ" },
  { sym: "TADAWUL:2350", name: "Saudi Kayan", ar: "كيان" },
  { sym: "TADAWUL:2020", name: "SIIG", ar: "الصناعات" },
  { sym: "TADAWUL:2330", name: "Advanced Petrochemical", ar: "المتقدمة" },
  { sym: "TADAWUL:2130", name: "Saudi Chemical", ar: "الكيميائية" },

  // Mining
  { sym: "TADAWUL:1211", name: "Ma'aden", ar: "معادن" },

  // Transport
  { sym: "TADAWUL:4110", name: "Bahri (National Shipping)", ar: "البحري" },

  // Telecom & Tech
  { sym: "TADAWUL:7010", name: "STC", ar: "الاتصالات" },
  { sym: "TADAWUL:7020", name: "Mobily", ar: "موبايلي" },
  { sym: "TADAWUL:7030", name: "Zain KSA", ar: "زين" },
  { sym: "TADAWUL:7203", name: "Elm Company", ar: "علم" },

  // Utilities
  { sym: "TADAWUL:5110", name: "Saudi Electricity (SEC)", ar: "الكهرباء" },
  { sym: "TADAWUL:2082", name: "ACWA Power", ar: "أكوا باور" },

  // Food & Agri
  { sym: "TADAWUL:2280", name: "Almarai", ar: "المراعي" },
  { sym: "TADAWUL:2050", name: "Savola", ar: "سافولا" },
  { sym: "TADAWUL:6002", name: "Herfy Food Services", ar: "هرفي" },
  { sym: "TADAWUL:2281", name: "Tanmiah Food", ar: "تنمية" },
  { sym: "TADAWUL:6070", name: "Al-Jouf Agriculture", ar: "الجوف" },
  { sym: "TADAWUL:2270", name: "SADAFCO", ar: "سداف" },

  // Retail / Consumer
  { sym: "TADAWUL:4190", name: "Jarir Marketing", ar: "جرير" },
  { sym: "TADAWUL:4180", name: "Fitaihi Holding", ar: "الفيتيهي" },
  { sym: "TADAWUL:4003", name: "eXtra (United Electronics)", ar: "اكسترا" },
  { sym: "TADAWUL:4200", name: "Aldrees Petroleum", ar: "الدريس" },
  { sym: "TADAWUL:4260", name: "Fawaz Alhokair", ar: "الحكير" },

  // Healthcare / Pharma
  { sym: "TADAWUL:4007", name: "Al Hammadi", ar: "الحمادي" },
  { sym: "TADAWUL:4004", name: "Dallah Healthcare", ar: "دله" },
  { sym: "TADAWUL:2160", name: "Mouwasat", ar: "مواساة" },
  { sym: "TADAWUL:4013", name: "Dr. Sulaiman Al-Habib (HHC)", ar: "الحبيب" },
  { sym: "TADAWUL:4005", name: "National Medical Care", ar: "المتكاملة" },
  { sym: "TADAWUL:4017", name: "Dr. Fakeeh Hospital", ar: "فقيه" },
  { sym: "TADAWUL:4341", name: "Nahdi Medical", ar: "النهدي" },
  { sym: "TADAWUL:4009", name: "SPIMACO", ar: "سبيماكو" },
  { sym: "TADAWUL:4338", name: "Bindawood", ar: "بنداود" },

  // Real Estate & Construction
  { sym: "TADAWUL:4300", name: "Dar Al Arkan", ar: "دار الأركان" },
  { sym: "TADAWUL:4310", name: "Emaar Economic City", ar: "إعمار" },
  { sym: "TADAWUL:4150", name: "Arriyadh Development", ar: "الرياض التنمية" },
  { sym: "TADAWUL:4323", name: "Jabal Omar", ar: "جبل عمر" },

  // Building Materials / Cement
  { sym: "TADAWUL:3010", name: "Saudi Cement", ar: "الأسمنت السعودية" },
  { sym: "TADAWUL:3020", name: "Yanbu Cement", ar: "يُنبع" },
  { sym: "TADAWUL:3030", name: "Arabian Cement", ar: "العربية للأسمنت" },
  { sym: "TADAWUL:3040", name: "Southern Province Cement", ar: "الجنوبية" },
  { sym: "TADAWUL:3050", name: "Qassim Cement", ar: "القصيم" },
  { sym: "TADAWUL:3060", name: "Yamama Cement", ar: "اليمامة" },
  { sym: "TADAWUL:3080", name: "Eastern Province Cement", ar: "الشرقية" },
  { sym: "TADAWUL:3090", name: "Tabuk Cement", ar: "تبوك" },
  { sym: "TADAWUL:3002", name: "Najran Cement", ar: "نجران" },
  { sym: "TADAWUL:3101", name: "City Cement", ar: "المدينة" },

  // Industrial / Manufacturing
  { sym: "TADAWUL:2110", name: "Saudi Cable", ar: "الكابلات" },
  { sym: "TADAWUL:2120", name: "Saudi Advanced Industries", ar: "الصناعات المتقدمة" },
  { sym: "TADAWUL:2170", name: "Alujain", ar: "الجين" },
  { sym: "TADAWUL:4031", name: "Saudi Ground Services", ar: "الخدمات الأرضية" },

  // Insurance
  { sym: "TADAWUL:8010", name: "Tawuniya", ar: "التعاونية" },
  { sym: "TADAWUL:8020", name: "BUPA Arabia", ar: "بوبا" },
  { sym: "TADAWUL:8230", name: "Al Rajhi Cooperative Insurance", ar: "الراجحي للتأمين" },
  { sym: "TADAWUL:8160", name: "Aljazira Takaful", ar: "الجزيرة تكافل" },
  { sym: "TADAWUL:8250", name: "Walaa Insurance", ar: "ولاء" },

  // Education / Other
  { sym: "TADAWUL:4291", name: "Ataa Educational", ar: "عطاء" },
  { sym: "TADAWUL:1820", name: "Lujain Sport", ar: "لجام" },

  // Energy & Utilities (additional)
  { sym: "TADAWUL:2080", name: "GASCO", ar: "الغاز والتصنيع" },
  { sym: "TADAWUL:2083", name: "Marafiq", ar: "مرافق" },
  { sym: "TADAWUL:2381", name: "Arabian Drilling", ar: "الحفر العربية" },
  { sym: "TADAWUL:2382", name: "ADES" },

  // Materials — Metals & Mining
  { sym: "TADAWUL:1301", name: "Alyasra Foods" },
  { sym: "TADAWUL:1304", name: "Al Yamamah Steel", ar: "اليمامة للحديد" },
  { sym: "TADAWUL:1321", name: "East Pipes", ar: "الأنابيب الشرقية" },
  { sym: "TADAWUL:2090", name: "NGC" },
  { sym: "TADAWUL:2150", name: "Zoujaj", ar: "الزجاج" },
  { sym: "TADAWUL:2180", name: "FIPCO" },
  { sym: "TADAWUL:2200", name: "APC" },
  { sym: "TADAWUL:2210", name: "Nama Chemicals" },
  { sym: "TADAWUL:2223", name: "Luberef", ar: "لوبريف" },
  { sym: "TADAWUL:2300", name: "SPM" },
  { sym: "TADAWUL:2360", name: "SVCP" },

  // Cement (additional)
  { sym: "TADAWUL:3001", name: "Hail Cement", ar: "حائل للأسمنت" },
  { sym: "TADAWUL:3003", name: "City Cement", ar: "المدينة" },
  { sym: "TADAWUL:3004", name: "Northern Cement", ar: "الشمال للأسمنت" },
  { sym: "TADAWUL:3091", name: "Jouf Cement", ar: "الجوف للأسمنت" },
  { sym: "TADAWUL:3092", name: "Riyadh Cement", ar: "الرياض للأسمنت" },

  // Capital Goods & Industrial
  { sym: "TADAWUL:1212", name: "Astra Industrial", ar: "أسترا" },
  { sym: "TADAWUL:1214", name: "Shaker Group", ar: "شاكر" },
  { sym: "TADAWUL:1302", name: "Bawan", ar: "باوان" },
  { sym: "TADAWUL:2040", name: "Saudi Ceramics", ar: "السيراميك" },
  { sym: "TADAWUL:2320", name: "Al Babtain Power", ar: "البابطين" },
  { sym: "TADAWUL:4030", name: "SPPC" },
  { sym: "TADAWUL:4142", name: "Riyadh Cables", ar: "الرياض للكابلات" },

  // Transport & Logistics
  { sym: "TADAWUL:4040", name: "SAPTCO", ar: "سابتكو" },
  { sym: "TADAWUL:4261", name: "Theeb Rent A Car", ar: "ذئب" },
  { sym: "TADAWUL:4262", name: "Lumi Rental", ar: "لومي" },
  { sym: "TADAWUL:4263", name: "SAL Aviation", ar: "سال" },
  { sym: "TADAWUL:4264", name: "flynas", ar: "ناس" },

  // Consumer Services & Retail
  { sym: "TADAWUL:1810", name: "Seera Group", ar: "سيرة" },
  { sym: "TADAWUL:1830", name: "Leejam Sports", ar: "ليجام" },
  { sym: "TADAWUL:4001", name: "Abdullah Al Othaim Markets", ar: "العثيم" },
  { sym: "TADAWUL:4006", name: "Farm Superstores", ar: "المزرعة" },
  { sym: "TADAWUL:4050", name: "SASCO", ar: "ساسكو" },
  { sym: "TADAWUL:4051", name: "Baazeem Trading" },
  { sym: "TADAWUL:4163", name: "Al Dawaa", ar: "الدواء" },
  { sym: "TADAWUL:4240", name: "Cenomi Retail", ar: "سنومي للبيع بالتجزئة" },

  // Food & Beverages (additional)
  { sym: "TADAWUL:2100", name: "Wafrah" },
  { sym: "TADAWUL:2282", name: "Naqi Water", ar: "نقي" },
  { sym: "TADAWUL:2283", name: "First Mills", ar: "المطاحن الأولى" },
  { sym: "TADAWUL:2284", name: "Modern Mills", ar: "المطاحن الحديثة" },
  { sym: "TADAWUL:6001", name: "Halawani Brothers", ar: "الحلواني" },
  { sym: "TADAWUL:6010", name: "NADEC", ar: "النادك" },
  { sym: "TADAWUL:6014", name: "Alamar Foods", ar: "الأمار" },
  { sym: "TADAWUL:6015", name: "Americana Restaurants", ar: "أمريكانا" },
  { sym: "TADAWUL:6017", name: "Jahez", ar: "جاهز" },
  { sym: "TADAWUL:6040", name: "TADCO" },
  { sym: "TADAWUL:6090", name: "Saudi Dairy (SFICO)" },

  // Healthcare (additional)
  { sym: "TADAWUL:4015", name: "Jamjoom Pharma", ar: "جمجوم فارما" },
  { sym: "TADAWUL:4016", name: "Avalon Pharma", ar: "أفالون" },
  { sym: "TADAWUL:4018", name: "Al Moosa Specialist Hospital", ar: "الموسى" },
  { sym: "TADAWUL:4019", name: "SMC Healthcare" },
  { sym: "TADAWUL:4021", name: "Saudi German Health", ar: "السعودي الألماني" },
  { sym: "TADAWUL:4024", name: "Saudi German Hospital", ar: "الألماني" },

  // Financial Services
  { sym: "TADAWUL:1111", name: "Saudi Exchange (Tadawul Group)", ar: "تداول" },
  { sym: "TADAWUL:4081", name: "Nayifat Finance", ar: "نيافت" },
  { sym: "TADAWUL:4084", name: "Derayah Financial", ar: "دراية" },
  { sym: "TADAWUL:4130", name: "Saudi Darb" },
  { sym: "TADAWUL:4280", name: "Kingdom Holding", ar: "المملكة" },

  // Insurance (additional)
  { sym: "TADAWUL:8030", name: "MedGulf", ar: "ميدغلف" },
  { sym: "TADAWUL:8050", name: "Salama" },
  { sym: "TADAWUL:8060", name: "Walaa Cooperative Insurance", ar: "ولاء" },
  { sym: "TADAWUL:8070", name: "Arabian Shield", ar: "الدرع العربي" },
  { sym: "TADAWUL:8100", name: "SAICO" },
  { sym: "TADAWUL:8120", name: "Gulf Union Al Ahlia" },
  { sym: "TADAWUL:8150", name: "ACIG" },
  { sym: "TADAWUL:8170", name: "Aletihad" },
  { sym: "TADAWUL:8180", name: "Al Sagr Insurance" },
  { sym: "TADAWUL:8190", name: "UCA" },
  { sym: "TADAWUL:8200", name: "Saudi Re", ar: "إعادة التأمين" },
  { sym: "TADAWUL:8240", name: "Chubb Arabia" },
  { sym: "TADAWUL:8260", name: "Gulf General" },
  { sym: "TADAWUL:8270", name: "Buruj Cooperative Insurance" },
  { sym: "TADAWUL:8300", name: "Wataniya Insurance", ar: "الوطنية" },
  { sym: "TADAWUL:8310", name: "Amana Insurance" },

  // Real Estate & Development (additional)
  { sym: "TADAWUL:4020", name: "Alakaria", ar: "العقارية" },
  { sym: "TADAWUL:4090", name: "Taiba Investments", ar: "طيبة" },
  { sym: "TADAWUL:4100", name: "Makkah Construction" },
  { sym: "TADAWUL:4220", name: "Emaar The Economic City" },
  { sym: "TADAWUL:4250", name: "Jabal Omar" },
  { sym: "TADAWUL:4320", name: "Alandalus Property", ar: "الأندلس" },
  { sym: "TADAWUL:4321", name: "Cenomi Centers", ar: "سنومي للمراكز" },
  { sym: "TADAWUL:4322", name: "Retal Urban Development", ar: "ريتال" },
  { sym: "TADAWUL:4324", name: "Banan Real Estate", ar: "بنان" },
  { sym: "TADAWUL:4325", name: "Masar" },

  // REITs
  { sym: "TADAWUL:4330", name: "Riyad REIT", ar: "ريت الرياض" },
  { sym: "TADAWUL:4331", name: "AlJazira REIT", ar: "ريت الجزيرة" },
  { sym: "TADAWUL:4332", name: "Jadwa REIT Al Haramain", ar: "ريت الحرمين" },
  { sym: "TADAWUL:4333", name: "Taleem REIT", ar: "ريت تعليم" },
  { sym: "TADAWUL:4334", name: "Al Maather REIT", ar: "ريت المعذر" },
  { sym: "TADAWUL:4335", name: "Musharaka REIT" },
  { sym: "TADAWUL:4336", name: "Mulkia REIT" },
  { sym: "TADAWUL:4339", name: "Derayah REIT", ar: "ريت دراية" },
  { sym: "TADAWUL:4340", name: "Al Rajhi REIT", ar: "ريت الراجحي" },
  { sym: "TADAWUL:4342", name: "Jadwa REIT Saudi", ar: "ريت جدوى" },
  { sym: "TADAWUL:4344", name: "SEDCO Capital REIT", ar: "ريت سدكو" },
  { sym: "TADAWUL:4345", name: "Alinma Retail REIT", ar: "ريت الإنماء" },
  { sym: "TADAWUL:4346", name: "MEFIC REIT" },
  { sym: "TADAWUL:4347", name: "Bonyan REIT", ar: "ريت بنيان" },
  { sym: "TADAWUL:4348", name: "Alkhabeer REIT", ar: "ريت الخبير" },

  // Media & Entertainment
  { sym: "TADAWUL:4072", name: "MBC Group", ar: "MBC" },
  { sym: "TADAWUL:4210", name: "SRMG", ar: "السعودي للأبحاث" },

  // Telecom (additional)
  { sym: "TADAWUL:7040", name: "GO Telecom", ar: "GO" },

  // Technology & Software
  { sym: "TADAWUL:7202", name: "Solutions by STC", ar: "حلول" },
  { sym: "TADAWUL:7204", name: "2P" },
  { sym: "TADAWUL:7211", name: "AZM" },
];

// ── US Equity ─────────────────────────────────────────────────────────────────
export const US_EQUITY_STOCKS = [
  { sym: "NASDAQ:AAPL",  name: "Apple" },
  { sym: "NASDAQ:NVDA",  name: "NVIDIA" },
  { sym: "NASDAQ:MSFT",  name: "Microsoft" },
  { sym: "NASDAQ:AMZN",  name: "Amazon" },
  { sym: "NASDAQ:META",  name: "Meta Platforms" },
  { sym: "NASDAQ:GOOGL", name: "Alphabet" },
  { sym: "NASDAQ:TSLA",  name: "Tesla" },
  { sym: "NASDAQ:AVGO",  name: "Broadcom" },
  { sym: "NASDAQ:COST",  name: "Costco" },
  { sym: "NASDAQ:NFLX",  name: "Netflix" },
  { sym: "NYSE:JPM",     name: "JPMorgan Chase" },
  { sym: "NYSE:V",       name: "Visa" },
  { sym: "NYSE:UNH",     name: "UnitedHealth" },
  { sym: "NYSE:XOM",     name: "ExxonMobil" },
  { sym: "NYSE:WMT",     name: "Walmart" },
  { sym: "NYSE:BAC",     name: "Bank of America" },
  { sym: "NYSE:MA",      name: "Mastercard" },
  { sym: "NYSE:JNJ",     name: "Johnson & Johnson" },
  { sym: "NYSE:PG",      name: "Procter & Gamble" },
  { sym: "NYSE:HD",      name: "Home Depot" },
];

// ── ETFs ──────────────────────────────────────────────────────────────────────
export const ETF_STOCKS = [
  { sym: "NASDAQ:QQQ",  name: "Invesco QQQ (NASDAQ 100)" },
  { sym: "NYSE:SPY",    name: "SPDR S&P 500 ETF" },
  { sym: "NYSE:IWM",    name: "iShares Russell 2000" },
  { sym: "NYSE:DIA",    name: "SPDR Dow Jones Industrial" },
  { sym: "NYSE:VTI",    name: "Vanguard Total Stock Market" },
  { sym: "NYSE:GLD",    name: "SPDR Gold Shares" },
  { sym: "NYSE:SLV",    name: "iShares Silver Trust" },
  { sym: "NYSE:USO",    name: "United States Oil Fund" },
  { sym: "NYSE:TLT",    name: "iShares 20+ Year Treasury" },
  { sym: "NYSE:EEM",    name: "iShares MSCI Emerging Markets" },
  { sym: "NYSE:XLK",    name: "Technology Select SPDR" },
  { sym: "NYSE:XLF",    name: "Financial Select SPDR" },
  { sym: "NASDAQ:ARKK", name: "ARK Innovation ETF" },
  { sym: "NYSE:IEMG",   name: "iShares Core MSCI EM" },
];

// ── Crypto ────────────────────────────────────────────────────────────────────
export const CRYPTO_STOCKS = [
  { sym: "BITSTAMP:BTCUSD",  name: "Bitcoin" },
  { sym: "BITFINEX:XRPUSD",  name: "XRP" },
  { sym: "COINBASE:ETHUSD",  name: "Ethereum" },
  { sym: "BINANCE:SOLUSDT",  name: "Solana" },
  { sym: "BINANCE:BNBUSDT",  name: "BNB" },
  { sym: "COINBASE:AVAXUSD", name: "Avalanche" },
  { sym: "BINANCE:ADAUSDT",  name: "Cardano" },
];

// ── Commodities ───────────────────────────────────────────────────────────────
export const COMMODITY_STOCKS = [
  { sym: "TVC:GOLD",       name: "Gold (XAU)" },
  { sym: "TVC:SILVER",     name: "Silver (XAG)" },
  { sym: "TVC:USOIL",      name: "WTI Crude Oil" },
  { sym: "TVC:NATURALGAS", name: "Natural Gas" },
  { sym: "TVC:COPPER",     name: "Copper" },
];

// ── Index benchmark per market (for Relative Strength) ───────────────────────
export const INDEX_FOR_MARKET = {
  tasi:      "TADAWUL:TASI",
  us:        "NASDAQ:QQQ",
  etf:       "NYSE:SPY",
  crypto:    "BITSTAMP:BTCUSD",
  commodity: "TVC:GOLD",
};

// ── Universe lookup ───────────────────────────────────────────────────────────
const ALL_UNIVERSE = [...TASI_STOCKS, ...US_EQUITY_STOCKS, ...ETF_STOCKS, ...CRYPTO_STOCKS, ...COMMODITY_STOCKS];
const UNIVERSE_MAP = new Map(ALL_UNIVERSE.map(s => [s.sym, s]));

export function getUniverseByMarket(market) {
  switch (market) {
    case "tasi":      return TASI_STOCKS;
    case "us":        return US_EQUITY_STOCKS;
    case "etf":       return ETF_STOCKS;
    case "crypto":    return CRYPTO_STOCKS;
    case "commodity": return COMMODITY_STOCKS;
    case "all":       return ALL_UNIVERSE;
    default:          return TASI_STOCKS;
  }
}

// ── Technical Calculations ────────────────────────────────────────────────────
function emaArray(closes, period) {
  const k = 2 / (period + 1);
  const out = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function macdHist(closes) {
  if (closes.length < 35) return null;
  const e12 = emaArray(closes, 12);
  const e26 = emaArray(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  // Signal starts from bar 25 (first valid EMA 26 bar) with period 9
  const validMacd = macdLine.slice(25);
  if (validMacd.length < 9) return null;
  const signal = emaArray(validMacd, 9);
  const lastMacd = validMacd[validMacd.length - 1];
  const lastSignal = signal[signal.length - 1];
  const prevHist = validMacd.length >= 2
    ? validMacd[validMacd.length - 2] - signal[signal.length - 2]
    : null;
  return { macd: lastMacd, signal: lastSignal, hist: lastMacd - lastSignal, prevHist };
}

function volumeCheck(volumes, isTasi = false) {
  if (volumes.length < 20) return { ratio: null, ok: false };
  const sma20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVol = volumes[volumes.length - 1];
  const ratio = lastVol / sma20;
  // TASI stocks have tighter floats — 1.2× is sufficient confirmation
  const baseThreshold = isTasi ? 1.2 : 1.5;
  return { ratio: Math.round(ratio * 100) / 100, ok: ratio >= baseThreshold, baseThreshold };
}

// Returns array of RSI values (null for first period bars)
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; d >= 0 ? g += d : l -= d; }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    g = (g * (period-1) + Math.max(d, 0)) / period;
    l = (l * (period-1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

// Detects bullish/bearish RSI divergence over last `lookback` bars
function detectDivergence(closes, rsiVals, lookback = 30) {
  const n = closes.length;
  if (n < lookback + 5 || !rsiVals) return null;
  const pc = closes.slice(-lookback);
  const pr = rsiVals.slice(-lookback).filter(v => v !== null);
  if (pr.length < 10) return null;
  const half = Math.floor(pc.length / 2);
  const minP1 = Math.min(...pc.slice(0, half)), minP2 = Math.min(...pc.slice(half));
  const maxP1 = Math.max(...pc.slice(0, half)), maxP2 = Math.max(...pc.slice(half));
  const half2 = Math.floor(pr.length / 2);
  const minR1 = Math.min(...pr.slice(0, half2)), minR2 = Math.min(...pr.slice(half2));
  const maxR1 = Math.max(...pr.slice(0, half2)), maxR2 = Math.max(...pr.slice(half2));
  // Bullish: price lower low, RSI higher low — selling pressure weakening
  if (minP2 < minP1 * 0.985 && minR2 > minR1 + 4 && minR2 < 52) return "bullish";
  // Bearish: price higher high, RSI lower high — buying pressure fading
  if (maxP2 > maxP1 * 1.015 && maxR2 < maxR1 - 4 && maxR2 > 48) return "bearish";
  return null;
}

// Pivot-based support/resistance detection
function findSRLevels(highs, lows, closes, swing = 5) {
  const n = closes.length;
  const raw = [];
  for (let i = swing; i < n - swing; i++) {
    const isHigh = highs.slice(i-swing, i).every(h => h <= highs[i]) && highs.slice(i+1, i+swing+1).every(h => h <= highs[i]);
    const isLow  = lows.slice(i-swing, i).every(l => l >= lows[i])  && lows.slice(i+1, i+swing+1).every(l => l >= lows[i]);
    if (isHigh) raw.push({ p: highs[i], type: "R", age: n - i });
    if (isLow)  raw.push({ p: lows[i],  type: "S", age: n - i });
  }
  // Cluster within 0.8% and keep most recent
  const clustered = [];
  for (const lv of raw.sort((a, b) => a.age - b.age)) {
    if (!clustered.some(c => Math.abs(c.p - lv.p) / lv.p < 0.008)) clustered.push(lv);
    if (clustered.length >= 10) break;
  }
  const price = closes[n - 1];
  return {
    support:    clustered.filter(l => l.type === "S" && l.p < price).sort((a,b) => b.p - a.p).slice(0,4).map(l => l.p),
    resistance: clustered.filter(l => l.type === "R" && l.p > price).sort((a,b) => a.p - b.p).slice(0,4).map(l => l.p),
  };
}

// ── Whale detection metrics ────────────────────────────────────────────────────
export function calcMFI(highs, lows, closes, volumes, period = 14) {
  if (closes.length < period + 1) return null;
  const tp  = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const mf  = tp.map((t, i) => t * (volumes[i] || 0));
  const len = closes.length;
  let pos = 0, neg = 0;
  for (let i = len - period; i < len; i++) {
    if (tp[i] >= tp[i - 1]) pos += mf[i]; else neg += mf[i];
  }
  if (neg === 0) return 100;
  return +(100 - 100 / (1 + pos / neg)).toFixed(1);
}

export function calcOBVTrend(closes, volumes, period = 20) {
  if (closes.length < period + 1) return null;
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    const v = volumes[i] || 0;
    obv.push(obv[i-1] + (closes[i] > closes[i-1] ? v : closes[i] < closes[i-1] ? -v : 0));
  }
  const slice = obv.slice(-period);
  // Simple linear regression slope
  const n = slice.length, meanX = (n-1)/2, meanY = slice.reduce((a,b)=>a+b,0)/n;
  let num = 0, den = 0;
  slice.forEach((y, x) => { num += (x-meanX)*(y-meanY); den += (x-meanX)**2; });
  if (den === 0) return 'flat';
  const slope = num / den;
  return slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat';
}

export function calcVolumeZScore(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const slice = volumes.slice(-period - 1, -1); // exclude latest bar from baseline
  const mean = slice.reduce((a, b) => a + (b||0), 0) / period;
  const std  = Math.sqrt(slice.reduce((a, b) => a + ((b||0) - mean) ** 2, 0) / period);
  if (std === 0) return 0;
  return +((volumes[volumes.length - 1] - mean) / std).toFixed(2);
}

// Hurst Exponent via Rescaled Range (R/S) analysis.
// H > 0.55 → trending (momentum), H < 0.45 → mean-reverting, 0.45–0.55 → random walk.
// Uses last 200 bars with lags 10–80 to keep sub-period count ≥ 3.
export function calcHurst(closes) {
  const prices = closes.slice(-200);
  if (prices.length < 50) return null;

  const logR = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) logR.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (logR.length < 30) return null;

  const maxLag = Math.min(80, Math.floor(logR.length / 3));
  const lags = [], rsArr = [];

  for (let lag = 10; lag <= maxLag; lag += Math.max(1, Math.floor(lag / 4))) {
    const M = Math.floor(logR.length / lag);
    if (M < 2) continue;
    let rsSum = 0, count = 0;
    for (let m = 0; m < M; m++) {
      const sub  = logR.slice(m * lag, (m + 1) * lag);
      const mean = sub.reduce((a, b) => a + b, 0) / lag;
      const dm   = sub.map(x => x - mean);
      let cum = 0;
      const cs = dm.map(x => (cum += x));
      const R  = Math.max(...cs) - Math.min(...cs);
      const S  = Math.sqrt(sub.reduce((a, x) => a + (x - mean) ** 2, 0) / lag);
      if (S > 0) { rsSum += R / S; count++; }
    }
    if (count > 0 && rsSum / count > 0) {
      lags.push(Math.log(lag));
      rsArr.push(Math.log(rsSum / count));
    }
  }
  if (lags.length < 4) return null;

  const n   = lags.length;
  const sx  = lags.reduce((a, b) => a + b, 0);
  const sy  = rsArr.reduce((a, b) => a + b, 0);
  const sxy = lags.reduce((a, x, i) => a + x * rsArr[i], 0);
  const sx2 = lags.reduce((a, x) => a + x * x, 0);
  const den = n * sx2 - sx * sx;
  if (den === 0) return null;

  const H = (n * sxy - sx * sy) / den;
  return +Math.max(0, Math.min(1, H)).toFixed(2);
}

// ATR Percentile Rank: where is today's ATR relative to the past `lookback` days?
// Returns 0–100. Low (≤20) = volatility compressed (coil). High (≥80) = volatility expanded (dangerous to chase).
export function calcATRPercentileRank(highs, lows, closes, period = 14, lookback = 252) {
  const n = closes.length;
  if (n < period + 1) return null;

  // Build full TR series
  const tr = [];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  if (tr.length < period) return null;

  // Wilder-smoothed ATR series
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const atrSeries = [atr];
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    atrSeries.push(atr);
  }

  const window = atrSeries.slice(-Math.min(lookback, atrSeries.length));
  if (window.length < 20) return null;

  const current = window[window.length - 1];
  const rank = Math.round(window.filter(v => v <= current).length / window.length * 100);
  return rank;
}

// ── Style tag auto-detection ──────────────────────────────────────────────────
// Assigns up to 2 style badges per stock. Replaces the mode concept.
export function computeStyleTags(r) {
  const tags = [];
  const { ema13, ema34, ema89, ema200 } = r.emas || {};
  const emaStack = ema13 > ema34 && ema34 > ema89;
  const price = r.price || 0;
  const isBull = !['STRONG SELL','SELL','AVOID'].includes(r.bias) && r.bias !== 'SKIP';

  if (!isBull) {
    if (r.vol_ratio >= 2.0 && r.rs_score != null && r.rs_score < -1.0) tags.push('Breakout');
    return tags;
  }

  // Momentum: RSI 55-70, MACD positive, vol >1.5x, solid score
  if (r.rsi >= 55 && r.rsi < 72 && r.macd_hist > 0 && r.vol_ratio >= 1.5 && r.score >= 6) tags.push('Momentum');

  // Trend: EMA stack + above 200 + Hurst trending or unknown
  if (emaStack && price > (ema200 || 0) && (r.hurst == null || r.hurst > 0.5)) tags.push('Trend');

  // Breakout: volume surge + RS leadership + score
  if (r.vol_ratio >= 2.0 && r.rs_score != null && r.rs_score > 1.0 && r.score >= 5) tags.push('Breakout');

  // Recovery: RSI building from oversold while price coiling
  if (r.rsi_buildup?.is_building) tags.push('Recovery');

  // Pullback: price touching EMA34 in uptrend (buying the dip)
  if (emaStack && price > (ema200 || 0) && ema34 && Math.abs(price - ema34) / ema34 < 0.015) tags.push('Pullback');

  return tags.slice(0, 2);
}

// Rolling VWAP anchored to the last `period` daily bars.
// Returns the volume-weighted average price of the window, or null if data is insufficient.
export function calcVWAP(highs, lows, closes, volumes, period = 20) {
  if (closes.length < period) return null;
  let cumTPV = 0, cumVol = 0;
  const start = closes.length - period;
  for (let i = start; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const v  = volumes[i] || 0;
    cumTPV  += tp * v;
    cumVol  += v;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function linSlope(arr) {
  const n = arr.length, mx = (n-1)/2;
  const my = arr.reduce((a,b)=>a+b,0)/n;
  let num=0, den=0;
  arr.forEach((y,x)=>{ num+=(x-mx)*(y-my); den+=(x-mx)**2; });
  return den===0 ? 0 : num/den;
}

export function calcVolatilityCompression(closes, highs, lows, volumes) {
  const n = closes.length;
  if (n < 30) return null;
  // True ranges for last 30 bars
  const trs = [];
  for (let i = n-30; i < n; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i-1]),
      Math.abs(lows[i]  - closes[i-1])
    ));
  }
  const recentTR = trs.slice(-5).reduce((a,b)=>a+b,0)/5;
  const histTR   = trs.slice(0,-5).reduce((a,b)=>a+b,0)/25;
  const atrRatio  = histTR>0 ? +(recentTR/histTR).toFixed(2) : 1;
  const price     = closes[n-1];
  const rangePct  = +((Math.max(...highs.slice(-5)) - Math.min(...lows.slice(-5)))/price).toFixed(3);
  const vol5      = volumes.slice(-5).reduce((a,b)=>a+(b||0),0)/5;
  const vol20     = volumes.slice(-20).reduce((a,b)=>a+(b||0),0)/20;
  const volRatio5 = +(vol20>0 ? vol5/vol20 : 1).toFixed(2);
  return {
    atr_ratio:   atrRatio,
    range_pct:   rangePct,
    vol_ratio_5d: volRatio5,
    is_compressed: atrRatio<0.75 && rangePct<0.03 && volRatio5<0.65,
  };
}

export function calcRsiBuildup(closes, rsiVals) {
  if (!rsiVals || rsiVals.length < 12) return null;
  const n = closes.length;
  const rsiSlice   = rsiVals.slice(-10);
  const priceSlice = closes.slice(-10);
  const rsiSlope   = +linSlope(rsiSlice).toFixed(2);
  const priceSlope = priceSlice[0]>0 ? +(linSlope(priceSlice)/priceSlice[0]*100).toFixed(3) : 0;
  const rsiNow     = +rsiVals[rsiVals.length-1].toFixed(1);
  return {
    rsi_slope:        rsiSlope,
    price_slope_pct:  priceSlope,
    rsi_now:          rsiNow,
    is_building: rsiSlope>0.4 && Math.abs(priceSlope)<0.15 && rsiNow>28 && rsiNow<52,
  };
}

function calcWhaleScore(mfi, obvTrend, volRatio, zScore, bias) {
  const bear = ['STRONG SELL','SELL','AVOID'].includes(bias);
  let score = 0;
  // MFI component (3 pts)
  if (mfi != null) {
    if (!bear && mfi > 80) score += 3; else if (!bear && mfi > 65) score += 2; else if (!bear && mfi > 55) score += 1;
    if ( bear && mfi < 20) score += 3; else if ( bear && mfi < 35) score += 2; else if ( bear && mfi < 45) score += 1;
  }
  // OBV component (2 pts)
  if ((!bear && obvTrend === 'rising') || (bear && obvTrend === 'falling')) score += 2;
  // Z-score component (3 pts)
  if (zScore != null) {
    if (zScore > 3) score += 3; else if (zScore > 2) score += 2; else if (zScore > 1.5) score += 1;
  }
  // vol_ratio component (2 pts)
  if (volRatio >= 5) score += 2; else if (volRatio >= 3) score += 1;
  return score; // max 10
}

// Average return per calendar month (seasonality)
function computeSeasonality(closes, times) {
  const monthly = {};
  for (let i = 1; i < closes.length; i++) {
    const m = new Date((times[i] || 0) * 1000).getMonth() + 1;
    if (!monthly[m]) monthly[m] = [];
    monthly[m].push((closes[i] - closes[i-1]) / closes[i-1] * 100);
  }
  const out = {};
  for (const [m, arr] of Object.entries(monthly)) {
    out[m] = Math.round(arr.reduce((a,b)=>a+b,0) / arr.length * 100) / 100;
  }
  return out;
}

function atrCalc(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  let val = sum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    val = (val * (period - 1) + tr) / period;
  }
  return val;
}

// ── Bias Scoring ──────────────────────────────────────────────────────────────
function scoreBias(emas, rsiVal, macdData, volData, price, mode = 'swing', rsScore = null, context = {}) {
  const { ema13, ema34, ema89, ema200 } = emas;
  const { srLevels, avgVolume, rsScore60d, isExtended, vwap20, obv_trend, isTasi } = context;
  const bullFlags = [], bearFlags = [], warnings = [];
  // maxScore 9 in swing/position (8 criteria + 1 VWAP); breakout stays 8
  const maxScore = mode === 'breakout' ? 8 : 9;

  // ── Breakout mode scoring ─────────────────────────────────────────────────
  if (mode === 'breakout') {
    let bullish = 0;
    let bearish = 0;

    // Bullish breakout (8 pts): 2+2+2+1+1
    if (price > ema200) {
      bullish += 2; bullFlags.push("Above EMA 200 ✓");
    }
    if (volData.ratio !== null && volData.ratio >= 2.0) {
      bullish += 2; bullFlags.push(`Breakout Volume ${volData.ratio}× ✓`);
    } else if (volData.ratio !== null) {
      warnings.push(`Volume ${volData.ratio}× (need 2× for breakout)`);
    }
    if (rsScore !== null && rsScore > 1.0) {
      bullish += 2; bullFlags.push(`RS +${rsScore}% vs index ✓`);
    } else if (rsScore !== null) {
      warnings.push(`RS ${rsScore > 0 ? '+' : ''}${rsScore}% (need >+1% vs index)`);
    }
    if (rsiVal !== null && rsiVal >= 50 && rsiVal <= 75) {
      bullish += 1; bullFlags.push(`RSI ${rsiVal.toFixed(1)} momentum zone ✓`);
    } else if (rsiVal !== null && rsiVal > 75) {
      warnings.push(`RSI ${rsiVal.toFixed(1)} — overbought`);
    }
    if (macdData && macdData.hist > 0) {
      const crossing     = macdData.prevHist !== null && macdData.prevHist <= 0;
      const accelerating = macdData.prevHist !== null && macdData.hist > macdData.prevHist;
      if (crossing || accelerating) {
        bullish += 1; bullFlags.push(`MACD ${crossing ? 'crossing ✓' : 'accelerating ✓'}`);
      } else {
        warnings.push('MACD positive but flat/decelerating');
      }
    }

    // Bearish breakout (8 pts): 2+2+2+1+1
    if (price < ema200) {
      bearish += 2; bearFlags.push("Below EMA 200 ✓");
    }
    if (volData.ratio !== null && volData.ratio >= 2.0) {
      bearish += 2; bearFlags.push(`Breakdown Volume ${volData.ratio}× ✓`);
    }
    if (rsScore !== null && rsScore < -1.0) {
      bearish += 2; bearFlags.push(`RS ${rsScore}% vs index ✓`);
    }
    if (rsiVal !== null && rsiVal > 25 && rsiVal <= 50) {
      bearish += 1; bearFlags.push(`RSI ${rsiVal.toFixed(1)} weak zone ✓`);
    } else if (rsiVal !== null && rsiVal <= 25) {
      warnings.push(`RSI ${rsiVal.toFixed(1)} — oversold (potential bounce)`);
    }
    if (macdData && macdData.hist < 0) {
      const crossing     = macdData.prevHist !== null && macdData.prevHist >= 0;
      const accelerating = macdData.prevHist !== null && macdData.hist < macdData.prevHist;
      if (crossing || accelerating) {
        bearish += 1; bearFlags.push(`MACD ${crossing ? 'crossing ✓' : 'accelerating ✓'}`);
      } else {
        warnings.push('MACD negative but flat/recovering');
      }
    }

    let bias, score, flags;
    if (bearish > bullish) {
      score = bearish; flags = bearFlags;
      if (bearish >= 7) bias = "STRONG SELL";
      else if (bearish >= 5) bias = "SELL";
      else if (bearish >= 3) bias = "AVOID";
      else bias = "SKIP";
    } else if (bullish > bearish) {
      score = bullish; flags = bullFlags;
      if (bullish >= 7) bias = "STRONG BUY";
      else if (bullish >= 5) bias = "BUY";
      else if (bullish >= 3) bias = "WATCH";
      else bias = "SKIP";
    } else {
      score = bullish; flags = []; bias = "SKIP";
    }

    const pct = Math.round((score / maxScore) * 100);
    const proximity = {
      emaStack: ema13 != null && ema34 != null ? +((ema13 - ema34) / ema34 * 100).toFixed(2) : null,
      ema200:   price != null && ema200 != null ? +((price - ema200) / ema200 * 100).toFixed(2) : null,
      rsi:      rsiVal != null ? +(rsiVal - 52).toFixed(1) : null,
      macd:     macdData ? +macdData.hist.toFixed(5) : null,
      pts_to_buy:  Math.max(0, 5 - bullish),
      pts_to_sell: Math.max(0, 5 - bearish),
      bull: bullish,
      bear: bearish,
    };
    return { bias, score, maxScore, pct, bullish_score: bullish, bearish_score: bearish, flags, warnings, proximity };
  }

  // ── Swing / Position mode scoring (default) ───────────────────────────────
  let bullish = 0;

  if (ema13 > ema34 && ema34 > ema89) {
    bullish += 2; bullFlags.push("EMA stack ✓");
  } else {
    warnings.push("EMA stack not aligned");
  }

  // EMA200: 1 pt (not 2). Second pt replaced by OBV slope for smarter accumulation detection.
  if (price > ema200) {
    bullish += 1; bullFlags.push("Above EMA 200 ✓");
  }
  // OBV slope: 1 pt — rising OBV = institutions accumulating regardless of price noise
  if (obv_trend === 'rising') {
    bullish += 1; bullFlags.push("OBV rising (accumulation) ✓");
  } else if (obv_trend === 'falling') {
    warnings.push("OBV falling — distribution pressure detected");
  }

  if (rsiVal !== null) {
    // Cap raised to 85: real breakout momentum can sustain RSI 80-85.
    // Flag "Stretched" above 80 as a caution, not a disqualifier.
    if (rsiVal >= 52 && rsiVal <= 85) {
      const stretched = rsiVal > 80;
      bullish += 2; bullFlags.push(`RSI ${rsiVal.toFixed(1)} ✓${stretched ? ' ⚡ Stretched' : ''}`);
    } else if (rsiVal > 85) {
      warnings.push(`RSI ${rsiVal.toFixed(1)} — extreme overbought, elevated reversal risk`);
    }
  }

  if (macdData && macdData.hist > 0) {
    // Any positive MACD histogram counts — stocks in sustained uptrends naturally have positive MACD.
    // Label crossing/accelerating for additional context but don't gate on them.
    const crossing = macdData.prevHist !== null && macdData.prevHist <= 0;
    const accel    = macdData.prevHist !== null && macdData.hist > macdData.prevHist;
    const label    = crossing ? 'crossing ✓' : accel ? 'accelerating ✓' : 'positive ✓';
    bullish += 1; bullFlags.push(`MACD ${label}`);
  }

  {
    const thinStock   = avgVolume != null && avgVolume < 300000;
    const baseThr     = volData.baseThreshold ?? (isTasi ? 1.2 : 1.5);
    const volThreshold = thinStock ? 2.0 : baseThr;
    if (volData.ratio !== null && volData.ratio >= volThreshold) {
      bullish += 1; bullFlags.push(`Volume ${volData.ratio}× ✓${thinStock ? ' (thin)' : ''}`);
    } else if (volData.ratio !== null) {
      warnings.push(`Volume ${volData.ratio}× (need ${volThreshold}×${thinStock ? ' — thin stock' : ''})`);
    }
  }

  if (vwap20 != null) {
    if (price > vwap20) { bullish += 1; bullFlags.push(`Above VWAP (${vwap20.toFixed(2)}) ✓`); }
    else { warnings.push(`Below VWAP (${vwap20.toFixed(2)})`); }
  }

  // Penalty: price within 3% below a key resistance level — unfavourable entry point
  if (srLevels?.resistance?.length) {
    const nearRes = srLevels.resistance.some(r => r > price && (r - price) / price < 0.03);
    if (nearRes && bullish >= 4) {
      bullish = Math.max(0, bullish - 1);
      warnings.push('Near key resistance — entry risk elevated');
    }
  }

  // ── Bearish criteria (9 pts, mirrored) ───────────────────────────────────
  let bearish = 0;

  if (ema13 < ema34 && ema34 < ema89) {
    bearish += 2; bearFlags.push("EMA stack inverted ✓");
  }
  if (price < ema200) {
    bearish += 1; bearFlags.push("Below EMA 200 ✓");
  }
  if (obv_trend === 'falling') {
    bearish += 1; bearFlags.push("OBV falling (distribution) ✓");
  } else if (obv_trend === 'rising') {
    warnings.push("OBV rising — buying pressure building");
  }

  if (rsiVal !== null) {
    if (rsiVal >= 15 && rsiVal <= 43) {
      bearish += 2; bearFlags.push(`RSI ${rsiVal.toFixed(1)} weak ✓`);
    } else if (rsiVal < 15) {
      warnings.push(`RSI ${rsiVal.toFixed(1)} — extreme oversold (potential bounce)`);
    }
  }
  if (macdData && macdData.hist < 0) {
    const crossing = macdData.prevHist !== null && macdData.prevHist >= 0;
    const accel    = macdData.prevHist !== null && macdData.hist < macdData.prevHist;
    const label    = crossing ? 'crossing ✓' : accel ? 'accelerating ✓' : 'negative ✓';
    bearish += 1; bearFlags.push(`MACD ${label}`);
  }
  {
    const thinStock    = avgVolume != null && avgVolume < 300000;
    const baseThr      = volData.baseThreshold ?? (isTasi ? 1.2 : 1.5);
    const volThreshold = thinStock ? 2.0 : baseThr;
    if (volData.ratio !== null && volData.ratio >= volThreshold) {
      bearish += 1; bearFlags.push(`Volume ${volData.ratio}× ✓${thinStock ? ' (thin)' : ''}`);
    } else if (volData.ratio !== null) {
      warnings.push(`Volume ${volData.ratio}× (need ${volThreshold}×${thinStock ? ' — thin stock' : ''})`);
    }
  }

  if (vwap20 != null) {
    if (price < vwap20) { bearish += 1; bearFlags.push(`Below VWAP (${vwap20.toFixed(2)}) ✓`); }
    else { warnings.push(`Above VWAP (${vwap20.toFixed(2)}) — selling pressure below VWAP threshold`); }
  }

  // Penalty: price within 3% above a key support level (potential bounce) — reduces conviction
  if (srLevels?.support?.length) {
    const nearSup = srLevels.support.some(s => s < price && (price - s) / price < 0.03);
    if (nearSup && bearish >= 4) {
      bearish = Math.max(0, bearish - 1);
      warnings.push('Near key support — potential bounce risk');
    }
  }

  // ── Direction & label ─────────────────────────────────────────────────────
  let bias, score, flags;

  if (bearish > bullish) {
    score = bearish; flags = bearFlags;
    if (bearish >= 7) bias = "STRONG SELL";
    else if (bearish >= 5) bias = "SELL";
    else if (bearish >= 3) bias = "AVOID";
    else bias = "SKIP";
  } else if (bullish > bearish) {
    score = bullish; flags = bullFlags;
    if (bullish >= 7) bias = "STRONG BUY";
    else if (bullish >= 5) bias = "BUY";
    else if (bullish >= 3) bias = "WATCH";
    else bias = "SKIP";
  } else {
    score = bullish; flags = []; bias = "SKIP";
  }

  const pct = Math.round((score / maxScore) * 100);

  // ── Proximity: how close each criterion is to flipping ────────────────────
  // Positive = moving toward bullish, Negative = moving toward bearish
  // Used for pre-signal detection and "approaching" indicators
  const proximity = {
    // EMA stack: % gap between ema13 and ema34 (positive = 13 above 34)
    emaStack: ema13 != null && ema34 != null
      ? +((ema13 - ema34) / ema34 * 100).toFixed(2)
      : null,
    // EMA 200: % above/below
    ema200: price != null && ema200 != null
      ? +((price - ema200) / ema200 * 100).toFixed(2)
      : null,
    // RSI: signed distance from nearest zone boundary
    // Positive = above 52 (bullish zone), Negative = below 52
    rsi: rsiVal != null ? +(rsiVal - 52).toFixed(1) : null,
    // MACD histogram value (signed; 0 = crossover)
    macd: macdData ? +macdData.hist.toFixed(5) : null,
    // Points away from next bias upgrade (positive = needs fewer points)
    pts_to_buy:  Math.max(0, 5 - bullish),
    pts_to_sell: Math.max(0, 5 - bearish),
    // Scores on each side
    bull: bullish,
    bear: bearish,
  };

  return { bias, score, maxScore, pct, bullish_score: bullish, bearish_score: bearish, flags, warnings, proximity };
}

// ── Pattern Recognition Engine ────────────────────────────────────────────────
// Returns array of detected chart patterns. All inputs are full OHLCV arrays (260 bars).
// Uses only the last 5–20 bars for each pattern — the full arrays are just passed for convenience.
export function detectPatterns(closes, highs, lows, volumes, atrVal, avgVol20d) {
  const patterns = [];
  const n = closes.length;
  if (n < 20) return patterns;

  const price = closes[n - 1];

  // 1. Inside Bar — today's range contained within yesterday's (volatility compression)
  if (highs[n - 1] < highs[n - 2] && lows[n - 1] > lows[n - 2]) {
    patterns.push({ name: 'Inside Bar', tag: 'inside_bar', bullish: true,
      desc: 'Range inside prior bar — volatility compressing, breakout pending' });
  }

  // 2. Volume Dry-Up — declining participation while price holds (smart money absorbing)
  if (avgVol20d > 0 && n >= 4) {
    const v3avg = (volumes[n - 1] + volumes[n - 2] + volumes[n - 3]) / 3;
    const barRange = highs[n - 1] - lows[n - 1];
    const priceInUpperHalf = barRange > 0 ? (price - lows[n - 1]) / barRange > 0.4 : false;
    if (v3avg < avgVol20d * 0.65 && priceInUpperHalf) {
      patterns.push({ name: 'Vol Dry-Up', tag: 'vol_dry_up', bullish: true,
        desc: 'Volume declining while price holds near high — supply being absorbed' });
    }
  }

  // 3. Higher Lows — 3 consecutive swing lows each higher than previous (buyer pressure building)
  // Uses 2-bar confirmation to avoid false pivots in a 15-bar window
  if (n >= 15) {
    const lows15 = lows.slice(-15);
    const swingLows = [];
    for (let i = 1; i < lows15.length - 1; i++) {
      if (lows15[i] <= lows15[i - 1] && lows15[i] <= lows15[i + 1]) swingLows.push(lows15[i]);
    }
    if (swingLows.length >= 3) {
      const last3 = swingLows.slice(-3);
      if (last3[1] > last3[0] && last3[2] > last3[1]) {
        patterns.push({ name: 'Higher Lows', tag: 'higher_lows', bullish: true,
          desc: 'Three rising swing lows — buyers stepping in higher each time' });
      }
    }
  }

  // 4. Bull Flag — impulse move followed by tight consolidation
  if (n >= 11) {
    const impulseClose = closes[n - 6], impulseOpen = closes[n - 11];
    const impulsePct = impulseOpen > 0 ? (impulseClose - impulseOpen) / impulseOpen : 0;
    const impulseH = Math.max(...highs.slice(-10, -5));
    const impulseL = Math.min(...lows.slice(-10, -5));
    const impulseRange = impulseH - impulseL;
    const consH = Math.max(...highs.slice(-5));
    const consL = Math.min(...lows.slice(-5));
    const consRange = consH - consL;
    if (impulsePct >= 0.04 && impulseRange > 0 && consRange < impulseRange * 0.4 && price > impulseClose * 0.98) {
      patterns.push({ name: 'Bull Flag', tag: 'bull_flag', bullish: true,
        desc: `${(impulsePct * 100).toFixed(1)}% impulse, tight consolidation — continuation setup` });
    }
  }

  // 5. Bear Flag — same logic for downside continuation
  if (n >= 11) {
    const impulseClose = closes[n - 6], impulseOpen = closes[n - 11];
    const impulsePct = impulseOpen > 0 ? (impulseOpen - impulseClose) / impulseOpen : 0;
    const impulseH = Math.max(...highs.slice(-10, -5));
    const impulseL = Math.min(...lows.slice(-10, -5));
    const impulseRange = impulseH - impulseL;
    const consH = Math.max(...highs.slice(-5));
    const consL = Math.min(...lows.slice(-5));
    const consRange = consH - consL;
    if (impulsePct >= 0.04 && impulseRange > 0 && consRange < impulseRange * 0.4 && price < impulseClose * 1.02) {
      patterns.push({ name: 'Bear Flag', tag: 'bear_flag', bullish: false,
        desc: `${(impulsePct * 100).toFixed(1)}% decline, tight consolidation — downside continuation` });
    }
  }

  // 6. Coil at High — price holding near 20-day high with ATR contracting (pre-breakout tension)
  if (n >= 25 && atrVal > 0) {
    const high20 = Math.max(...highs.slice(-20));
    const nearHigh20 = high20 > 0 && price >= high20 * 0.97;
    // True ranges for last 10 bars, compare first 5 vs last 5
    const trs = [];
    for (let i = n - 10; i < n; i++) {
      if (closes[i - 1] != null)
        trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    }
    const early5avg = trs.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const late5avg  = trs.slice(5).reduce((a, b) => a + b, 0) / 5;
    if (nearHigh20 && early5avg > 0 && late5avg < early5avg * 0.75) {
      patterns.push({ name: 'Coil at High', tag: 'coil_at_high', bullish: true,
        desc: 'ATR contracting near 20-day high — coiling before potential breakout' });
    }
  }

  return patterns;
}

// ── Conviction Score (multi-factor, 0–100) ───────────────────────────────────
// Replaces the simple composite (score/max×100) with a weighted blend of all available signals.
// Field name: `conviction_score` (distinct from `conviction` used in opportunity_signals).
export function computeConviction(result, marketRegime) {
  const { score, maxScore, whale_score, rs_score, obv_trend, bias, atr_pct_rank, patterns } = result;
  if (!bias || ['ERROR', 'NO_DATA', 'SKIP'].includes(bias)) return 0;

  const isBull = ['STRONG BUY', 'BUY', 'WATCH'].includes(bias);
  const isBear = ['STRONG SELL', 'SELL', 'AVOID'].includes(bias);
  if (!isBull && !isBear) return 0;

  // Technical: 40 pts max
  const tech = Math.round((score || 0) / (maxScore || 9) * 40);

  // Smart money (whale_score 0-10): 20 pts max
  const sm = Math.round((whale_score || 0) / 10 * 20);

  // RS leadership: 20 pts max (normalized: ±5% = full range)
  let rs = 0;
  if (rs_score != null) {
    const raw = isBull ? rs_score : -rs_score;
    rs = Math.round(Math.min(20, Math.max(0, (raw + 5) / 10 * 20)));
  }

  // OBV confirmation: 10 pts if direction matches signal
  const obvOk = (isBull && obv_trend === 'rising') || (isBear && obv_trend === 'falling');
  const obv = obvOk ? 10 : 0;

  // Regime alignment: 10 pts if aligned, 5 if neutral, 0 if against
  const regime = marketRegime || 'neutral';
  const regPts = (isBull && regime === 'bull') || (isBear && regime === 'bear') ? 10
               : regime === 'neutral' ? 5 : 0;

  // Pattern bonus: +3 per directional pattern matching signal, capped at +10
  const dirPatterns = (patterns || []).filter(p => p.bullish === isBull);
  const patternBonus = Math.min(10, dirPatterns.length * 3);

  // ATR coiling bonus: +5 if volatility is compressed
  const coilBonus = (atr_pct_rank != null && atr_pct_rank <= 25) ? 5 : 0;

  return Math.min(100, tech + sm + rs + obv + regPts + patternBonus + coilBonus);
}

// ── Exported run function (for dashboard server) ─────────────────────────────
export { TASI_STOCKS, emaArray, rsi as calcRsi, macdHist, volumeCheck, scoreBias, atrCalc, rsiSeries, findSRLevels, detectDivergence, computeSeasonality };
// calcVolatilityCompression and calcRsiBuildup are exported via `export function` above

export async function runScreener({ onProgress, symbols, market, investMode, mode } = {}) {
  if (!mode) mode = investMode ? 'position' : 'swing';

  let stockList;
  if (symbols && symbols.length > 0) {
    stockList = symbols.map(item =>
      typeof item === 'object' && item.sym ? item
        : UNIVERSE_MAP.get(item) || { sym: item, name: item.split(':').pop() }
    );
  } else {
    stockList = market ? (getUniverseByMarket(market) || TASI_STOCKS) : TASI_STOCKS;
  }

  // ── Fetch index for Relative Strength + market regime (single call, before main loop) ────
  let indexChange20d = null;
  let indexChange63d = null; // actual 63-day RS — replaces the broken ×3 proxy
  let marketRegime = 'neutral'; // 'bull' | 'neutral' | 'bear'
  const idxYahoo = YAHOO_INDEX[market] || YAHOO_INDEX.tasi;
  try {
    const idxBars = await fetchYahooOHLCV(idxYahoo, '1d', 260);
    if (idxBars.length >= 21) {
      const iCloses = idxBars.map(b => b.close);
      const iLast   = iCloses[iCloses.length - 1];

      // 20-day RS (kept for short-term momentum display)
      const i20 = iCloses[iCloses.length - 21];
      if (i20 > 0) indexChange20d = (iLast - i20) / i20 * 100;

      // 63-day RS: actual 3-month index change (replaces broken ×3 proxy)
      if (iCloses.length >= 64) {
        const i63 = iCloses[iCloses.length - 64];
        if (i63 > 0) indexChange63d = (iLast - i63) / i63 * 100;
      }

      // Market regime: index above EMA 200 AND EMA 13 > EMA 34
      if (iCloses.length >= 200) {
        const iE200 = emaArray(iCloses, 200);
        const iE13  = emaArray(iCloses, 13);
        const iE34  = emaArray(iCloses, 34);
        const abv200  = iLast > iE200[iE200.length - 1];
        const emaUp   = iE13[iE13.length - 1] > iE34[iE34.length - 1];
        if (abv200 && emaUp)        marketRegime = 'bull';
        else if (!abv200 && !emaUp) marketRegime = 'bear';
        else                        marketRegime = 'neutral';
      }
    }
  } catch (_) {}

  // ── Process each stock (parallel, concurrency = 12) ─────────────────────────
  let completed = 0;

  const results = await withConcurrency(stockList, async ({ sym, name, ar }) => {
    const yahooSym = toYahooSym(sym);
    try {
      if (!yahooSym) throw new Error('No Yahoo symbol mapping');

      // Daily bars
      const bars = await fetchYahooOHLCV(yahooSym, '1d', 260);

      if (bars.length < 50) {
        const r = { sym, name, bias: 'NO_DATA', error: '< 50 bars', score: 0, maxScore: 8 };
        if (onProgress) onProgress(++completed, stockList.length, r);
        return r;
      }

      const closes  = bars.map(b => b.close);
      const highs   = bars.map(b => b.high);
      const lows    = bars.map(b => b.low);
      const volumes = bars.map(b => b.volume);
      const price   = closes[closes.length - 1];

      const e13  = emaArray(closes, 13);
      const e34  = emaArray(closes, 34);
      const e89  = emaArray(closes, 89);
      const e200 = emaArray(closes, 200);
      const emas = {
        ema13:  e13[e13.length - 1],
        ema34:  e34[e34.length - 1],
        ema89:  e89[e89.length - 1],
        ema200: e200[e200.length - 1],
      };

      const isTasi   = sym.startsWith('TADAWUL:');
      const rsiVal   = rsi(closes, 14);
      const rsiVals  = rsiSeries(closes, 14);
      const macdData = macdHist(closes);
      const volData  = volumeCheck(volumes, isTasi);
      const atrVal   = atrCalc(highs, lows, closes, 14);

      // 63-day RS (actual, replaces both the old 20-day and the broken 60-day×3 proxy)
      const rsScore = (indexChange63d !== null && closes.length >= 64)
        ? Math.round(((price - closes[closes.length - 64]) / closes[closes.length - 64] * 100 - indexChange63d) * 100) / 100
        : (indexChange20d !== null && closes.length >= 21)
          ? Math.round(((price - closes[closes.length - 21]) / closes[closes.length - 21] * 100 - indexChange20d) * 100) / 100
          : null;

      // 20-day RS kept for short-term momentum context (UI display only)
      const rsScore20d = (indexChange20d !== null && closes.length >= 21)
        ? Math.round(((price - closes[closes.length - 21]) / closes[closes.length - 21] * 100 - indexChange20d) * 100) / 100
        : null;

      // rsScore60d now identical to rsScore (accurate 63-day, not the broken proxy)
      const rsScore60d = rsScore;

      const divergence  = detectDivergence(closes, rsiVals, 30);
      const srLevels    = findSRLevels(highs, lows, closes, 5);
      const seasonality = bars.length >= 24 ? computeSeasonality(closes, bars.map(b => b.time)) : null;
      const returns_20d = closes.length >= 21
        ? closes.slice(-21).map((c, i, a) => i === 0 ? 0 : Math.round((c - a[i-1]) / a[i-1] * 10000) / 100).slice(1)
        : null;

      // Average daily volume (20-day) for liquidity normalization
      const avgVolume20d = volumes.slice(-20).reduce((a, b) => a + (b || 0), 0) / 20;

      // Extension: how far has price run from 20-day low? (entry risk)
      const low20d = closes.length >= 21 ? Math.min(...closes.slice(-21)) : price;
      const extension_pct = low20d > 0 ? +((price - low20d) / low20d * 100).toFixed(1) : 0;

      // Near resistance/support flags (for UI display)
      const near_resistance = srLevels?.resistance?.some(r => r > price && (r - price) / price < 0.03) ?? false;
      const near_support    = srLevels?.support?.some(s => s < price && (price - s) / price < 0.03) ?? false;

      const vwap20 = calcVWAP(highs, lows, closes, volumes, 20);

      // OBV and ATR rank computed before scoreBias so they can influence scoring
      const obv_trend_pre = calcOBVTrend(closes, volumes, 20);
      const atr_pct_rank  = calcATRPercentileRank(highs, lows, closes, 14, 252);

      const scored = scoreBias(emas, rsiVal, macdData, volData, price, mode, rsScore,
        { srLevels, avgVolume: avgVolume20d, rsScore60d, isExtended: extension_pct > 25, vwap20,
          obv_trend: obv_trend_pre, isTasi });

      // ATR rank post-processing: coiling = +1 bonus; overextended = -1 penalty
      if (atr_pct_rank != null && scored.bias !== 'ERROR' && scored.bias !== 'NO_DATA') {
        const isBull = ['STRONG BUY', 'BUY', 'WATCH'].includes(scored.bias);
        const isBear = ['STRONG SELL', 'SELL', 'AVOID'].includes(scored.bias);
        if ((isBull || isBear) && atr_pct_rank <= 25) {
          scored.score = Math.min(scored.maxScore, scored.score + 1);
          (scored.flags = scored.flags || []).push(`ATR coiling (rank ${atr_pct_rank}%) — compressed volatility ✓`);
          if (isBull) scored.bias = scored.score >= 7 ? 'STRONG BUY' : scored.score >= 5 ? 'BUY' : scored.score >= 3 ? 'WATCH' : 'SKIP';
          if (isBear) scored.bias = scored.score >= 7 ? 'STRONG SELL' : scored.score >= 5 ? 'SELL' : scored.score >= 3 ? 'AVOID' : 'SKIP';
        } else if ((isBull || isBear) && atr_pct_rank >= 80 && scored.score >= 4) {
          scored.score = Math.max(0, scored.score - 1);
          (scored.warnings = scored.warnings || []).push(`ATR overextended (rank ${atr_pct_rank}%) — late entry risk`);
          if (isBull) scored.bias = scored.score >= 7 ? 'STRONG BUY' : scored.score >= 5 ? 'BUY' : scored.score >= 3 ? 'WATCH' : 'SKIP';
          if (isBear) scored.bias = scored.score >= 7 ? 'STRONG SELL' : scored.score >= 5 ? 'SELL' : scored.score >= 3 ? 'AVOID' : 'SKIP';
        }
      }

      // Market regime penalty: if market is in a downtrend, discount BUY signals
      let regime_discount = 0;
      let regime_score    = scored.score;
      let regime_bias     = scored.bias;
      if (['STRONG BUY', 'BUY'].includes(scored.bias)) {
        if (marketRegime === 'bear')         regime_discount = 2;
        else if (marketRegime === 'neutral') regime_discount = 1;
      } else if (['STRONG SELL', 'SELL'].includes(scored.bias)) {
        if (marketRegime === 'bull')         regime_discount = 2;
        else if (marketRegime === 'neutral') regime_discount = 1;
      }
      if (regime_discount > 0) {
        regime_score = Math.max(0, scored.score - regime_discount);
        const isBull = ['STRONG BUY', 'BUY', 'WATCH'].includes(scored.bias);
        if (isBull) {
          regime_bias = regime_score >= 7 ? 'STRONG BUY' : regime_score >= 5 ? 'BUY' : regime_score >= 3 ? 'WATCH' : 'SKIP';
        } else if (['STRONG SELL', 'SELL', 'AVOID'].includes(scored.bias)) {
          regime_bias = regime_score >= 7 ? 'STRONG SELL' : regime_score >= 5 ? 'SELL' : regime_score >= 3 ? 'AVOID' : 'SKIP';
        }
      }

      // Weekly confirmation (position mode only)
      let weekly = null;
      if (mode === 'position') {
        try {
          const wBars = await fetchYahooOHLCV(yahooSym, '1wk', 260);
          if (wBars.length >= 40) {
            const wC   = wBars.map(b => b.close);
            const wP   = wC[wC.length - 1];
            const wE13 = emaArray(wC, 13), wE34 = emaArray(wC, 34), wE89 = emaArray(wC, 89);
            const wStack = wE13[wE13.length-1] > wE34[wE34.length-1] && wE34[wE34.length-1] > wE89[wE89.length-1];
            let wAbove200 = null;
            if (wC.length >= 200) {
              const wE200 = emaArray(wC, 200);
              wAbove200 = wP > wE200[wE200.length - 1];
            }
            weekly = { ema_stack: wStack, above200: wAbove200, score: (wStack?2:0) + (wAbove200===true?2:0) };
          }
        } catch (_) {}
      }

      const mfi            = calcMFI(highs, lows, closes, volumes, 14);
      const obv_trend      = obv_trend_pre; // already computed before scoreBias
      const vol_zscore     = calcVolumeZScore(volumes, 20);
      const whale_score    = calcWhaleScore(mfi, obv_trend, volData.ratio, vol_zscore, scored.bias);
      const vol_compression = calcVolatilityCompression(closes, highs, lows, volumes);
      const rsi_buildup    = calcRsiBuildup(closes, rsiVals);
      const hurst          = calcHurst(closes);

      const change_pct = closes.length >= 2
        ? +((closes[closes.length-1] - closes[closes.length-2]) / closes[closes.length-2] * 100).toFixed(2)
        : null;

      const result = { sym, name, ar: ar || null, price, change_pct, emas, rsi: rsiVal, macd_hist: macdData?.hist,
        vol_ratio: volData.ratio, atr: atrVal, rs_score: rsScore, rs_score_20d: rsScore20d, divergence, sr: srLevels,
        seasonality, returns_20d, weekly, mfi, obv_trend, vol_zscore, whale_score,
        vol_compression, rsi_buildup,
        hurst, atr_pct_rank,
        vwap20: vwap20 != null ? +vwap20.toFixed(4) : null,
        above_vwap: vwap20 != null ? price > vwap20 : null,
        // New risk fields
        market_regime: marketRegime,
        regime_discount, regime_score, regime_bias,
        extension_pct, near_resistance, near_support,
        avg_volume: Math.round(avgVolume20d),
        composite: Math.round((scored.score || 0) / (scored.maxScore || 9) * 100),
        ...scored };
      // Style tags computed after full result is assembled
      result.style_tags = computeStyleTags(result);
      // Pattern recognition and conviction score (both need full result + market regime in scope)
      result.patterns = detectPatterns(closes, highs, lows, volumes, atrVal, avgVolume20d);
      result.conviction_score = computeConviction(result, marketRegime);
      if (onProgress) onProgress(++completed, stockList.length, result);
      return result;

    } catch (err) {
      const r = { sym, name, bias: 'ERROR', error: err.message, score: 0, maxScore: 8 };
      if (onProgress) onProgress(++completed, stockList.length, r);
      return r;
    }
  });

  return results.filter(Boolean);
}

