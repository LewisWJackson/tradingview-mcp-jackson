#!/usr/bin/env node
// build_universe.js — Fetches and validates ~1,000 US equity tickers
// from S&P 500 + Nasdaq 100 + Russell mid-cap constituent lists via Yahoo Finance.
// Usage: node scripts/scanner/build_universe.js

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'universe.json');
const BATCH_SIZE = 50;
const DELAY_MS = 300; // polite pause between batches

// ═══════════════════════════════════════════════════════════════════════════════
// Yahoo Finance HTTP helpers (same crumb/cookie pattern as dashboard builder)
// ═══════════════════════════════════════════════════════════════════════════════

function yahooGet(url, cookies) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Cookie': cookies || '',
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function yahooGetCrumb() {
  const init = await yahooGet('https://fc.yahoo.com', '');
  const setCookie = init.headers['set-cookie'] || [];
  const cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
  const crumbRes = await yahooGet('https://query2.finance.yahoo.com/v1/test/getcrumb', cookies);
  if (crumbRes.status !== 200) throw new Error(`Crumb fetch failed: ${crumbRes.status}`);
  return { crumb: crumbRes.body, cookies };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Batch quote validation
// ═══════════════════════════════════════════════════════════════════════════════

async function validateBatch(symbols, crumb, cookies) {
  const syms = symbols.join(',');
  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}&crumb=${encodeURIComponent(crumb)}`;
  const res = await yahooGet(url, cookies);
  if (res.status !== 200) {
    console.warn(`  [warn] batch returned status ${res.status}, skipping ${symbols.length} symbols`);
    return [];
  }
  try {
    const data = JSON.parse(res.body);
    const results = data.quoteResponse?.result || [];
    return results
      .filter((q) => q.regularMarketPrice != null && q.regularMarketPrice > 0)
      .map((q) => q.symbol);
  } catch (e) {
    console.warn(`  [warn] JSON parse error for batch, skipping`);
    return [];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Hardcoded seed list: S&P 500 + Nasdaq 100 + Russell mid-cap (~1,050 unique)
// ═══════════════════════════════════════════════════════════════════════════════

const SEED_SYMBOLS = [
  // ── S&P 500 (503 tickers) ─────────────────────────────────────────────────
  'AAPL','ABBV','ABT','ACN','ADBE','ADI','ADM','ADP','ADSK','AEE',
  'AEP','AES','AFL','AIG','AIZ','AJG','AKAM','ALB','ALGN','ALK',
  'ALL','ALLE','AMAT','AMCR','AMD','AME','AMGN','AMP','AMT','AMZN',
  'ANET','ANSS','AON','AOS','APA','APD','APH','APTV','ARE','ATO',
  'ATVI','AVGO','AVY','AWK','AXP','AZO','BA','BAC','BAX','BBWI',
  'BBY','BDX','BEN','BF.B','BG','BIIB','BIO','BK','BKNG','BKR',
  'BLK','BMY','BR','BRK.B','BRO','BSX','BWA','BXP','C','CAG',
  'CAH','CARR','CAT','CB','CBOE','CBRE','CCI','CCL','CDAY','CDNS',
  'CDW','CE','CEG','CF','CFG','CHD','CHRW','CHTR','CI','CINF',
  'CL','CLX','CMA','CMCSA','CME','CMG','CMI','CMS','CNC','CNP',
  'COF','COO','COP','COST','CPB','CPRT','CPT','CRL','CRM','CSCO',
  'CSGP','CSX','CTAS','CTLT','CTRA','CTSH','CTVA','CVS','CVX','CZR',
  'D','DAL','DD','DE','DFS','DG','DGX','DHI','DHR','DIS',
  'DISH','DLTR','DOV','DOW','DPZ','DRI','DTE','DUK','DVA','DVN',
  'DXC','DXCM','EA','EBAY','ECL','ED','EFX','EIX','EL','EMN',
  'EMR','ENPH','EOG','EPAM','EQIX','EQR','EQT','ES','ESS','ETN',
  'ETR','ETSY','EVRG','EW','EXC','EXPD','EXPE','EXR','F','FANG',
  'FAST','FBHS','FCX','FDS','FDX','FE','FFIV','FIS','FISV','FITB',
  'FLT','FMC','FOX','FOXA','FRC','FRT','FTNT','FTV','GD','GE',
  'GEHC','GEN','GILD','GIS','GL','GLW','GM','GNRC','GOOG','GOOGL',
  'GPC','GPN','GRMN','GS','GWW','HAL','HAS','HBAN','HCA','HOLX',
  'HON','HPE','HPQ','HRL','HSIC','HST','HSY','HUM','HWM','IBM',
  'ICE','IDXX','IEX','IFF','ILMN','INCY','INTC','INTU','INVH','IP',
  'IPG','IQV','IR','IRM','ISRG','IT','ITW','IVZ','J','JBHT',
  'JCI','JKHY','JNJ','JNPR','JPM','K','KDP','KEY','KEYS','KHC',
  'KIM','KLAC','KMB','KMI','KMX','KO','KR','L','LDOS','LEN',
  'LH','LHX','LIN','LKQ','LLY','LMT','LNC','LNT','LOW','LRCX',
  'LUMN','LUV','LVS','LW','LYB','LYV','MA','MAA','MAR','MAS',
  'MCD','MCHP','MCK','MCO','MDLZ','MDT','MET','META','MGM','MHK',
  'MKC','MKTX','MLM','MMC','MMM','MNST','MO','MOH','MOS','MPC',
  'MPWR','MRK','MRNA','MRO','MS','MSCI','MSFT','MSI','MTB','MTCH',
  'MTD','MU','NCLH','NDAQ','NDSN','NEE','NEM','NFLX','NI','NKE',
  'NOC','NOW','NRG','NSC','NTAP','NTRS','NUE','NVDA','NVR','NWL',
  'NWS','NWSA','NXPI','O','ODFL','OGN','OKE','OMC','ON','ORCL',
  'ORLY','OTIS','OXY','PARA','PAYC','PAYX','PCAR','PCG','PEAK','PEG',
  'PEP','PFE','PFG','PG','PGR','PH','PHM','PKG','PKI','PLD',
  'PM','PNC','PNR','PNW','POOL','PPG','PPL','PRU','PSA','PSX',
  'PTC','PVH','PWR','PXD','PYPL','QCOM','QRVO','RCL','RE','REG',
  'REGN','RF','RHI','RJF','RL','RMD','ROK','ROL','ROP','ROST',
  'RSG','RTX','RVTY','SBAC','SBNY','SBUX','SCHW','SEE','SHW','SIVB',
  'SJM','SLB','SNA','SNPS','SO','SPG','SPGI','SRE','STE','STT',
  'STX','STZ','SWK','SWKS','SYF','SYK','SYY','T','TAP','TDG',
  'TDY','TECH','TEL','TER','TFC','TFX','TGT','TMO','TMUS','TPR',
  'TRGP','TRMB','TROW','TRV','TSCO','TSLA','TSN','TT','TTWO','TXN',
  'TXT','TYL','UAL','UDR','UHS','ULTA','UNH','UNP','UPS','URI',
  'USB','V','VFC','VICI','VLO','VMC','VRSK','VRSN','VRTX','VTR',
  'VTRS','VZ','WAB','WAT','WBA','WBD','WDC','WEC','WELL','WFC',
  'WHR','WM','WMB','WMT','WRB','WRK','WST','WTW','WY','WYNN',
  'XEL','XOM','XRAY','XYL','YUM','ZBH','ZBRA','ZION','ZTS',

  // ── Nasdaq 100 additions (those not already in S&P 500) ───────────────────
  'AZN','BIDU','CRWD','CPNG','CSGP','DDOG','DLTR','DOCU','DXCM',
  'FAST','FTNT','GFS','GRAB','HON','IDXX','ILMN','INTC','ISRG',
  'JD','KDP','KHC','KLAC','LCID','LULU','MELI','MNST','MRVL',
  'NTES','NXPI','ODFL','PANW','PAYX','PCAR','PDD','PYPL','REGN',
  'RIVN','ROST','SGEN','SIRI','SNPS','SPLK','TEAM','TMUS','TTWO',
  'VRSK','VRTX','WBD','WDAY','XEL','ZM','ZS',

  // ── Russell mid-cap additions (~400 unique, not in S&P 500/Nasdaq 100) ────
  'AA','ACIW','ACM','ACGL','ADNT','AGCO','AGO','AGR','AIT','ALNY',
  'ALLY','AMED','AMG','AMKR','AMN','APA','APPF','APPS','AR','ARMK',
  'ARWR','ASH','ATI','ATKR','AVTR','AX','AXON','AZEK','BALL','BALY',
  'BC','BCPC','BERY','BHC','BJ','BKNG','BLD','BLDR','BNL','BOH',
  'BOOT','BR','BRBR','BRZE','BWXT','BXP','CACI','CALM','CARG','CBSH',
  'CCCS','CCS','CDE','CEIX','CELH','CENTA','CHE','CHDN','CHH','CHPT',
  'CHRD','CIB','CIEN','CIVI','CLVT','CMC','COKE','COHR','COLD',
  'COOP','CORT','CPNG','CROX','CRUS','CRS','CRVL','CSGS','CUBE',
  'CVLT','CW','CYTK','DAR','DCI','DDS','DECK','DEN','DINO','DIOD',
  'DKS','DLTR','DOCS','DT','DUOL','DV','DXPE','EAT','EBC','EEFT',
  'ELFV','ELF','EME','ENSG','EPRT','ESGR','ESNT','ESTC','ETSY',
  'EVR','EWBC','EXAS','EXEL','EXLS','EXPO','FATE','FIVE','FIX','FIZZ',
  'FLO','FBIN','FND','FOXF','FRPT','FSS','FSLR','FTAI','FUN','GATX',
  'GBCI','GEO','GKOS','GLOB','GMS','GNTX','GOLF','GPK','GTES','GXO',
  'HAE','HBI','HEI','HELE','HGV','HLI','HLNE','HLT','HQY','HTLF',
  'HUBG','HUN','HXL','IART','IBKR','IBP','ICL','IDA','IIVI','IIPR',
  'INGR','INSM','INST','INTA','IOSP','IPGP','IPAR','ITT','JBGS',
  'JBL','JBSS','JEF','JHG','JJSF','JLL','JNPR','JOBY','KALU','KAR',
  'KB','KBH','KBR','KD','KFRC','KMPR','KNF','KNX','KNTK','KVUE',
  'LANC','LBRT','LCII','LFUS','LHCG','LITE','LIVN','LKFN','LNTH',
  'LPLA','LSI','LSTR','LSXMA','LSXMK','MASI','MANH','MATX','MBIN',
  'MC','MCRI','MDGL','MEDP','MESA','MGPI','MIDD','MKSI','MNKD',
  'MODV','MOG.A','MQ','MRCY','MRVI','MSGS','MSM','MTG','MTSI',
  'MUR','MUSA','NAVI','NBHC','NBIX','NCNO','NEA','NEIA','NEP',
  'NEOG','NFG','NJR','NLY','NMIH','NOG','NOVT','NR','NSA','NSIT',
  'NVT','NXST','OLED','OLLI','OLN','OMF','ONB','ORI','OSK','OTTR',
  'OVV','PACI','PATK','PAYO','PCOR','PCVX','PDC','PEGA','PGNY','PII',
  'PINC','PLNT','PLXS','PNM','PNFP','POR','POST','POWL','PRGO',
  'PRGS','PRI','PRLB','PRFT','PSTG','PTCT','PTGX','PVH','QLYS',
  'QTWO','R','RAMP','RBLX','RBC','RCM','RDNT','REZI','RGLD','RH',
  'RHP','RIG','RLI','RMBS','RNR','RNST','ROG','RPM','RRR','RRX',
  'RUSHA','RUSHB','RXRX','SAIA','SAM','SBRA','SCI','SCPL','SD','SDHC',
  'SF','SFBS','SFM','SHAK','SITE','SLAB','SLM','SMCI','SMED','SMPX',
  'SN','SNV','SOLV','SON','SPB','SPNT','SPSC','SPXC','SSD','SSNC',
  'STEP','STLD','STR','STRA','STRL','SWN','SWX','SXT','TALO','TBBK',
  'TDC','TDOC','TENB','TFSL','THC','THO','THS','TKC','TKR','TMHC',
  'TNET','TOST','TPG','TPX','TREX','TTC','TWST','TXG','TXRH','UFPI',
  'UMBF','UNFI','UPST','URBN','USLM','VCEL','VCTR','VEEV','VET',
  'VIR','VIRT','VIAV','VNOM','VNO','VNT','VOYA','VRNS','VSCO','VSTO',
  'WAL','WDFC','WEBR','WEN','WFRD','WGO','WH','WK','WLK','WMS',
  'WNS','WOLF','WRBY','WTS','WTTR','X','XNCR','XPO','XPOF','YEXT',
  'YOU','YELP','ZI','ZNGA','ZWS',

  // ── Additional Russell mid-cap / liquid mid-cap names ─────────────────────
  'AAON','ABUS','ACHC','ACLS','ACVA','ADMA','AEIS','AGEN','AGL','AGYS',
  'AHCO','AIN','AIRS','AKR','ALIT','ALSN','ALTG','ALTO','AMBA','AMLX',
  'AMNB','AMS','ANDE','ANGO','ANN','AORT','APAM','APGE','APLS','APPN',
  'ARAY','ARCB','ARES','ARIS','ARKO','ARLO','AROC','ASGN','ASIX','ASTE',
  'ATEN','ATGE','ATRC','ATSG','AVAV','AVNT','AVPT','AXNX','AXSM','AYI',
  'AZTA','BANC','BANF','BANR','BASE','BBIO','BBSI','BCOV','BECN','BGS',
  'BHVN','BILL','BJRI','BLKB','BLX','BMA','BMBL','BMRN','BNRE','BPMC',
  'BRP','BSIG','BTU','BWE','BXMT','BYD','CALX','CAMT','CASH','CASS',
  'CATY','CBAN','CBRL','CCB','CCOI','CDK','CDMO','CDRE','CENT','CERS',
  'CHCO','CHEF','CIT','CIVB','CKH','CLDX','CLNE','CLSK','CMBM','CMCO',
  'CMD','CNMD','CNNE','CNO','CNXC','COHU','COLB','COMM','COMP','CORT',
  'COTY','COWN','CPRI','CPRX','CRAI','CRGY','CRI','CRNX','CRVS','CSWI',
  'CTS','CVBF','CVCO','CVGW','CWST','CXM','CYTK','CZR','DAC','DAVA',
  'DCGO','DFIN','DH','DHC','DIOD','DNLI','DORM','DRH','DRIV','DRVN',
  'DSCP','DTM','DVAX','DXC','DXPE','EAT','EBTC','ECPG','EFSC','EGP',
  'EHC','ELAN','ELLI','ENTA','ENV','ENVA','EPAC','ERII','ESAB','ESE',
  'EVBG','EVC','EVER','EVTC','EXP','EXPI','EZPW','FAF','FARO','FCEL',
  'FCFS','FCN','FCPT','FDMT','FELE','FG','FGEN','FHB','FHI','FHN',
  'FIBK','FIGS','FINV','FL','FLGT','FLNC','FLWS','FOLD','FORM','FORR',
  'FOUR','FREY','FRME','FRSH','FSLY','FSR','FSTR','FULT','FWRD','GATO',
  'GDDY','GDOT','GDRX','GERN','GFF','GH','GIII','GLBE','GLNG','GLPI',
  'GLPG','GNTY','GOGO','GP','GPOR','GRND','GSHD','GTLS','GTN','GTX',
  'GVA','GWRE','HAFC','HAIN','HALO','HASI','HAYW','HCAT','HCKT','HEAR',
  'HI','HIMS','HLMN','HMN','HOMB','HOPE','HRMY','HRN','HTLD',
  'HUBG','HUBB','HUBS','HWC','HZNP','IAC','IBOC','ICAD','ICFI','ICHR',
  'IDCC','IESC','IGT','IMVT','INDB','INFN','INMD','INN','INOD','INSP',
  'INST','INTA','IOSP','IOVA','IRBT','IRDM','ITCI','ITGR','JACK','JAMF',
  'JAZZ','JBLU','JBT','JELD','JOE','KBAL','KLIC','KN','KNSA','KOS',
  'KREF','KRG','KROS','KSS','KTB','KTOS','KVYO','LADR','LAMR','LAUR',
  'LAZ','LBAI','LBRDK','LFST','LGIH','LGND','LION','LIVN','LMAT','LMND',
  'LNTH','LOPE','LPRO','LPX','LQDA','LRN','LSCC','LUNA','LVWR','LWLG',
  'LXP','MANT','MATV','MAXR','MBUU','MCBS','MCW','MDXH','MDRX',
  'MEDP','MEG','MEOH','MGEE','MGY','MKTW','MMSI','MNRO','MOD',
  'MODG','MRTN','MRUS','MSGE','MTDR','MTRN','MTTR','MTX','MVST',
  'NABL','NATL','NATI','NBHC','NBR','NCBS','NEOG','NEPH','NGVT',
  'NHC','NHI','NMRK','NNBR','NOG','NOVA','NOVT','NR','NRIX','NSIT',
  'NTLA','NV','NVAX','NVG','NVRO','NVST','NWE','NWPX','OC','OESX',
  'OFG','OGE','OGS','OHI','OI','OLED','OLLI','OLN','OMF','ONTO',
  'OPEN','OPCH','ORA','OSIS','OSPN','OTEX','OTTR','OUT','OVV','PACS',
  'PATH','PAYC','PAYS','PBF','PCTY','PDCO','PDFS','PEB','PECO',
  'PENN','PGRE','PHR','PIPR','PKE','PLAY','PLMR','PLSE','PLYM',
  'PNFP','POLY','POWI','PRAH','PRCT','PRDO','PRFT','PROG','PRPL',
  'PRVA','PSN','PSTL','PTVE','PUMP','PWSC','PZZA','QDEL','QGEN',
  'QLYS','QNST','QTWO','QUIK','RAMP','RARE','RBBN','RCII','RCKT',
  'RCUS','REAL','REGI','RELY','REPAY','REVG','REXR','RGCO','RIDE',
  'RLJ','RMBS','RNG','RNST','ROCK','ROG','RPD','RPAY','RPM','RRBI',
  'RSVR','RVLV','RXO','RYAM','SABR','SAFE','SAGE','SAND','SANM','SBCF',
  'SBGI','SBSI','SCCO','SCHL','SCSC','SDGR','SEAS','SEDG','SHOO',
  'SIGI','SKT','SKYY','SLG','SMAR','SMBC','SMPL','SMTC','SNDR',
  'SNEX','SOI','SONO','SPR','SPWR','SQSP','SRC','SRCE','SRRK','SSB',
  'SSRM','STAA','STAG','STAR','STER','STNE','STOR','STWD','STVN',
  'SWIM','SWAV','SWI','TASK','TCBI','TCBX','TCN','TDUP','TDS',
  'TECH','TENB','TER','TFSL','TGH','TGTX','THRM','TILE','TIXT',
  'TMCI','TMDX','TNL','TOST','TOWN','TRNO','TRMK','TRUE','TRUP',
  'TTMI','TVTX','TWKS','TWLO','TWOU','UCBI','UDMY','UFPT','UMBF',
  'UMH','UNVR','UPWK','URBN','USPH','VCNX','VCYT','VECO','VEL',
  'VERX','VERU','VG','VIAV','VINE','VKTX','VLTO','VNDA','VRE',
  'VRNT','VSH','VTOL','VVV','WABC','WAL','WDFC','WEN','WERN','WFRD',
  'WING','WK','WLK','WLKP','WMS','WOOF','WOR','WPC','WRAP','WSC',
  'WSBC','WSBF','WSFS','WSM','WTFC','WTS','WWD','WWE','XPER','XPOF',
  'YETI','YNDX','YEXT','ZBRA','ZETA','ZNTL','ZS','ZUO','ZWS',
];

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  // Deduplicate seed list
  const unique = [...new Set(SEED_SYMBOLS.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  console.log(`[universe] ${unique.length} unique seed symbols after dedup`);

  // Get Yahoo auth
  console.log('[universe] acquiring Yahoo Finance crumb...');
  const { crumb, cookies } = await yahooGetCrumb();
  console.log('[universe] crumb acquired');

  // Validate in batches
  const validated = [];
  const batches = [];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    batches.push(unique.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const valid = await validateBatch(batch, crumb, cookies);
    validated.push(...valid);
    process.stdout.write(`  [batch ${i + 1}/${batches.length}] ${valid.length}/${batch.length} valid (total: ${validated.length})\r\n`);
    if (i < batches.length - 1) await sleep(DELAY_MS);
  }

  // Sort and write
  validated.sort((a, b) => a.localeCompare(b));

  const output = {
    description: 'S&P 500 + Nasdaq 100 + Russell mid-cap (deduplicated)',
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'Public index constituent lists, validated via Yahoo Finance',
    symbols: validated,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`\n[universe] wrote ${validated.length} symbols to ${OUT_PATH}`);

  if (validated.length < 800) {
    console.warn(`[warn] only ${validated.length} symbols validated — expected 800+`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[universe] fatal:', err.message);
  process.exit(1);
});
