// ────────────────────────────────────────────────────────────────────────────
// Translations
// ────────────────────────────────────────────────────────────────────────────
const TR = {
  en: {
    title:'Mawjah', scanAll:'⟳ Scan All',
    strongBuy:'Strong Uptrend', buy:'Uptrend', watch:'Building', scanned:'Scanned', strongSell:'Strong Downtrend',
    all8:'7–8 pts', crit56:'5–6 pts', crit34:'3–4 pts', noScan:'No scan yet', allBear8:'7–8 pts bearish',
    selected:'Selected:', stocks:'stocks', scanSelected:'Scan Selected', clearSel:'Clear',
    tabScreener:'Screener', tabCriteria:'🔔 Alerts', tabUniverse:'⚙ Settings', tabPositions:'💼 Portfolio',
    all:'All', fBanks:'Banks', fEnergy:'Energy', fPetro:'Petrochem', fTelecom:'Telecom',
    fHealth:'Health', fFood:'Food', fOther:'Other', fBuys:'Buys', fWatch:'Watch', fSells:'Sells', fHalal:'Halal',
    mAll:'All Markets', mTasi:'TASI', mUs:'US Equity', mEtf:'ETF', mCrypto:'Crypto', mCommodity:'Commodities',
    fTech:'Tech', fFinancials:'Financials', fConsumer:'Consumer', fMetal:'Metals', fCrude:'Energy', fEtfEquity:'Equity ETF', fEtfMetal:'Metal ETF', fEtfCrude:'Oil ETF', fEtfBond:'Bond ETF',
    selectAllVis:'Select all visible',
    colTicker:'Ticker', colName:'Name', colSector:'Sector', colPrice:'Price',
    colScore:'Score ↓', colRsi:'RSI', colMacd:'MACD', colVol:'Vol×', colEma:'EMA', colSignal:'Trend State', colSharia:'Halal', colRs:'RS', colWeekly:'W',
    emptyScreener:'No scan data yet.<br>Click <strong>Scan All</strong> to start.',
    scoringTitle:'How stocks are scored (out of 8)',
    scoringSubtitle:'Applied automatically during every scan',
    scanning:'Scanning…',
    lastScan:'Last scan:',
    // Sectors
    sBanking:'Banking', sEnergy:'Energy', sPetrochem:'Petrochem', sTelecom:'Telecom',
    sUtility:'Utility', sFood:'Food', sRetail:'Retail', sHealth:'Healthcare',
    sRealestate:'Real Estate', sCement:'Cement', sIndustrial:'Industrial',
    sInsurance:'Insurance', sOther:'Other',
    sTech:'Technology', sFinancials:'Financials', sConsumer:'Consumer', sRetailUs:'Retail', sHealthUs:'Healthcare',
    sEnergyUs:'Energy', sEtfEquity:'Equity ETF', sEtfMetal:'Metal ETF', sEtfCrude:'Oil ETF', sEtfBond:'Bond ETF',
    sCrypto:'Crypto', sMetal:'Metals', sCrude:'Oil & Gas',
    // Bias
    bStrongBuy:'Strong Uptrend', bBuy:'Uptrend', bWatch:'Building', bSkip:'Flat', bError:'ERROR', bNoData:'NO DATA',
    bStrongSell:'Strong Downtrend', bSell:'Downtrend', bAvoid:'Weak',
    // Drawer
    critBreakdown:'Criteria breakdown',
    pass:'PASS', fail:'FAIL',
    entryGuidanceTitle:'📍 Entry Guidance',
    watchTitle:'👁 What to Watch For',
    // Criterion labels (2 pts etc appended separately)
    lEmaStack:'EMA Trend Stack', lEmaStackBear:'EMA Bearish Stack',
    lEma200:'Long-Term Regime',  lEma200Bear:'Below Long-Term Regime',
    lRsi:'RSI Momentum Zone',    lRsiBear:'RSI Weak Zone',
    lMacd:'MACD Momentum',
    lVol:'Volume Confirmation',
    sellGuidanceTitle:'▼ Bearish Setup — Avoid / Exit',
    avoidTitle:'◆ Early Bearish — Monitor',
    pts:' pts',
    // Scoring rule descriptions
    srEmaStack:'13-day above 34-day above 89-day — all timeframes trending up',
    srEma200:'Price above 200-day EMA — long-term bull regime confirmed',
    srRsi:'RSI in momentum zone — not weak, not overbought',
    srMacd:'MACD histogram positive — short-term momentum accelerating',
    srVol:'Volume above 1.2× 20-day average — institutional participation',
    // Criteria editor
    crBullish:'🟢 Bullish Criteria', crBearish:'🔴 Bearish Criteria',
    crNeutral:'⚪ Neutral / No-Trade', crRisk:'⚠ Risk Rules',
    addPlaceholder:'Add new item…', addBtn:'+ Add',
    editHint:'Edit items inline, then save.', saveBtn:'💾 Save',
    unsaved:'Unsaved changes', saved:'Saved ✓',
    loading:'Loading…',
    // Fundamentals
    fundTitle:'Fundamental Analysis', fundLoading:'Fetching fundamentals…', fundError:'Could not load fundamentals',
    fundScore:'Fund. Score', sValuation:'Valuation', sDividends:'Dividends',
    sProfitability:'Profitability', sHealth:'Financial Health', s52w:'52-Week Range',
    lPE:'P/E (Trailing)', lFPE:'P/E (Forward)', lPB:'P/B Ratio', lEVEbitda:'EV/EBITDA',
    lDivYield:'Dividend Yield', lDivRate:'Annual Dividend', lPayoutRatio:'Payout Ratio', lExDiv:'Ex-Div Date',
    lROE:'ROE', lNetMargin:'Net Margin', lOpMargin:'Op. Margin', lEbitdaMargin:'EBITDA Margin',
    lDE:'Debt/Equity', lCurrentRatio:'Current Ratio', lFreeCF:'Free Cash Flow', lMarketCap:'Market Cap',
    lBeta:'Beta', lInsider:'Insider %', lInstitution:'Institution %',
    sigUndervalued:'UNDERVALUED', sigFair:'FAIR VALUE', sigOvervalued:'OVERVALUED',
    fundNone:'—', na:'N/A',
    // Sharia
    sHalal:'Halal', sNonHalal:'Non-Halal', sReview:'Review', sUnknown:'?',
    shariaTitle:'Sharia Compliance', shariaDisc:'Based on AAOIFI sector screens. Verify with a qualified Islamic finance scholar.',
    // Live mode
    liveOff:'Live', liveOn:'Live On', liveStopped:'Live Off',
    liveInterval:'Interval', liveMin:'min',
    // Backtest
    btRun:'Run Backtest (2yr)', btRunning:'Running…', btTitle:'Backtest Results',
    btTrades:'Trades', btWinRate:'Win Rate', btAvgReturn:'Avg Return', btPF:'Profit Factor',
    btRecent:'Recent trades', btStop:'stop', btT1:'target1', btT2:'target2', btTimeout:'timeout',
    // Calendar
    calEarnings:'Earnings', calDays:'days',
    finnhubToken:'Finnhub Token',
    // Analytics
    analyticsTitle:'Trade Analytics',
    anWinRate:'Win Rate', anAvgWin:'Avg Win', anAvgLoss:'Avg Loss', anPF:'Profit Factor',
    // Close trade
    closeTrade:'Close', closePrice:'Exit price', closeDate:'Exit date', closeReason:'Reason',
    closeReasonT1:'Target 1', closeReasonT2:'Target 2', closeReasonStop:'Stop Loss', closeReasonManual:'Manual',
    closeConfirm:'Confirm Close',
    // Mode toggle
    modeSwing:'📈 Swing', modePosition:'📊 Position', modeBreakout:'⚡ Breakout',
    exportCsv:'⬇ Export CSV',
    // Weekly
    colWeekly:'W', wFull:'W ✓✓', wPartial:'W ✓', wNone:'W ✗', wNa:'—',
    weeklyTitle:'Weekly Alignment', wEmaStack:'EMA stack (W)', wAbove200:'Above EMA 200 (W)',
    // Positions
    posTitle:'My Positions', posSubtitle:'Track your entries and P&L against last scan price',
    posEntry:'Entry', posScanPrice:'Scan Price', posPnl:'P&L', posShares:'Shares', posDate:'Date',
    posEmpty:'No positions yet. Add one below.',
    posLivePrice:'Refresh Live Price', posLivePriceLoading:'Loading…',
    // Notifications
    notifTitle:'Telegram Notifications', notifTest:'Test', notifEnabled:'Enabled',
    notifToken:'Bot Token', notifChatId:'Chat ID',
    notifHint:'Get your Chat ID: message @userinfobot on Telegram.',
    notifSaved:'Settings saved ✓', notifTestOk:'Test message sent ✓', notifTestFail:'Failed — check token/chat ID',
    // Screenshot
    viewChart:'View Chart', chartLoading:'Loading chart…',
    // Breadth + heatmap
    breadthTitle:'Market Breadth',
    // Movers
    moversTitle:'What Changed Since Last Scan', moversImp:'improved', moversDeg:'degraded', moversEmpty:'No changes since last scan',
    // ATR
    atrTitle:'ATR Trade Levels', atrStop:'Stop Loss', atrT1:'Target 1', atrT2:'Target 2',
    // RS
    rsTitle:'Relative Strength', rsLeader:'Leader', rsLaggard:'Lagging',
    // Alert
    setAlert:'Set Alert', alertSet:'Alert Set ✓', alertFail:'Failed',
    // Universe
    univTitle:'Symbol Universe', univSubtitle:'Manage which symbols are scanned per market',
    univSymPlaceholder:'Symbol (e.g. AAPL or TADAWUL:1120)', univNamePlaceholder:'Name (optional)',
    univAdd:'+ Add', univReset:'Reset', univSave:'Save', univSaved:'Saved ✓',
    univEmpty:'No symbols. Add one below.', univCount:'symbols',
    colDiv:'Div', dtabSignal:'Overview', dtabTrade:'Execute', dtabAnalysis:'Setup', dtabFund:'Research',
    rgDailyVol:'Daily Vol', rg20d:'20d Perf', rg52w:'52w Pos', rg52wRange:'52-Week Range',
    divBullish:'Bullish Div', divBearish:'Bearish Div', srLevelsTitle:'Support & Resistance', sizerTitle:'Position Sizer',
    legendBtn:'ℹ Signal Guide', legendClose:'Close Guide',
    colDelta:'Δ', archiveBtn:'📦 History', archiveLive:'🔴 Live (current)',
    freshLive:'Live', freshOld:'Stale data',
    tabWatchlist:'☆ Watchlist', wlSubtitle:'Click ☆ in the screener to add stocks',
    wlEmpty:'No stocks in your watchlist yet.\nClick ☆ next to any row in the screener to add.',
    wlAddedToast:'Added to watchlist', wlRemovedToast:'Removed from watchlist',
    retryBtn:'↻ Retry', priceAlertSet:'Alert set ✓',
    tvEmbedBtn:'Load Chart (TradingView)',
    ruleTitle:'Smart Alert Rules', ruleSub:'Trigger when conditions are met after each scan',
    ruleEmpty:'No rules yet. Add one below.', ruleDeleted:'Rule deleted.',
    tvOpenChart:'📈 View Chart', tvSetAlert:'🔔 Alert', tvWatchlist:'⭐ Watchlist', tvCopySymbol:'⧉ Copy',
    tfTitle:'Timeframe Alignment', tfLoading:'Fetching 4H + D + W alignment…',
    newsTitle:'Recent News', newsNoToken:'Add Finnhub token in Settings for news.', newsNone:'No recent news found.',
    divTitle:'Dividend Info', divYield:'Yield', divNext:'Next Pay', divAmount:'Amount',
    hmapTitle:'Portfolio Map', hmapSub:'Size = position value · Color = P&L',
    sparkUp:'Score trending up', sparkDown:'Score trending down',
    tabMarkets:'🌍 Markets',
    mktOverviewTitle:'Global Market Overview', mktRefresh:'⟳ Refresh', mktLoading:'Loading market data (requires TradingView)…',
    mktOpportTitle:'Strongest Trends', mktOpportSub:'Highest trend-alignment scores from last scan (descriptive, not a buy list)', mktOpportEmpty:'Run a scan first to see trend scores.',
    mktBull:'▲ Bull', mktBear:'▼ Bear', mktRange:'◆ Range',
    mktRsi:'RSI', mktVol:'ATR%', mkt20d:'20d', mkt52w:'52w',
    execTitle:'Executive Summary', execEntry:'Entry Zone', execStop:'Stop', execT1:'Target 1', execT2:'Target 2',
    execRes:'Resistance', execSup:'Support', execFair:'Fair Value', execRR:'R:R',
    vhTitle:'Value vs Peers', vhPe:'P/E', vhPb:'P/B', vhDe:'D/E', vhFair:'Est. Fair Value',
    vhCheap:'CHEAP', vhFair2:'FAIR', vhPricey:'PRICEY', vhNa:'N/A',
    tabVirtual:'🎮 Virtual', vpCash:'Cash', vpValue:'Portfolio Value', vpPnl:'Total P&L', vpReturn:'Return',
    vpHoldings:'Holdings', vpReset:'↺ Reset', vpAvgCost:'Avg Cost', vpValue2:'Value', vpReturnCol:'Return',
    vpEmpty:'No virtual positions yet. Use Virtual Buy in the Trade tab.',
    vpHistory:'Trade History', vpAction:'Action', vpTotal:'Total', vpCashAfter:'Cash After', vpNoTrades:'No trades yet.',
    vpBuy:'Virtual Buy', vpSell:'Virtual Sell', vpShares:'Shares',
    vpBuyOk:'Bought', vpSellOk:'Sold', vpErrFunds:'Insufficient cash', vpErrShares:'Not enough shares',
    sarToggle:'SAR', usdToggle:'$ USD',
  },
  ar: {
    title:'موجة', scanAll:'⟳ مسح الكل',
    strongBuy:'اتجاه صاعد قوي', buy:'اتجاه صاعد', watch:'يتشكل', scanned:'إجمالي المسح', strongSell:'اتجاه هابط قوي',
    all8:'7–8 نقطة', crit56:'5–6 نقاط', crit34:'3–4 نقاط', noScan:'لا يوجد مسح بعد', allBear8:'7–8 نقطة هبوطية',
    selected:'محدد:', stocks:'أسهم', scanSelected:'مسح المحدد', clearSel:'مسح التحديد',
    tabScreener:'الفرز', tabCriteria:'🔔 التنبيهات', tabUniverse:'⚙ الإعدادات', tabPositions:'💼 المحفظة',
    all:'الكل', fBanks:'البنوك', fEnergy:'الطاقة', fPetro:'البتروكيماويات', fTelecom:'الاتصالات',
    fHealth:'الصحة', fFood:'الغذاء', fOther:'أخرى', fBuys:'الشراء', fWatch:'المراقبة', fSells:'البيع', fHalal:'حلال',
    mAll:'جميع الأسواق', mTasi:'تاسي', mUs:'الأسهم الأمريكية', mEtf:'صناديق ETF', mCrypto:'العملات المشفرة', mCommodity:'السلع',
    fTech:'تقنية', fFinancials:'مالية', fConsumer:'استهلاكي', fMetal:'معادن', fCrude:'طاقة', fEtfEquity:'صناديق أسهم', fEtfMetal:'صناديق معادن', fEtfCrude:'صناديق نفط', fEtfBond:'صناديق سندات',
    selectAllVis:'تحديد الكل الظاهر',
    colTicker:'الرمز', colName:'الاسم', colSector:'القطاع', colPrice:'السعر',
    colScore:'التقييم ↓', colRsi:'القوة النسبية', colMacd:'الزخم', colVol:'الحجم×', colEma:'المتوسطات', colSignal:'حالة الاتجاه', colSharia:'حلال', colRs:'ق.ن.',
    emptyScreener:'لا توجد بيانات مسح بعد.<br>اضغط <strong>مسح الكل</strong> للبدء.',
    scoringTitle:'كيف يُقيَّم السهم (من 8 نقاط)',
    scoringSubtitle:'تُطبَّق هذه القواعد الخمس تلقائياً في كل عملية مسح',
    scanning:'جارٍ المسح…',
    lastScan:'آخر مسح:',
    sBanking:'البنوك', sEnergy:'الطاقة', sPetrochem:'البتروكيماويات', sTelecom:'الاتصالات',
    sUtility:'المرافق', sFood:'الغذاء', sRetail:'التجزئة', sHealth:'الرعاية الصحية',
    sRealestate:'العقارات', sCement:'الأسمنت', sIndustrial:'الصناعة',
    sInsurance:'التأمين', sOther:'أخرى',
    sTech:'تقنية', sFinancials:'مالية', sConsumer:'استهلاكي', sRetailUs:'تجزئة', sHealthUs:'صحة',
    sEnergyUs:'طاقة', sEtfEquity:'صناديق أسهم', sEtfMetal:'صناديق معادن', sEtfCrude:'صناديق نفط', sEtfBond:'صناديق سندات',
    sCrypto:'مشفرة', sMetal:'معادن', sCrude:'نفط وغاز',
    bStrongBuy:'اتجاه صاعد قوي', bBuy:'اتجاه صاعد', bWatch:'يتشكل', bSkip:'محايد', bError:'خطأ', bNoData:'لا بيانات',
    bStrongSell:'اتجاه هابط قوي', bSell:'اتجاه هابط', bAvoid:'ضعيف',
    critBreakdown:'تفاصيل المعايير',
    pass:'ناجح', fail:'فاشل',
    entryGuidanceTitle:'📍 توجيه الدخول',
    watchTitle:'👁 ما يجب مراقبته',
    lEmaStack:'هيكل المتوسطات المتحركة', lEmaStackBear:'هيكل هابط',
    lEma200:'النظام طويل المدى',          lEma200Bear:'تحت النظام طويل المدى',
    lRsi:'نطاق زخم RSI',                  lRsiBear:'منطقة ضعف RSI',
    lMacd:'زخم MACD',
    lVol:'تأكيد الحجم',
    sellGuidanceTitle:'▼ إعداد هابط — تجنب / خروج',
    avoidTitle:'◆ هبوط مبكر — مراقبة',
    pts:' نقاط',
    srEmaStack:'المتوسط 13 فوق 34 فوق 89 — اتجاه صعودي عبر جميع الأطر الزمنية',
    srEma200:'السعر فوق المتوسط 200 — تأكيد نظام السوق الصاعد',
    srRsi:'RSI في نطاق الزخم — لا ضعف ولا تشبع',
    srMacd:'هيستوجرام MACD إيجابي — تسارع الزخم قصير المدى',
    srVol:'الحجم فوق 1.2× المتوسط 20 يوم — مشاركة مؤسسية',
    crBullish:'🟢 المعايير الصعودية', crBearish:'🔴 المعايير الهبوطية',
    crNeutral:'⚪ محايد / لا تداول', crRisk:'⚠ قواعد المخاطرة',
    addPlaceholder:'إضافة عنصر جديد…', addBtn:'+ إضافة',
    editHint:'عدّل العناصر مباشرةً ثم احفظ.', saveBtn:'💾 حفظ',
    unsaved:'تغييرات غير محفوظة', saved:'تم الحفظ ✓',
    loading:'جارٍ التحميل…',
    // Fundamentals
    fundTitle:'التحليل الأساسي', fundLoading:'جارٍ جلب البيانات…', fundError:'تعذر تحميل البيانات الأساسية',
    fundScore:'درجة التحليل', sValuation:'التقييم', sDividends:'توزيعات الأرباح',
    sProfitability:'الربحية', sHealth:'الصحة المالية', s52w:'النطاق السنوي (52 أسبوع)',
    lPE:'مكرر الربحية (فعلي)', lFPE:'مكرر الربحية (توقعي)', lPB:'السعر/القيمة الدفترية', lEVEbitda:'EV/EBITDA',
    lDivYield:'عائد التوزيعات', lDivRate:'التوزيع السنوي', lPayoutRatio:'نسبة التوزيع', lExDiv:'تاريخ الاستحقاق',
    lROE:'العائد على حقوق الملكية', lNetMargin:'هامش صافي الربح', lOpMargin:'هامش التشغيل', lEbitdaMargin:'هامش EBITDA',
    lDE:'نسبة الدين/الملكية', lCurrentRatio:'نسبة التداول', lFreeCF:'التدفق النقدي الحر', lMarketCap:'القيمة السوقية',
    lBeta:'بيتا', lInsider:'حصة المطلعين', lInstitution:'حصة المؤسسات',
    sigUndervalued:'مقيَّم بأقل من قيمته', sigFair:'قيمة عادلة', sigOvervalued:'مقيَّم بأكثر من قيمته',
    fundNone:'—', na:'غير متاح',
    // Sharia
    sHalal:'حلال', sNonHalal:'غير حلال', sReview:'مراجعة', sUnknown:'؟',
    shariaTitle:'الامتثال الشرعي', shariaDisc:'بناءً على معايير AAOIFI القطاعية. تحقق مع عالم متخصص في التمويل الإسلامي.',
    liveOff:'مباشر', liveOn:'مباشر ✓', liveStopped:'إيقاف',
    liveInterval:'الفاصل', liveMin:'د',
    btRun:'اختبار الاستراتيجية (2 سنة)', btRunning:'جارٍ…', btTitle:'نتائج الاختبار',
    btTrades:'صفقات', btWinRate:'نسبة الربح', btAvgReturn:'متوسط العائد', btPF:'عامل الربح',
    btRecent:'آخر الصفقات', btStop:'وقف', btT1:'هدف1', btT2:'هدف2', btTimeout:'انتهاء',
    calEarnings:'نتائج', calDays:'أيام',
    finnhubToken:'رمز Finnhub',
    analyticsTitle:'تحليل الأداء',
    anWinRate:'نسبة الربح', anAvgWin:'متوسط الربح', anAvgLoss:'متوسط الخسارة', anPF:'عامل الربح',
    closeTrade:'إغلاق', closePrice:'سعر الخروج', closeDate:'تاريخ الخروج', closeReason:'السبب',
    closeReasonT1:'الهدف 1', closeReasonT2:'الهدف 2', closeReasonStop:'وقف الخسارة', closeReasonManual:'يدوي',
    closeConfirm:'تأكيد الإغلاق',
    modeSwing:'📈 تأرجح', modePosition:'📊 مراكز', modeBreakout:'⚡ اختراق',
    exportCsv:'⬇ تصدير CSV',
    colWeekly:'أسبوعي', wFull:'W ✓✓', wPartial:'W ✓', wNone:'W ✗', wNa:'—',
    weeklyTitle:'التوافق الأسبوعي', wEmaStack:'هيكل المتوسطات (أسبوعي)', wAbove200:'فوق المتوسط 200 (أسبوعي)',
    posTitle:'محفظتي', posSubtitle:'تتبع مدخلاتك والأرباح مقارنة بآخر سعر مسح',
    posEntry:'سعر الدخول', posScanPrice:'سعر المسح', posPnl:'الربح/الخسارة', posShares:'الأسهم', posDate:'التاريخ',
    posEmpty:'لا توجد مراكز بعد. أضف أدناه.',
    posLivePrice:'تحديث السعر', posLivePriceLoading:'جاري التحميل…',
    notifTitle:'إشعارات تيليجرام', notifTest:'اختبار', notifEnabled:'مفعّل',
    notifToken:'رمز البوت', notifChatId:'معرف الدردشة',
    notifHint:'للحصول على Chat ID: أرسل رسالة لـ @userinfobot في تيليجرام.',
    notifSaved:'تم الحفظ ✓', notifTestOk:'تم إرسال الرسالة ✓', notifTestFail:'فشل — تحقق من الإعدادات',
    viewChart:'عرض الرسم البياني', chartLoading:'جاري التحميل…',
    breadthTitle:'عمق السوق',
    moversTitle:'ما الذي تغير منذ آخر مسح', moversImp:'تحسّن', moversDeg:'تراجع', moversEmpty:'لا تغييرات منذ آخر مسح',
    atrTitle:'مستويات التداول (ATR)', atrStop:'وقف الخسارة', atrT1:'الهدف 1', atrT2:'الهدف 2',
    rsTitle:'القوة النسبية', rsLeader:'متفوق', rsLaggard:'متأخر',
    setAlert:'تنبيه', alertSet:'تم التنبيه ✓', alertFail:'فشل',
    // Universe
    univTitle:'كون الأسهم', univSubtitle:'أدر الرموز التي يتم فحصها لكل سوق',
    univSymPlaceholder:'الرمز (مثال: AAPL أو TADAWUL:1120)', univNamePlaceholder:'الاسم (اختياري)',
    univAdd:'+ إضافة', univReset:'إعادة', univSave:'حفظ', univSaved:'تم الحفظ ✓',
    univEmpty:'لا توجد رموز. أضف أدناه.', univCount:'رمز',
    legendBtn:'ℹ دليل الإشارات', legendClose:'إغلاق الدليل',
    colDelta:'Δ', archiveBtn:'📦 السجل', archiveLive:'🔴 مباشر (حالي)',
    freshLive:'مباشر', freshOld:'بيانات قديمة',
    tabWatchlist:'☆ المراقبة', wlSubtitle:'اضغط ☆ في الفارز لإضافة أسهم',
    wlEmpty:'لا أسهم في قائمة المراقبة بعد.\nاضغط ☆ بجانب أي سهم في الفارز للإضافة.',
    wlAddedToast:'أضيف إلى قائمة المراقبة', wlRemovedToast:'أزيل من قائمة المراقبة',
    retryBtn:'↻ إعادة', priceAlertSet:'تم ضبط التنبيه ✓',
    tvEmbedBtn:'تحميل الرسم البياني',
    ruleTitle:'قواعد التنبيه الذكي', ruleSub:'إشعار عند تحقق الشروط بعد كل مسح',
    ruleEmpty:'لا قواعد بعد. أضف واحدة أدناه.', ruleDeleted:'تم حذف القاعدة.',
    tvOpenChart:'📈 عرض الرسم', tvSetAlert:'🔔 تنبيه', tvWatchlist:'⭐ المراقبة', tvCopySymbol:'⧉ نسخ',
    tfTitle:'توافق الأطر الزمنية', tfLoading:'جارٍ تحميل 4H + D + W…',
    newsTitle:'آخر الأخبار', newsNoToken:'أضف رمز Finnhub في الإعدادات للأخبار.', newsNone:'لا أخبار حديثة.',
    divTitle:'معلومات التوزيعات', divYield:'العائد', divNext:'الدفعة القادمة', divAmount:'المبلغ',
    hmapTitle:'خريطة المحفظة', hmapSub:'الحجم = قيمة المركز · اللون = ر/خ',
    sparkUp:'التقييم في ارتفاع', sparkDown:'التقييم في انخفاض',
    tabMarkets:'🌍 الأسواق',
    mktOverviewTitle:'نظرة عامة على الأسواق العالمية', mktRefresh:'⟳ تحديث', mktLoading:'جارٍ تحميل بيانات السوق…',
    mktOpportTitle:'أقوى الاتجاهات', mktOpportSub:'أعلى درجات توافق الاتجاه من آخر مسح (وصفي، ليس قائمة شراء)', mktOpportEmpty:'قم بتشغيل مسح أولاً لرؤية درجات الاتجاه.',
    mktBull:'▲ صاعد', mktBear:'▼ هابط', mktRange:'◆ محايد',
    mktRsi:'RSI', mktVol:'التذبذب', mkt20d:'20 يوم', mkt52w:'52 أسبوع',
    execTitle:'الملخص التنفيذي', execEntry:'نطاق الدخول', execStop:'وقف الخسارة', execT1:'الهدف 1', execT2:'الهدف 2',
    execRes:'المقاومة', execSup:'الدعم', execFair:'القيمة العادلة', execRR:'ع:م',
    vhTitle:'القيمة مقارنة بالأقران', vhPe:'م/ر', vhPb:'س/ق', vhDe:'دين/ملكية', vhFair:'القيمة العادلة المقدرة',
    vhCheap:'رخيص', vhFair2:'عادل', vhPricey:'مرتفع', vhNa:'غير متاح',
    colDiv:'تباعد', dtabSignal:'نظرة عامة', dtabTrade:'التنفيذ', dtabAnalysis:'الإعداد', dtabFund:'البحث',
    rgDailyVol:'تذبذب يومي', rg20d:'أداء 20 يوم', rg52w:'موقع 52 أسبوع', rg52wRange:'النطاق السنوي',
    divBullish:'تباعد صعودي', divBearish:'تباعد هبوطي', srLevelsTitle:'الدعم والمقاومة', sizerTitle:'محسب الحجم',
    tabVirtual:'🎮 محفظة وهمية', vpCash:'السيولة', vpValue:'قيمة المحفظة', vpPnl:'إجمالي الربح/الخسارة', vpReturn:'العائد',
    vpHoldings:'الأسهم المحتفظ بها', vpReset:'↺ إعادة', vpAvgCost:'متوسط التكلفة', vpValue2:'القيمة', vpReturnCol:'العائد',
    vpEmpty:'لا توجد مراكز وهمية بعد. استخدم شراء وهمي في تبويب التداول.',
    vpHistory:'سجل الصفقات', vpAction:'الإجراء', vpTotal:'الإجمالي', vpCashAfter:'السيولة بعد', vpNoTrades:'لا صفقات بعد.',
    vpBuy:'شراء وهمي', vpSell:'بيع وهمي', vpShares:'عدد الأسهم',
    vpBuyOk:'تم الشراء', vpSellOk:'تم البيع', vpErrFunds:'سيولة غير كافية', vpErrShares:'أسهم غير كافية',
    sarToggle:'ريال', usdToggle:'$ دولار',
  }
};

// Plain-language criterion explanations per language
const EXPL = {
  emaStack: {
    en: {
      pass:`The three moving averages are arranged like a perfect staircase: the 13-day is above the 34-day, which is above the 89-day. Each step supports the one above it. This means the trend is pointing upward across short, medium, and longer timeframes — the essential foundation for a bullish entry.`,
      fail:`The moving averages are tangled or inverted. When shorter-term EMAs fall below longer-term ones, the trend is unclear or reversing downward. No reliable buy signal exists until the staircase re-aligns properly.`
    },
    ar: {
      pass:`المتوسطات المتحركة مرتبة ترتيباً صعودياً مثالياً: المتوسط 13 فوق 34 فوق 89 يوماً. كل مستوى يدعم ما فوقه كالدرج المتصاعد. هذا يعني أن الاتجاه صعودي عبر الأطر الزمنية القصيرة والمتوسطة والطويلة — الأساس الضروري لإشارة الشراء.`,
      fail:`المتوسطات المتحركة متشابكة أو مقلوبة، مما يشير إلى غموض الاتجاه أو ميله للهبوط. لا توجد إشارة شراء موثوقة حتى يعود الترتيب الصعودي الصحيح.`
    }
  },
  ema200: {
    en: {
      pass:`Price is trading above the 200-day moving average — the most important long-term trend filter used by institutions and funds worldwide. Being above it confirms the stock is in a bull-market regime. The strategy only enters longs above this line.`,
      fail:`Price is below the 200-day EMA, meaning the stock is still in a long-term downtrend. Even if short-term signals look promising, buying below the 200-day means fighting the dominant trend. Wait for a confirmed reclaim of this level first.`
    },
    ar: {
      pass:`السعر يتداول فوق المتوسط المتحرك 200 يوم — أهم مرشح للاتجاه طويل المدى تستخدمه الصناديق والمؤسسات الكبرى. التداول فوقه يؤكد أن السهم في سوق صاعد بعيد المدى. الاستراتيجية لا تشتري أسفل هذا الخط.`,
      fail:`السعر تحت المتوسط المتحرك 200 يوم، أي أن السهم لا يزال في اتجاه هبوطي طويل المدى. حتى لو بدت الإشارات القصيرة واعدة، فإن الشراء هنا يعني مقاومة الاتجاه السائد. انتظر استعادة هذا المستوى أولاً.`
    }
  },
  rsiOk: {
    en: `RSI sits in the ideal momentum zone (52–78): strong enough to confirm real buying interest is present, but not so high the stock is dangerously stretched. This is the sweet spot — the trend has energy behind it without being overextended.`,
    ar: `مؤشر RSI في النطاق المثالي للزخم (52–78): قوي بما يكفي لتأكيد وجود اهتمام شرائي حقيقي، دون أن يكون ممتداً للأعلى بشكل مبالغ فيه. هذه هي المنطقة المثلى للدخول — الاتجاه لديه زخم دون إفراط.`
  },
  rsiOb: {
    en: `RSI is in overbought territory (above 78). The stock has rallied sharply and may need to cool down before the next leg higher. It's better to wait for RSI to pull back below 72 to avoid buying at the top of a short-term surge.`,
    ar: `مؤشر RSI في منطقة التشبع الشرائي (فوق 78). ارتفع السهم بقوة وقد يحتاج لتصحيح قبل الصعود التالي. انتظر تراجع RSI إلى ما دون 72 لتجنب الشراء عند قمة موجة قصيرة المدى.`
  },
  rsiWeak: {
    en: `RSI is below 52 — the threshold this strategy uses to confirm bullish momentum. At 48–52, the stock is in a neutral zone: neither clearly bullish nor bearish on momentum alone. RSI can stay in this zone for weeks during consolidation. A decisive cross above 52 alongside rising MACD would be the entry trigger to watch for.`,
    ar: `مؤشر RSI دون 52 — الحد الذي تستخدمه الاستراتيجية لتأكيد الزخم الصعودي. في نطاق 48–52 يكون السهم في منطقة محايدة. راقب تجاوز RSI لـ52 مع MACD إيجابي كمحفز للدخول.`
  },
  macd: {
    en: {
      pass:`The MACD histogram is positive, meaning the short-term EMA (12-day) is accelerating faster than the long-term (26-day). In plain terms: recent price momentum is real and building — not just noise or a short-term bounce.`,
      fail:`The MACD histogram is negative — short-term momentum is still lagging behind. This is common in early recovery phases where price has lifted but hasn't fully accelerated yet. A flip to a positive histogram would be the meaningful confirmation signal.`
    },
    ar: {
      pass:`هيستوجرام MACD إيجابي، مما يعني أن المتوسط قصير المدى (12 يوم) يتسارع بشكل أسرع من الطويل (26 يوم). بمعنى بسيط: زخم السعر الأخير حقيقي ومتنامٍ، وليس مجرد ضوضاء أو ارتداد مؤقت.`,
      fail:`هيستوجرام MACD سالب — الزخم قصير المدى لا يزال يتأخر أو يتباطأ. هذا شائع في مراحل التعافي المبكرة. تحول الهيستوجرام للإيجابية سيكون إشارة التأكيد المطلوبة.`
    }
  },
  vol: {
    en: {
      pass:`Volume came in well above average — strong participation confirms institutional or professional buying, not just retail speculation. High volume on up-days is one of the clearest signs of genuine demand and tends to sustain the move.`,
      fail:`Volume is below the 1.2× threshold required for Tadawul stocks. Moves on thin volume often reverse when stronger sellers return. Look for a high-volume day to confirm the direction before entering.`
    },
    ar: {
      pass:`الحجم جاء فوق المتوسط بشكل واضح — مشاركة قوية تدل على اهتمام مؤسسي أو احترافي حقيقي، وليس مجرد مضاربة أفراد. الحجم المرتفع مع الارتفاع من أوضح علامات الطلب الجاد والمستدام.`,
      fail:`الحجم دون عتبة 1.2× المطلوبة للأسهم السعودية. التحركات بحجم ضعيف كثيراً ما تفشل حين يعود البائعون الأقوى. ابحث عن يوم بحجم مرتفع يؤكد الاتجاه قبل الدخول.`
    }
  },
  volBear: {
    en: {
      pass:`Volume is above average — but on a SELL signal this confirms selling pressure, not buying. High volume during a downtrend means institutions are actively distributing (exiting) shares. Note: Whale Watch's MFI indicator tells you the direction of that volume — if MFI is below 50, the heavy volume is flowing out, not in.`,
      fail:`Volume is below the 1.2× threshold. Without strong volume, the selling move lacks institutional conviction — the downtrend may be slower to develop or could reverse on any positive catalyst.`
    },
    ar: {
      pass:`الحجم فوق المتوسط — لكن في إشارة البيع هذا يؤكد ضغط البيع، وليس الشراء. الحجم المرتفع خلال الهبوط يعني أن المؤسسات تتخارج بنشاط. ملاحظة: مؤشر MFI في متابعة الحيتان يوضح اتجاه هذا الحجم.`,
      fail:`الحجم دون عتبة 1.2×. بدون حجم قوي، تفتقر حركة الهبوط لإقناع مؤسسي — قد يكون الهبوط أبطأ أو ينعكس عند أي محفز إيجابي.`
    }
  },
  verdicts: {
    en: {
      'STRONG BUY':  n => `<strong>${n}</strong> is in a <strong>strong uptrend</strong> right now: moving averages stacked up, price above its long-term baseline, RSI and MACD showing momentum. This describes the stock's <em>current state</em> — it is <strong>not a forecast</strong>. In testing, names in this state were profitable only ~37% of the time and lagged simple buy-and-hold. Use it as market context; the validated buy-list is the Momentum tab, and your own chart read matters.`,
      'BUY':         n => `<strong>${n}</strong> is in an <strong>uptrend</strong> but missing one or two confirmations. A description of current state, not advice — the score does not predict returns. Context for your own read.`,
      'WATCH':       n => `<strong>${n}</strong> shows <strong>early/mixed</strong> signals — no established trend yet. Descriptive only; nothing to act on from the score alone.`,
      'SKIP':        n => `<strong>${n}</strong> has <strong>no clear trend</strong> either way right now. Neutral state.`,
      'STRONG SELL': n => `<strong>${n}</strong> is in a <strong>strong downtrend</strong>: EMAs inverted, price below its baseline, weak RSI, MACD down. This describes current state — <strong>not a trade signal</strong> (you can't short TASI). Context only.`,
      'SELL':        n => `<strong>${n}</strong> is in a <strong>downtrend</strong>. Descriptive state, not a short call (no shorting on TASI). Context only.`,
      'AVOID':       n => `<strong>${n}</strong> is showing <strong>weakness</strong> — early downward signs, not a confirmed trend. Descriptive state, not advice.`,
    },
    ar: {
      'STRONG BUY':  n => `<strong>${n}</strong> في <strong>اتجاه صاعد قوي</strong> حالياً: المتوسطات مرتبة صعوداً، السعر فوق خط الأساس، وRSI وMACD يظهران زخماً. هذا <em>وصف للحالة الراهنة</em> وليس توقعاً. في الاختبارات، الأسهم في هذه الحالة كانت رابحة بنسبة ~37% فقط وتخلّفت عن الشراء والاحتفاظ البسيط. استخدمه كسياق للسوق؛ قائمة الشراء المُتحقَّقة هي تبويب الزخم.`,
      'BUY':         n => `<strong>${n}</strong> في <strong>اتجاه صاعد</strong> مع نقص تأكيد أو اثنين. وصف للحالة وليس نصيحة — التقييم لا يتنبأ بالعوائد. سياق لقراءتك الخاصة.`,
      'WATCH':       n => `<strong>${n}</strong> إشارات <strong>مبكرة/مختلطة</strong> دون اتجاه واضح. وصف فقط.`,
      'SKIP':        n => `<strong>${n}</strong> <strong>لا يوجد اتجاه واضح</strong> حالياً. حالة محايدة.`,
      'STRONG SELL': n => `<strong>${n}</strong> في <strong>اتجاه هابط قوي</strong>: المتوسطات مقلوبة، السعر تحت الأساس، RSI ضعيف، MACD هابط. وصف للحالة — <strong>وليس إشارة تداول</strong> (لا بيع على المكشوف في تداول). سياق فقط.`,
      'SELL':        n => `<strong>${n}</strong> في <strong>اتجاه هابط</strong>. وصف للحالة وليس إشارة بيع على المكشوف (غير ممكن في تداول). سياق فقط.`,
      'AVOID':       n => `<strong>${n}</strong> يُظهر <strong>ضعفاً</strong> — علامات هبوطية مبكرة غير مؤكدة. وصف للحالة وليس نصيحة.`,
    }
  },
  entryGuide: {
    en: (zone, stop) => `<em style="color:var(--text3)">Illustrative levels only — this score is not a validated buy trigger (it lagged buy-and-hold in testing). The validated buy-list is the Momentum tab. If you do trade it, these are reasonable risk references:</em><br><br>A <strong>pullback to EMA 34 (${zone})</strong> tends to act as dynamic support in trending stocks; chasing well above it carries worse risk.<br><br><strong>Structure stop:</strong> A close below EMA 89 (${stop}) breaks the medium-term trend structure — a natural invalidation level.<br><br><strong>ATR stop:</strong> 1.5× ATR from entry for mechanical sizing. The EMA 89 stop is wider (swing/position); the ATR stop is tighter (shorter-term).<br><br><strong>Reference targets:</strong> T1 at 1.5× ATR (1:1), T2 at 3× ATR (2:1).`,
    ar: (zone, stop) => `<em style="color:var(--text3)">مستويات استرشادية فقط — هذه الدرجة ليست إشارة شراء موثّقة (تأخرت عن الشراء والاحتفاظ في الاختبار). قائمة الشراء الموثّقة في تبويب الزخم. إن قررت التداول فهذه مراجع للمخاطرة:</em><br><br>التراجع نحو <strong>المتوسط 34 (${zone})</strong> يعمل كدعم ديناميكي في الأسهم الصاعدة.<br><br><strong>وقف الهيكل:</strong> إغلاق أسفل المتوسط 89 (${stop}) يكسر بنية الاتجاه.<br><br><strong>أهداف مرجعية:</strong> T1 عند 1.5× ATR (1:1)، T2 عند 3× ATR (2:1).`
  },
  watchGuide: {
    en: (missing, zone) => `This stock is <strong>${missing.length} step${missing.length!==1?'s':''} away</strong> from a valid entry:<br><br>${missing.map(w=>`• ${w}`).join('<br>')}<br><br>Set a price alert near <strong>EMA 34 (${zone})</strong> and revisit when RSI crosses 52 or MACD turns positive.`,
    ar: (missing, zone) => `هذا السهم يبعد <strong>${missing.length} خطوة</strong> عن نقطة الدخول:<br><br>${missing.map(w=>`• ${w}`).join('<br>')}<br><br>ضع تنبيهاً سعرياً قرب <strong>المتوسط 34 (${zone})</strong>.`
  },
  sellGuide: {
    en: (zone, base) => `Price is trading in a confirmed bearish trend. <strong>Avoid new long positions.</strong><br><br>If holding a long position: consider exiting on any bounce toward <strong>EMA 34 (${zone})</strong> — that level now acts as dynamic resistance.<br><br><strong>Watch:</strong> A close above EMA 89 (${base}) would invalidate the bearish setup.`,
    ar: (zone, base) => `السعر في اتجاه هابط مؤكد. <strong>تجنب الشراء.</strong><br><br>إن كنت تحمل مركزاً طويلاً: فكر في الخروج عند أي ارتداد نحو <strong>المتوسط 34 (${zone})</strong> — هذا المستوى أصبح مقاومة ديناميكية.<br><br><strong>انتبه:</strong> إغلاق فوق المتوسط 89 (${base}) يُلغي الإعداد الهبوطي.`
  },
  avoidGuide: {
    en: (missing, zone) => `<strong>${missing.length} bearish signal${missing.length!==1?'s':''}</strong> present — setup is incomplete but deteriorating:<br><br>${missing.map(w=>`• ${w}`).join('<br>')}<br><br>Hold off on new entries. A break below <strong>EMA 34 (${zone})</strong> would confirm the bearish turn.`,
    ar: (missing, zone) => `<strong>${missing.length} إشارة هبوطية</strong> حاضرة — الإعداد ناقص لكن يتراجع:<br><br>${missing.map(w=>`• ${w}`).join('<br>')}<br><br>لا تداول الآن. كسر <strong>المتوسط 34 (${zone})</strong> يؤكد الانعكاس الهبوطي.`
  },
  // ── Bearish criterion explanations ─────────────────────────────────────────
  emaStackBear: {
    en: {
      pass: `The moving averages are inverted — EMA 13 is below EMA 34, which is below EMA 89. This descending staircase confirms a downtrend is in place across all timeframes and is one of the strongest bearish structural signals.`,
      fail: `The moving averages are not in a bearish formation. The trend structure doesn't yet confirm a sustained downtrend.`
    },
    ar: {
      pass: `المتوسطات المتحركة مقلوبة — 13 أسفل 34 أسفل 89. هذا الترتيب الهابط يؤكد الاتجاه الهبوطي عبر جميع الأطر.`,
      fail: `المتوسطات ليست في تشكيل هبوطي. البنية لا تؤكد الاتجاه الهابط بعد.`
    }
  },
  ema200Bear: {
    en: {
      pass: `Price is below the 200-day EMA — the most important long-term trend line. Trading below it confirms the stock is in a long-term bear market regime. Institutional buyers typically do not buy below this level.`,
      fail: `Price is still above the 200-day EMA, meaning the long-term trend hasn't turned bearish. The bearish setup is incomplete.`
    },
    ar: {
      pass: `السعر أسفل المتوسط 200 — أهم خط اتجاه طويل الأمد. التداول تحته يؤكد أن السهم في سوق دب بعيد المدى.`,
      fail: `السعر لا يزال فوق المتوسط 200. الإعداد الهبوطي غير مكتمل.`
    }
  },
  rsiWeakBear: {
    en: `RSI is in the weak zone (22–48): momentum is clearly negative without being oversold. This is the bearish equivalent of the bullish momentum zone — the ideal RSI range for a confirmed downtrend entry.`,
    ar: `مؤشر RSI في منطقة الضعف (22–48): الزخم سلبي بوضوح دون تشبع بيعي. هذه المنطقة المثلى للاتجاه الهابط المؤكد.`
  },
  rsiNotWeak: {
    en: `RSI hasn't dropped below 48 yet — the threshold needed to confirm bearish momentum. Wait for it to enter the weak zone (22–48) before considering this a full bearish signal.`,
    ar: `مؤشر RSI لم ينخفض دون 48 بعد — الحد المطلوب لتأكيد الزخم الهابط. انتظر دخوله منطقة الضعف (22–48).`
  },
  rsiOs: {
    en: `RSI is in extreme oversold territory (below 22). This is a warning, not a buy signal — it means the stock has fallen very hard very fast. Oversold levels frequently trigger short-term technical bounces (short-covering rallies), but these typically don't reverse the underlying downtrend. For bearish setups, this criterion doesn't score points precisely because a bounce is likely — wait for the bounce to fade and RSI to re-enter the 22–48 zone before acting on the bearish signal.`,
    ar: `مؤشر RSI في منطقة التشبع البيعي الشديد (تحت 22). هذه إشارة تحذير وليست إشارة شراء — تعني أن السهم هبط بقوة وسرعة. التشبع البيعي كثيراً ما يسبق ارتداداً فنياً مؤقتاً، لكنه نادراً ما يعكس الاتجاه الهابط. انتظر انتهاء الارتداد وعودة RSI إلى 22–48 قبل التصرف.`
  },
  macdBear: {
    en: {
      pass: `MACD histogram is negative — short-term momentum is deteriorating faster than the longer-term average. This confirms selling pressure is real and accelerating.`,
      fail: `MACD histogram is positive. Momentum hasn't turned fully bearish yet, which weakens the sell signal.`
    },
    ar: {
      pass: `هيستوجرام MACD سالب — الزخم قصير المدى يتراجع أسرع من الطويل. يؤكد أن ضغط البيع حقيقي ومتسارع.`,
      fail: `هيستوجرام MACD إيجابي. الزخم لم يتحول هبوطياً بعد، مما يضعف إشارة البيع.`
    }
  }
};

// ────────────────────────────────────────────────────────────────────────────
// Language
// ────────────────────────────────────────────────────────────────────────────
let lang = localStorage.getItem('tasi-lang') || 'en';

function t(key){ return TR[lang][key] || TR.en[key] || key; }

function toggleLang(){
  setLang(lang === 'en' ? 'ar' : 'en');
}

function setLang(newLang){
  lang = newLang;
  localStorage.setItem('tasi-lang', lang);
  const isAr = lang === 'ar';
  document.documentElement.lang = lang;
  document.documentElement.dir  = isAr ? 'rtl' : 'ltr';
  document.getElementById('lang-btn').textContent = isAr ? 'English' : 'عربي';
  // Update all data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if(val) el.innerHTML = val;
  });
  // Update buttons with data-i18n-btn
  document.getElementById('btn-scan').innerHTML  = t('scanAll');
  // Update empty state text
  const es = document.getElementById('empty-screener-text');
  if(es) es.innerHTML = t('emptyScreener');
  // Re-render if data loaded
  renderSectorFilter();
  applyModeUI();
  if(scanData.length) renderTable();
  if(openDrawerData) openDrawer(openDrawerData);
  renderScoringRules();
  if(document.getElementById('criteria-grid').innerHTML) loadCriteriaEditor();
}

// ────────────────────────────────────────────────────────────────────────────
// Data & state
// ────────────────────────────────────────────────────────────────────────────

// ─── VIEW MODE (Beginner / Pro) ──────────────────────────────────────────────
let viewMode = localStorage.getItem('mawjah_view_mode') || 'pro';

function initViewMode() {
  document.body.setAttribute('data-view', viewMode);
  const isPro = viewMode === 'pro';
  document.getElementById('view-btn-pro')?.classList.toggle('active', isPro);
  document.getElementById('view-btn-guide')?.classList.toggle('active', !isPro);
}

function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('mawjah_view_mode', mode);
  document.body.setAttribute('data-view', mode);
  document.getElementById('view-btn-pro')?.classList.toggle('active', mode === 'pro');
  document.getElementById('view-btn-guide')?.classList.toggle('active', mode === 'guide');
  if (scanData.length) { renderMarketMood(); renderBeginnerTable(); }
  // Sync summary cards visibility in guide mode
  document.getElementById('scan-progress')?.style && null;
}

const BEG_BIAS_PLAIN = {
  'STRONG BUY' : 'Strong uptrend state — nearly all checks aligned. Descriptive only, not a buy signal (lagged buy-and-hold in testing). Validated buy-list = Momentum tab.',
  'BUY'        : 'Uptrend state — most checks aligned. Descriptive context, not a buy signal.',
  'WATCH'      : 'Interesting but not ready yet. Keep an eye on it.',
  'SKIP'       : 'No signal — not worth acting on right now.',
  'AVOID'      : 'Early weakness detected. Do not buy.',
  'SELL'       : 'Weakness confirmed — consider selling or staying out.',
  'STRONG SELL': 'Strong bearish signal — all warning checks triggered.',
};

function renderMarketMood() {
  const el = document.getElementById('market-mood-banner');
  if (!el) return;
  if (!scanData.length) { el.innerHTML = ''; return; }
  const sb   = scanData.filter(r => r.bias === 'STRONG BUY').length;
  const buy  = scanData.filter(r => r.bias === 'BUY').length;
  const sell = scanData.filter(r => r.bias === 'SELL' || r.bias === 'STRONG SELL').length;
  const total = sb + buy;
  let icon, mood, color, desc;
  if (total >= 10) {
    icon = '🟢'; mood = 'Good'; color = 'var(--green)';
    desc = `${total} stocks are in a strong uptrend state right now (descriptive breadth, not a buy signal). Read it as market context; the validated buy-list is the Momentum tab.`;
  } else if (total >= 4) {
    icon = '🟡'; mood = 'Cautious'; color = 'var(--yellow)';
    desc = `${total} stock${total !== 1 ? 's' : ''} in an uptrend state — breadth is mixed (descriptive, not advice). Act on the Momentum tab, not this count.`;
  } else {
    icon = '🔴'; mood = 'Weak'; color = 'var(--red)';
    desc = sell >= 5
      ? `Market breadth is weak — ${sell} stocks in a downtrend state. Context only, not a signal.`
      : `Only ${total} stock${total !== 1 ? 's' : ''} in an uptrend state. Market lacks direction (descriptive breadth).`;
  }
  el.innerHTML = `<div class="mood-banner">
    <div>
      <div class="mood-label">Market Mood</div>
      <div class="mood-badge" style="color:${color}">${icon} ${mood}</div>
    </div>
    <div class="mood-desc">${desc}</div>
  </div>`;
}

function renderBeginnerTable() {
  const el = document.getElementById('beg-screener-content');
  if (!el) return;
  if (!scanData.length) {
    el.innerHTML = `<div class="beg-empty">No scan data yet.<br>Click <strong>Full Scan</strong> to get started.</div>`;
    return;
  }
  const items = [...scanData]
    .filter(r => r.bias !== 'ERROR' && r.bias !== 'NO DATA')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const MAX = 40;
  const shown = items.slice(0, MAX);
  const rows = shown.map(r => {
    const max = r.maxScore || 8;
    const pct = Math.round((r.score ?? 0) / max * 100);
    const col = pct >= 75 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
    const plain = BEG_BIAS_PLAIN[r.bias] || r.bias;
    const isCross = nativeCcy(r.sym) !== currency;
    const priceStr = (isCross ? '~' : '') + fmtPrice(r.price, r.sym);
    const chg = r.change_pct ?? r.chg;
    const chgHtml = chg != null
      ? `<div class="beg-chg" style="color:${chg >= 0 ? 'var(--green)' : 'var(--red)'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</div>`
      : '';
    return `<div class="beg-card" onclick="onRowClick(event,'${r.sym}')">
      <div class="beg-card-info">
        <div class="beg-card-name">${r.name || tickerDisplay(r.sym)}</div>
        <div class="beg-card-sub">${tickerDisplay(r.sym)} · ${sectorLabel(sectorOf(r.sym))}</div>
        <div class="beg-plain">${plain}</div>
        <div class="beg-bar"><div class="beg-bar-fill" style="width:${pct}%;background:${col}"></div></div>
      </div>
      <div class="beg-signal-col">
        ${biasBadgeHtml(r.bias)}
        <div class="beg-price">${priceStr}</div>
        ${chgHtml}
      </div>
    </div>`;
  }).join('');
  const more = items.length > MAX
    ? `<div class="beg-note">Showing top ${MAX} of ${items.length} stocks · Switch to <strong>Pro</strong> view to see all with full technical data</div>`
    : '';
  el.innerHTML = `<div class="beg-list">${rows}</div>${more}`;
}
// ────────────────────────────────────────────────────────────────────────────

let scanData      = [];
let selectedSyms  = new Set();
let openDrawerData= null;
let sortKey       = 'score';
let sortAsc       = false;
let filterSec     = 'all';
let filterBiasVal = 'all';
let searchQuery   = '';
let pollTimer     = null;
let rulesData     = null;
let shariaMap     = {};
let activeMarket  = 'all';
let universeData  = {};
let deltaData     = [];
let positionsData = {};
let settingsData  = {};
let virtualData     = {};
let scoreHistory    = {};
let alertRulesData  = [];
let watchlistData   = JSON.parse(localStorage.getItem('mawjah_watchlist')||'[]');
let priceAlerts     = JSON.parse(localStorage.getItem('mawjah_price_alerts')||'[]');
let archiveViewing  = null;
let scanMode        = localStorage.getItem('mawjah-mode') || 'swing';
let blockDealsCache = [];   // latest block deals — refreshed by loadBlockDeals, read by drawer Overview

// Approximate ADTV (Average Daily Trading Value, SAR) for major TASI stocks
// Used to size block deals relative to each stock's liquidity, not in absolute SAR terms
// Source: rough 30-day averages; update periodically. Unlisted stocks fall through to bucket system.
const TASI_ADTV = {
  '2222':800e6,'1120':400e6,'7010':250e6,'2082':80e6,'1180':120e6,'2030':200e6,
  '1010':90e6,'1050':60e6,'1060':70e6,'1080':50e6,'1100':110e6,'1140':60e6,
  '1020':20e6,'2010':150e6,'2020':90e6,'2050':40e6,'2060':35e6,'2280':25e6,
  '4300':30e6,'4020':20e6,'4150':15e6,'4240':18e6,'4001':22e6,'4031':28e6,
  '2350':45e6,'2360':35e6,'3010':30e6,'3020':25e6,'3030':20e6,
  '6001':15e6,'6004':12e6,'6012':10e6,'6013':8e6,
};
function getADTV(sym) {
  const code = sym.replace('TADAWUL:','');
  if (TASI_ADTV[code]) return TASI_ADTV[code];
  // Fallback bucket by whale_score proxy (large cap ~50M, mid ~20M, small ~8M)
  return null; // caller handles null
}
function dealSignificanceVsADTV(sarValue, sym) {
  const adtv = getADTV(sym);
  if (!adtv) return dealSignificanceAbsolute(sarValue); // fall back to absolute
  const pct = sarValue / adtv * 100;
  if (pct >= 40) return { label:'Massive',  col:'#ff5252',      pct };
  if (pct >= 15) return { label:'Large',    col:'var(--orange)', pct };
  if (pct >=  5) return { label:'Notable',  col:'var(--yellow)', pct };
  if (pct >=  1) return { label:'Small',    col:'var(--text2)',  pct };
  return               { label:'Micro',    col:'var(--text3)',  pct };
}
function dealSignificanceAbsolute(sarValue) {
  if (sarValue >= 50e6) return { label:'Major',   col:'#ff5252',      pct:100 };
  if (sarValue >= 10e6) return { label:'Large',   col:'var(--orange)', pct:75  };
  if (sarValue >=  2e6) return { label:'Notable', col:'var(--yellow)', pct:45  };
  if (sarValue >= 500e3)return { label:'Small',   col:'var(--text2)',  pct:20  };
  return                       { label:'Micro',   col:'var(--text3)',  pct:8   };
}
if (scanMode === 'invest') { scanMode = 'position'; localStorage.setItem('mawjah-mode','position'); }

// ── Currency ──────────────────────────────────────────────────────────────────
const SAR_USD = 3.75;
let currency = localStorage.getItem('mawjah-currency') || 'SAR';

function nativeCcy(sym){ return sym?.startsWith('TADAWUL:') ? 'SAR' : 'USD'; }

function convertPrice(val, sym){
  if(val == null) return null;
  const native = nativeCcy(sym);
  if(native === 'SAR' && currency === 'USD') return val / SAR_USD;
  if(native === 'USD' && currency === 'SAR') return val * SAR_USD;
  return val;
}

function fmtPrice(val, sym){
  const v = convertPrice(val, sym);
  if(v == null) return '—';
  return v.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function ccySign(sym){ return currency === 'SAR' ? 'SAR' : '$'; }

function applyCurrencyUI(){
  const btn = document.getElementById('ccy-btn');
  if(btn) btn.textContent = currency === 'SAR' ? t('usdToggle') : t('sarToggle');
  updatePriceCcyBadge();
  updateCcyInfoBar();
}

function toggleCurrency(){
  currency = currency === 'SAR' ? 'USD' : 'SAR';
  localStorage.setItem('mawjah-currency', currency);
  applyCurrencyUI();
  renderTable();
  if(openDrawerData){
    const r = openDrawerData;
    document.getElementById('d-price').textContent = ccySign(r.sym) + ' ' + fmtPrice(r.price, r.sym);
    buildTradeTab(r);
  }
  renderVirtual();
}

// ────────────────────────────────────────────────────────────────────────────
// Sectors
// ────────────────────────────────────────────────────────────────────────────
const SECTORS = {
  '1120':'banking','1180':'banking','1010':'banking','1030':'banking','1050':'banking',
  '1080':'banking','1140':'banking','1150':'banking','1060':'banking','1020':'banking','1213':'banking',
  '2222':'energy',
  '2010':'petrochem','2090':'petrochem','2380':'petrochem','2060':'petrochem','2350':'petrochem',
  '7010':'telecom','7020':'telecom','7030':'telecom','9200':'telecom','7203':'telecom',
  '5110':'utility','6010':'utility',
  '4200':'food','2050':'food','4190':'food','6070':'food','6090':'food',
  '4150':'retail','4240':'retail','4261':'retail',
  '4002':'health','4007':'health','2160':'health','4009':'health','4013':'health','4017':'health',
  '4300':'realestate','4310':'realestate','4082':'realestate','3001':'realestate',
  '3010':'cement','3020':'cement','3030':'cement','3040':'cement','3050':'cement',
  '2110':'industrial','2120':'industrial','2170':'industrial','4031':'industrial','2180':'industrial',
  '8010':'insurance','8020':'insurance',
};
const SECTOR_KEY = {
  banking:'sBanking', energy:'sEnergy', petrochem:'sPetrochem', telecom:'sTelecom',
  utility:'sUtility', food:'sFood', retail:'sRetail', health:'sHealth',
  realestate:'sRealestate', cement:'sCement', industrial:'sIndustrial',
  insurance:'sInsurance', other:'sOther',
  tech:'sTech', financials:'sFinancials', consumer:'sConsumer', retailus:'sRetailUs', healthus:'sHealthUs',
  energyus:'sEnergyUs', etf_equity:'sEtfEquity', etf_metal:'sEtfMetal', etf_crude:'sEtfCrude', etf_bond:'sEtfBond',
  crypto:'sCrypto', metal:'sMetal', crude:'sCrude',
};

const GLOBAL_SECTOR = {
  'NASDAQ:AAPL':'tech','NASDAQ:NVDA':'tech','NASDAQ:MSFT':'tech','NASDAQ:AMZN':'tech',
  'NASDAQ:META':'tech','NASDAQ:GOOGL':'tech','NASDAQ:TSLA':'tech','NASDAQ:AVGO':'tech',
  'NASDAQ:NFLX':'tech','NASDAQ:COST':'consumer',
  'NYSE:JPM':'financials','NYSE:V':'financials','NYSE:BAC':'financials','NYSE:MA':'financials',
  'NYSE:UNH':'healthus','NYSE:JNJ':'healthus',
  'NYSE:XOM':'energyus',
  'NYSE:WMT':'retailus','NYSE:HD':'retailus','NYSE:PG':'consumer',
  'NASDAQ:QQQ':'etf_equity','NYSE:SPY':'etf_equity','NYSE:IWM':'etf_equity','NYSE:DIA':'etf_equity',
  'NYSE:VTI':'etf_equity','NYSE:EEM':'etf_equity','NYSE:IEMG':'etf_equity','NASDAQ:ARKK':'etf_equity',
  'NYSE:XLK':'etf_equity','NYSE:XLF':'etf_equity',
  'NYSE:GLD':'etf_metal','NYSE:SLV':'etf_metal',
  'NYSE:USO':'etf_crude',
  'NYSE:TLT':'etf_bond',
  'BITSTAMP:BTCUSD':'crypto','BITFINEX:XRPUSD':'crypto','COINBASE:ETHUSD':'crypto',
  'BINANCE:SOLUSDT':'crypto','BINANCE:BNBUSDT':'crypto','COINBASE:AVAXUSD':'crypto','BINANCE:ADAUSDT':'crypto',
  'TVC:GOLD':'metal','TVC:SILVER':'metal','TVC:COPPER':'metal',
  'TVC:USOIL':'crude','TVC:NATURALGAS':'crude',
};

const MARKET_OF_SYM = {
  'NASDAQ:AAPL':'us','NASDAQ:NVDA':'us','NASDAQ:MSFT':'us','NASDAQ:AMZN':'us',
  'NASDAQ:META':'us','NASDAQ:GOOGL':'us','NASDAQ:TSLA':'us','NASDAQ:AVGO':'us',
  'NASDAQ:COST':'us','NASDAQ:NFLX':'us',
  'NYSE:JPM':'us','NYSE:V':'us','NYSE:UNH':'us','NYSE:XOM':'us','NYSE:WMT':'us',
  'NYSE:BAC':'us','NYSE:MA':'us','NYSE:JNJ':'us','NYSE:PG':'us','NYSE:HD':'us',
  'NASDAQ:QQQ':'etf','NYSE:SPY':'etf','NYSE:IWM':'etf','NYSE:DIA':'etf','NYSE:VTI':'etf',
  'NYSE:GLD':'etf','NYSE:SLV':'etf','NYSE:USO':'etf','NYSE:TLT':'etf',
  'NYSE:EEM':'etf','NYSE:XLK':'etf','NYSE:XLF':'etf','NASDAQ:ARKK':'etf','NYSE:IEMG':'etf',
  'BITSTAMP:BTCUSD':'crypto','BITFINEX:XRPUSD':'crypto','COINBASE:ETHUSD':'crypto',
  'BINANCE:SOLUSDT':'crypto','BINANCE:BNBUSDT':'crypto','COINBASE:AVAXUSD':'crypto','BINANCE:ADAUSDT':'crypto',
  'TVC:GOLD':'commodity','TVC:SILVER':'commodity','TVC:USOIL':'commodity',
  'TVC:NATURALGAS':'commodity','TVC:COPPER':'commodity',
};

function marketOf(sym){ return sym.startsWith('TADAWUL:')?'tasi':MARKET_OF_SYM[sym]||'other'; }
function sectorOf(sym){ const id=sym.replace('TADAWUL:',''); return SECTORS[id]||GLOBAL_SECTOR[sym]||'other'; }
function sectorLabel(sec){ return t(SECTOR_KEY[sec]||'sOther'); }
function tickerDisplay(sym){ const i=sym.indexOf(':'); return i>=0?sym.slice(i+1):sym; }

// ── Sector filter options per market ─────────────────────────────────────────
const SECTOR_OPTS = {
  all:       [['all','all'],['banking','fBanks'],['energy','fEnergy'],['petrochem','fPetro'],['tech','fTech'],['financials','fFinancials'],['crypto','mCrypto'],['metal','fMetal'],['other','fOther']],
  tasi:      [['all','all'],['banking','fBanks'],['energy','fEnergy'],['petrochem','fPetro'],['telecom','fTelecom'],['health','fHealth'],['food','fFood'],['other','fOther']],
  us:        [['all','all'],['tech','fTech'],['financials','fFinancials'],['healthus','fHealth'],['energyus','fEnergy'],['consumer','fConsumer'],['retailus','fOther']],
  etf:       [['all','all'],['etf_equity','fEtfEquity'],['etf_metal','fEtfMetal'],['etf_crude','fEtfCrude'],['etf_bond','fEtfBond']],
  crypto:    [['all','all']],
  commodity: [['all','all'],['metal','fMetal'],['crude','fCrude']],
};
function renderSectorFilter(){
  const opts=SECTOR_OPTS[activeMarket]||SECTOR_OPTS.tasi;
  document.getElementById('sector-filters').innerHTML=opts.map(([sec,key])=>
    `<button class="filter-btn${filterSec===sec?' active':''}" onclick="filterSector('${sec}',this)">${t(key)}</button>`
  ).join('');
}

// ────────────────────────────────────────────────────────────────────────────
// Clock
// ────────────────────────────────────────────────────────────────────────────
function updateClock(){
  const n=new Date();
  document.getElementById('clock').textContent=
    n.toLocaleDateString(lang==='ar'?'ar-SA':'en-SA',{weekday:'short',month:'short',day:'numeric'})+
    '  '+n.toLocaleTimeString(lang==='ar'?'ar-SA':'en-SA',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
setInterval(updateClock,1000); updateClock();