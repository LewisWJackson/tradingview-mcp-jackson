"""40 只 ETF 每日风控信号看板 —— 生成 dashboard.html

8 条信号（每只 ETF 亮灯）：
  基础 4 条:
    1. 趋势            : 收盘 vs 20EMA
    2. 均线排列        : EMA5/10/20 多/空/混乱
    3. RSI(14)         : 超买/超卖/正常
    4. 量能            : 今日成交额 / 20 日均
  指标 4 条（对应 TradingView 指标）:
    5. Andean(50,9)               : bull vs bear + signal 过滤
    6. Volume Delta [hapharmonic] : buy% vs sell%
    7. DMH(10,2)                  : Ehlers 方向运动 + Hann 滤波，符号判定
    8. Adaptive Z-Score(20,EMA,3,Adaptive,252,85,15)  : 相对自适应分位阈值

用法：
  python dashboard.py
"""
import json, os, sys, datetime, math
from concurrent.futures import ThreadPoolExecutor, as_completed
import efinance as ef
import akshare as ak
import numpy as np

HERE  = os.path.dirname(os.path.abspath(__file__))
RULES = os.path.join(HERE, 'rules.json')
HIST_DAYS = 60  # 回放保留最近 60 个交易日
OUT   = os.path.join(HERE, 'dashboard.html')

# ===== 基础数学 =====
def ema(xs, n):
    k = 2/(n+1); out=[xs[0]]
    for v in xs[1:]: out.append(v*k + out[-1]*(1-k))
    return out

def rma(xs, n):
    # Wilder's smoothing, alpha = 1/n; 前 n 个用 SMA 初始化（和 Pine 保持一致）
    out = [float('nan')]*len(xs)
    if len(xs) < n: return out
    seed = sum(xs[:n])/n
    out[n-1] = seed
    for i in range(n, len(xs)):
        out[i] = (out[i-1]*(n-1) + xs[i])/n
    return out

def rsi(closes, n=14):
    if len(closes) < n+1: return None
    gains=[]; losses=[]
    for i in range(1, len(closes)):
        d = closes[i]-closes[i-1]
        gains.append(max(d,0)); losses.append(max(-d,0))
    avg_g = sum(gains[:n])/n; avg_l = sum(losses[:n])/n
    for i in range(n, len(gains)):
        avg_g = (avg_g*(n-1) + gains[i])/n
        avg_l = (avg_l*(n-1) + losses[i])/n
    if avg_l == 0: return 100.0
    rs = avg_g/avg_l
    return 100 - 100/(1+rs)

def hann(series, period):
    # FIR Hann filter —— 最后一个值
    PIx2 = 2.0*math.pi/(period+1)
    s=0.0; sc=0.0
    for k in range(1, period+1):
        if len(series)-k < 0 or (series[-k] is None) or (isinstance(series[-k], float) and math.isnan(series[-k])):
            return float('nan')
        coef = 1.0 - math.cos(k*PIx2)
        s  += coef * series[-k]
        sc += coef
    return s/sc if sc else float('nan')

# ===== 指标 =====
def andean(closes, opens, length=50, sig_len=9):
    """Andean Oscillator —— 返回 (bull, bear, signal) 最后值"""
    alpha = 2/(length+1)
    up1=up2=dn1=dn2=closes[0]; up2=up1*up1; dn2=dn1*dn1
    bulls=[]; bears=[]
    for i in range(len(closes)):
        C=closes[i]; O=opens[i]
        up1 = max(C, O, up1 - (up1 - C)*alpha)
        up2 = max(C*C, O*O, up2 - (up2 - C*C)*alpha)
        dn1 = min(C, O, dn1 + (C - dn1)*alpha)
        dn2 = min(C*C, O*O, dn2 + (C*C - dn2)*alpha)
        bulls.append(math.sqrt(max(dn2 - dn1*dn1, 0)))
        bears.append(math.sqrt(max(up2 - up1*up1, 0)))
    mx = [max(a,b) for a,b in zip(bulls, bears)]
    sig = ema(mx, sig_len)
    return bulls[-1], bears[-1], sig[-1]

def dmh(highs, lows, period=10):
    """DMH —— Ehlers 方向运动 + Hann"""
    diff=[0.0]
    for i in range(1, len(highs)):
        up = highs[i]-highs[i-1]; dn = lows[i-1]-lows[i]
        pDM = up if (up>dn and up>0) else 0.0
        mDM = dn if (dn>up and dn>0) else 0.0
        diff.append(pDM - mDM)
    smoothed = rma(diff, period)
    return hann(smoothed, period)

def adaptive_zscore(closes, length=20, smooth=3, lookback=252, up_pct=85, lo_pct=15):
    """Adaptive Z-Score Oscillator —— 返回 (z, upper, lower)"""
    if len(closes) < length+smooth+2: return None, None, None
    basis = ema(closes, length)
    # Pine 的 ta.stdev 是总体标准差（除以 N）
    zs=[]
    for i in range(len(closes)):
        window = closes[max(0,i-length+1):i+1]
        if len(window) < 2: zs.append(0); continue
        m = sum(window)/len(window)
        var = sum((x-m)**2 for x in window)/len(window)
        sd = math.sqrt(var)
        zs.append((closes[i]-basis[i])/sd if sd>0 else 0)
    sz = ema(zs, smooth)
    sz_arr = np.array(sz[-lookback:]) if len(sz)>=lookback else np.array(sz)
    upper = float(np.percentile(sz_arr, up_pct)) if len(sz_arr)>1 else 2.0
    lower = float(np.percentile(sz_arr, lo_pct)) if len(sz_arr)>1 else -2.0
    return sz[-1], upper, lower

# ===== 数据拉取 =====
def _sina_prefix(code):
    # 6 字头: sh，5 字头: sh，1/3 字头: sz (ETF 常见: 159xxx sz / 5xx/6xx sh)
    return ('sh' if code[0] in '56' else 'sz') + code

def _normalize(df_src, source):
    """把不同源的 dataframe 统一成: 股票名称/日期/开盘/最高/最低/收盘/成交额/成交量"""
    import pandas as pd
    if source == 'ef':
        return df_src  # efinance 已经是中文列
    # sina: date, open, high, low, close, volume, amount
    df = pd.DataFrame({
        '股票名称': '-',
        '日期':   df_src['date'].astype(str),
        '开盘':   df_src['open'].astype(float),
        '最高':   df_src['high'].astype(float),
        '最低':   df_src['low'].astype(float),
        '收盘':   df_src['close'].astype(float),
        '成交额': df_src['amount'].astype(float),
        '成交量': df_src['volume'].astype(float),
    })
    return df

def fetch(code, retries=2):
    import time, random
    end = datetime.datetime.now().strftime('%Y%m%d')
    beg = (datetime.datetime.now()-datetime.timedelta(days=500)).strftime('%Y%m%d')
    # 源 1: efinance (东财) —— 有中文名
    for attempt in range(retries):
        try:
            df = ef.stock.get_quote_history(code, beg=beg, end=end, klt=101, fqt=1)
            if df is not None and len(df) >= 60:
                return code, df
        except Exception:
            if attempt < retries-1:
                time.sleep(1.0 + random.random())
    # 源 2: akshare 新浪 —— 无中文名，但稳
    for attempt in range(retries):
        try:
            s = ak.fund_etf_hist_sina(symbol=_sina_prefix(code))
            if s is not None and len(s) >= 60:
                # 只保留近 500 天
                s = s.tail(500).reset_index(drop=True)
                return code, _normalize(s, 'sina')
        except Exception:
            if attempt < retries-1:
                time.sleep(1.0 + random.random())
    print(f'  {code} 全部源失败', file=sys.stderr)
    return code, None

def fill_names(rows):
    """批量补 ETF 中文名。优先新浪（稳定），东财兜底。"""
    if not rows: return
    need = [r for r in rows if r['name'] in ('-', '', None)]
    if not need: return
    m = {}
    # 源 1: 新浪 ETF 分类
    try:
        df = ak.fund_etf_category_sina(symbol='ETF基金')
        # 代码形如 sz159206 / sh512880，去掉前缀
        m = {str(c)[2:]: n for c, n in zip(df['代码'], df['名称'])}
    except Exception as e:
        print(f'  sina name lookup failed: {type(e).__name__}', file=sys.stderr)
    # 源 2: 东财补缺（若可用）
    missing_codes = [r['code'] for r in need if r['code'] not in m]
    if missing_codes:
        try:
            spot = ak.fund_etf_spot_em()
            m2 = dict(zip(spot['代码'].astype(str), spot['名称']))
            m.update({k: v for k, v in m2.items() if k not in m})
        except Exception:
            pass
    for r in need:
        r['name'] = m.get(r['code'], r['code'])

# ===== 信号合成 =====
def signals(df):
    closes = df['收盘'].astype(float).tolist()
    opens  = df['开盘'].astype(float).tolist()
    highs  = df['最高'].astype(float).tolist()
    lows   = df['最低'].astype(float).tolist()
    vols_yuan = df['成交额'].astype(float).tolist()
    vols_shares = df['成交量'].astype(float).tolist()
    last = closes[-1]; prev = closes[-2] if len(closes)>1 else last
    chg = (last-prev)/prev*100 if prev else 0

    # === 基础 4 条 ===
    e5  = ema(closes, 5)[-1]; e10 = ema(closes, 10)[-1]; e20 = ema(closes, 20)[-1]
    r   = rsi(closes, 14)
    v20 = sum(vols_yuan[-20:])/20 if len(vols_yuan)>=20 else sum(vols_yuan)/len(vols_yuan)
    v   = vols_yuan[-1]

    s1 = ('多','bull') if last>e20 else (('空','bear') if last<e20 else ('平','neutral'))
    s2 = ('多头','bull') if (e5>e10>e20) else (('空头','bear') if (e5<e10<e20) else ('混乱','neutral'))
    if r is None: s3=('-','neutral')
    elif r>70: s3=(f'超买 {r:.0f}','bear')
    elif r<30: s3=(f'超卖 {r:.0f}','bull')
    else: s3=(f'{r:.0f}','neutral')
    ratio = v/v20 if v20 else 1
    if ratio>1.5: s4=(f'放量 {ratio:.1f}x','bull')
    elif ratio<0.5: s4=(f'缩量 {ratio:.1f}x','bear')
    else: s4=(f'{ratio:.1f}x','neutral')

    # === Andean(50,9) ===
    bull, bear, sig = andean(closes, opens, 50, 9)
    if bull > bear and bull > sig:
        s5 = (f'多 {bull:.3f}', 'bull')
    elif bear > bull and bear > sig:
        s5 = (f'空 {bear:.3f}', 'bear')
    else:
        s5 = (f'观望', 'neutral')

    # === Volume Delta [hapharmonic] ===
    # 使用今日 bar: buyVol = V*(C-L)/(H-L)
    H=highs[-1]; L=lows[-1]; C=last; V=vols_shares[-1]
    if H>L and V>0:
        buyVol = V*(C-L)/(H-L)
        pcBuy  = buyVol/V*100
        if pcBuy > 55: s6 = (f'买 {pcBuy:.0f}%','bull')
        elif pcBuy < 45: s6 = (f'卖 {100-pcBuy:.0f}%','bear')
        else: s6 = (f'均衡 {pcBuy:.0f}%','neutral')
    else:
        s6 = ('-','neutral')

    # === DMH(10,2) ===
    d = dmh(highs, lows, 10)
    if d is None or math.isnan(d): s7=('-','neutral')
    elif d > 0: s7=(f'+{d:.3f}','bull')
    elif d < 0: s7=(f'{d:.3f}','bear')
    else: s7=('0','neutral')

    # === Adaptive Z-Score(20,EMA,3,Adaptive,252,85,15) ===
    z, up, lo = adaptive_zscore(closes, 20, 3, 252, 85, 15)
    if z is None: s8=('-','neutral')
    else:
        mid_u = up/2; mid_l = lo/2
        if z >= up:    s8=(f'强多 z={z:.2f}','bull')
        elif z >= mid_u: s8=(f'偏多 z={z:.2f}','bull')
        elif z <= lo:  s8=(f'强空 z={z:.2f}','bear')
        elif z <= mid_l: s8=(f'偏空 z={z:.2f}','bear')
        else: s8=(f'中性 z={z:.2f}','neutral')

    return {
        'name':  df['股票名称'].iloc[-1],
        'date':  df['日期'].iloc[-1],
        'close': last, 'chg_pct': chg,
        's1':s1,'s2':s2,'s3':s3,'s4':s4,'s5':s5,'s6':s6,'s7':s7,'s8':s8,
    }

def score(row):
    """初始合计分：多=1，其他=0（可在网页上动态调整勾选哪些指标）。"""
    return sum(1 for i in range(1, 9) if row[f's{i}'][1] == 'bull')

def compute_history(df, days=HIST_DAYS):
    """对 df 的最后 `days` 个交易日逐日计算信号快照。"""
    out = []
    n = len(df)
    start = max(20, n - days)  # 至少留 20 根预热
    for i in range(start, n):
        sub = df.iloc[:i+1]
        try:
            r = signals(sub); r['sc'] = score(r)
            out.append(r)
        except Exception:
            out.append(None)
    return out

# ===== HTML =====
HTML_TMPL = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>ETF 风控信号看板 — {date}</title>
<style>
  body {{ font-family: -apple-system, "Segoe UI", sans-serif; background:#0f1115; color:#e6e6e6; margin:0; padding:24px; }}
  h1 {{ margin:0 0 8px; font-size:20px; }}
  .meta {{ color:#888; font-size:13px; margin-bottom:16px; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 12px; background:#171a21; }}
  th, td {{ padding: 7px 8px; text-align: center; border-bottom:1px solid #252833; white-space:nowrap; }}
  th {{ background:#1f232d; position:sticky; top:0; font-weight:500; color:#bbb; font-size:11px; }}
  th .sub {{ display:block; font-weight:300; color:#666; font-size:10px; margin-top:2px; }}
  td.name {{ text-align:left; color:#ddd; }}
  td.code {{ font-family:monospace; color:#888; }}
  td.price {{ font-family:monospace; }}
  .bull    {{ background:#1e3a28; color:#4ade80; }}
  .bear    {{ background:#3a1e1e; color:#f87171; }}
  .neutral {{ background:#2a2d36; color:#9ca3af; }}
  .excluded {{ opacity:0.35; }}
  .up   {{ color:#f87171; }}
  .down {{ color:#4ade80; }}
  .sc {{ font-weight:bold; font-family:monospace; color:#f87171; }}
  tr:hover td {{ filter:brightness(1.15); }}
  .legend {{ margin-top: 16px; color:#888; font-size:12px; line-height:1.8; }}
  .legend b {{ color:#bbb; }}
  .sep {{ border-left:2px solid #333; }}
  .toggles {{ background:#1a1d25; border:1px solid #2a2d36; border-radius:6px; padding:10px 14px; margin-bottom:14px; font-size:12px; color:#bbb; display:flex; flex-wrap:wrap; gap:8px 18px; align-items:center; }}
  .toggles label {{ cursor:pointer; user-select:none; }}
  .toggles input {{ vertical-align:middle; margin-right:4px; }}
  .toggles button {{ background:#2a2d36; color:#ddd; border:1px solid #3a3d46; border-radius:4px; padding:3px 10px; font-size:11px; cursor:pointer; }}
  .toggles button:hover {{ background:#3a3d46; }}
  .toggles .hint {{ color:#666; margin-left:auto; }}
  th {{ cursor:pointer; user-select:none; }}
  th:hover {{ background:#282c38; }}
  th .arrow {{ display:inline-block; width:12px; color:#888; font-size:10px; margin-left:2px; }}
  th.sort-asc .arrow::before {{ content:'▲'; color:#4ade80; }}
  th.sort-desc .arrow::before {{ content:'▼'; color:#f87171; }}
</style></head><body>
<h1>40 只 ETF 风控信号看板</h1>
<div class="meta">数据日期：{date} ｜ 生成时间：{now} ｜ 共 {n} 只 ｜ 点击表头排序</div>

<div class="toggles">
  <span>加入合计：</span>
  <label><input type="checkbox" class="sigchk" data-col="4" checked>趋势</label>
  <label><input type="checkbox" class="sigchk" data-col="5" checked>均线排列</label>
  <label><input type="checkbox" class="sigchk" data-col="6" checked>RSI</label>
  <label><input type="checkbox" class="sigchk" data-col="7" checked>量能</label>
  <label><input type="checkbox" class="sigchk" data-col="8" checked>Andean</label>
  <label><input type="checkbox" class="sigchk" data-col="9" checked>Volume Δ</label>
  <label><input type="checkbox" class="sigchk" data-col="10" checked>DMH</label>
  <label><input type="checkbox" class="sigchk" data-col="11" checked>Z-Score</label>
  <button id="btn-all">全选</button>
  <button id="btn-none">全不选</button>
  <span class="hint">多=1，其他=0</span>
</div>

<div class="toggles" id="playbar">
  <button id="btn-prev">◀</button>
  <button id="btn-play">▶ 播放</button>
  <button id="btn-next">▶</button>
  <button id="btn-latest">跳到最新</button>
  <input id="slider" type="range" min="0" max="0" value="0" style="flex:1;min-width:200px;">
  <span id="date-label" style="font-family:monospace;color:#ddd;min-width:110px;text-align:center;"></span>
  <label style="margin-left:8px">速度
    <select id="speed" style="background:#2a2d36;color:#ddd;border:1px solid #3a3d46;padding:2px;">
      <option value="800">慢 (0.8s)</option>
      <option value="400" selected>中 (0.4s)</option>
      <option value="150">快 (0.15s)</option>
    </select>
  </label>
</div>

<table id="tbl">
<thead><tr>
  <th data-key="name">名称<span class="arrow"></span></th>
  <th data-key="code">代码<span class="arrow"></span></th>
  <th data-key="close" data-num="1">收盘<span class="arrow"></span></th>
  <th data-key="chg" data-num="1">涨跌<span class="arrow"></span></th>
  <th data-key="s1" data-num="1">趋势<span class="sub">vs EMA20</span><span class="arrow"></span></th>
  <th data-key="s2" data-num="1">均线排列<span class="sub">EMA 5/10/20</span><span class="arrow"></span></th>
  <th data-key="s3" data-num="1">RSI(14)<span class="arrow"></span></th>
  <th data-key="s4" data-num="1">量能<span class="sub">vs 20日均</span><span class="arrow"></span></th>
  <th class="sep" data-key="s5" data-num="1">Andean<span class="sub">(50, 9)</span><span class="arrow"></span></th>
  <th data-key="s6" data-num="1">Volume Δ<span class="sub">[hapharmonic]</span><span class="arrow"></span></th>
  <th data-key="s7" data-num="1">DMH<span class="sub">(10, 2)</span><span class="arrow"></span></th>
  <th data-key="s8" data-num="1">Z-Score<span class="sub">(20, EMA, 3, 85/15)</span><span class="arrow"></span></th>
  <th class="sep" data-key="sc" data-num="1">合计<span class="arrow"></span></th>
</tr></thead>
<tbody></tbody></table>
<div class="legend">
  <b>评分：</b>勾选要纳入合计的指标，合计 = 被勾选指标里信号为"多"的数量（多=1，空/中性=0）。<br>
  <b>信号状态编码：</b>多=1，中性=0，空=-1（用于排序）。<br>
  <b>基础 4 条：</b>
  趋势（收盘&gt;EMA20=多）｜均线排列（EMA5&gt;10&gt;20=多头）｜RSI（&gt;70 超买=空，&lt;30 超卖=多）｜量能（成交额/20日均，&gt;1.5x 放量=多，&lt;0.5x 缩量=空）。<br>
  <b>指标 4 条：</b>
  <b>Andean(50,9)</b>：bull &gt; bear 且 &gt; signal 为多；
  <b>Volume Delta</b>：Close/High/Low 估买量占比 &gt;55% 多，&lt;45% 空；
  <b>DMH(10,2)</b>：Ehlers 方向+Hann 滤波，&gt;0 多，&lt;0 空；
  <b>Adaptive Z-Score</b>：252 日 15/85 分位自适应阈值。
</div>

<script>
const __DATA__ = {data_json};
(function(){{
  const tbody = document.querySelector('#tbl tbody');
  const chks  = Array.from(document.querySelectorAll('.sigchk'));
  const ths   = Array.from(document.querySelectorAll('#tbl th'));
  const SC_IDX = ths.length - 1;

  const slider    = document.getElementById('slider');
  const dateLabel = document.getElementById('date-label');
  const speed     = document.getElementById('speed');
  const dates     = __DATA__.dates;
  const etfs      = __DATA__.etfs;
  slider.max = dates.length - 1;
  slider.value = dates.length - 1;

  // 构建骨架：一行一只 ETF
  etfs.forEach(etf=>{{
    const tr = document.createElement('tr');
    tr.dataset.code = etf.code;
    for (let i = 0; i < ths.length; i++){{
      tr.appendChild(document.createElement('td'));
    }}
    tr.cells[0].className = 'name';
    tr.cells[0].textContent = etf.name;
    tr.cells[1].className = 'code';
    tr.cells[1].textContent = etf.code;
    tr.cells[2].className = 'price';
    tr.cells[8].classList.add('sep');
    tr.cells[SC_IDX].classList.add('sc','sep');
    tbody.appendChild(tr);
  }});

  function renderDate(di){{
    const d = dates[di];
    dateLabel.textContent = d;
    Array.from(tbody.rows).forEach(tr=>{{
      const code = tr.dataset.code;
      const etf  = etfs.find(e=>e.code === code);
      const snap = etf && etf.byDate[d];
      if (!snap){{
        for (let i = 2; i < ths.length; i++){{
          tr.cells[i].className = tr.cells[i].className.replace(/\\b(bull|bear|neutral|up|down)\\b/g,'');
          tr.cells[i].textContent = '-';
          delete tr.cells[i].dataset.sig;
          delete tr.cells[i].dataset.num;
        }}
        tr.cells[8].classList.add('sep');
        tr.cells[SC_IDX].classList.add('sc','sep');
        continue;
      }}
      // 收盘
      tr.cells[2].textContent = snap.close.toFixed(3);
      tr.cells[2].dataset.num = snap.close;
      // 涨跌
      tr.cells[3].className = snap.chg > 0 ? 'up' : (snap.chg < 0 ? 'down' : '');
      tr.cells[3].textContent = (snap.chg>=0?'+':'') + snap.chg.toFixed(2) + '%';
      tr.cells[3].dataset.num = snap.chg;
      // 8 条信号
      for (let i = 0; i < 8; i++){{
        const [txt, cls, num] = snap.s[i];
        const cell = tr.cells[4+i];
        cell.className = cls + (i===4 ? ' sep' : '');
        cell.textContent = txt;
        cell.dataset.sig = cls;
        cell.dataset.num = num;
      }}
    }});
    recompute();
    if (sortKey) reSort();
  }}

  function recompute(){{
    const active = chks.filter(c=>c.checked).map(c=>+c.dataset.col);
    Array.from(tbody.rows).forEach(tr=>{{
      let s = 0;
      active.forEach(ci=>{{ if (tr.cells[ci] && tr.cells[ci].dataset.sig === 'bull') s++; }});
      const sc = tr.cells[SC_IDX];
      sc.textContent = s;
      sc.dataset.num = s;
    }});
    chks.forEach(c=>{{
      const ci = +c.dataset.col;
      Array.from(tbody.rows).forEach(tr=>{{
        if (tr.cells[ci]) tr.cells[ci].classList.toggle('excluded', !c.checked);
      }});
      if (ths[ci]) ths[ci].classList.toggle('excluded', !c.checked);
    }});
  }}

  let sortKey = null, sortDir = 0, sortIdx = -1;
  function reSort(){{
    if (sortIdx < 0) return;
    const isNum = ths[sortIdx].dataset.num === '1';
    const dir = sortDir;
    const rows = Array.from(tbody.rows);
    rows.sort((a,b)=>{{
      const ca = a.cells[sortIdx], cb = b.cells[sortIdx];
      let va, vb;
      if (isNum && ca.dataset.num !== undefined){{
        va = parseFloat(ca.dataset.num); vb = parseFloat(cb.dataset.num);
        if (isNaN(va)) va = -Infinity; if (isNaN(vb)) vb = -Infinity;
      }} else {{
        return dir * (ca.textContent||'').localeCompare(cb.textContent||'', 'zh');
      }}
      return dir * (va < vb ? -1 : va > vb ? 1 : 0);
    }});
    rows.forEach(r=>tbody.appendChild(r));
  }}
  function sortBy(th){{
    const idx = ths.indexOf(th);
    const key = th.dataset.key;
    const dir = (sortKey === key && sortDir === -1) ? 1 : -1;
    sortKey = key; sortDir = dir; sortIdx = idx;
    reSort();
    ths.forEach(t=>t.classList.remove('sort-asc','sort-desc'));
    th.classList.add(dir === 1 ? 'sort-asc' : 'sort-desc');
  }}

  ths.forEach(th=>th.addEventListener('click', ()=>sortBy(th)));
  chks.forEach(c=>c.addEventListener('change', recompute));
  document.getElementById('btn-all').onclick  = ()=>{{chks.forEach(c=>c.checked=true);  recompute();}};
  document.getElementById('btn-none').onclick = ()=>{{chks.forEach(c=>c.checked=false); recompute();}};

  // 播放控制
  let playing = false, timer = null;
  function setIdx(i){{
    i = Math.max(0, Math.min(dates.length-1, i));
    slider.value = i;
    renderDate(i);
  }}
  slider.addEventListener('input', e=>renderDate(+e.target.value));
  document.getElementById('btn-prev').onclick   = ()=>setIdx(+slider.value - 1);
  document.getElementById('btn-next').onclick   = ()=>setIdx(+slider.value + 1);
  document.getElementById('btn-latest').onclick = ()=>setIdx(dates.length - 1);
  const playBtn = document.getElementById('btn-play');
  playBtn.onclick = ()=>{{
    if (playing){{
      clearInterval(timer); timer = null; playing = false;
      playBtn.textContent = '▶ 播放';
    }} else {{
      playing = true;
      playBtn.textContent = '⏸ 暂停';
      timer = setInterval(()=>{{
        const v = +slider.value;
        if (v >= dates.length - 1){{ setIdx(0); return; }}
        setIdx(v + 1);
      }}, +speed.value);
    }}
  }};
  speed.addEventListener('change', ()=>{{
    if (playing){{ clearInterval(timer); timer = setInterval(()=>{{
      const v = +slider.value;
      if (v >= dates.length - 1){{ setIdx(0); return; }}
      setIdx(v + 1);
    }}, +speed.value); }}
  }});

  // 初始
  renderDate(dates.length - 1);
  sortBy(ths[SC_IDX]);
}})();
</script>
</body></html>"""

ROW_TMPL = ('<tr>'
            '<td class="name">{name}</td>'
            '<td class="code">{code}</td>'
            '<td class="price" data-num="{close}">{close:.3f}</td>'
            '<td class="{chg_cls}" data-num="{chg_pct}">{chg_pct:+.2f}%</td>'
            '<td class="{c1}" data-sig="{c1}" data-num="{n1}">{t1}</td>'
            '<td class="{c2}" data-sig="{c2}" data-num="{n2}">{t2}</td>'
            '<td class="{c3}" data-sig="{c3}" data-num="{n3}">{t3}</td>'
            '<td class="{c4}" data-sig="{c4}" data-num="{n4}">{t4}</td>'
            '<td class="{c5} sep" data-sig="{c5}" data-num="{n5}">{t5}</td>'
            '<td class="{c6}" data-sig="{c6}" data-num="{n6}">{t6}</td>'
            '<td class="{c7}" data-sig="{c7}" data-num="{n7}">{t7}</td>'
            '<td class="{c8}" data-sig="{c8}" data-num="{n8}">{t8}</td>'
            '<td class="sc sep" data-num="{sc}">{sc}</td>'
            '</tr>')

def main():
    with open(RULES, encoding='utf-8') as f:
        wl = json.load(f)['watchlist']
    print(f'拉取 {len(wl)} 只 ETF (500 天)...')
    results = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        for fut in as_completed([ex.submit(fetch, c) for c in wl]):
            code, df = fut.result()
            if df is not None: results[code] = df
    print(f'成功 {len(results)}/{len(wl)}')

    # 计算每只 ETF 的历史快照
    sig_num = {'bull': 1, 'neutral': 0, 'bear': -1}
    etfs_payload = []
    latest_rows = []  # 用于 fill_names
    all_dates = set()
    print(f'计算历史快照 ({HIST_DAYS} 天)...')
    for code in wl:
        if code not in results: continue
        try:
            hist = compute_history(results[code], HIST_DAYS)
        except Exception as e:
            print(f'  {code} history err: {e}', file=sys.stderr); continue
        by_date = {}
        name = code
        for r in hist:
            if r is None: continue
            d = str(r['date'])[:10]
            all_dates.add(d)
            s_list = []
            for i in range(1, 9):
                cls = r[f's{i}'][1]
                s_list.append([r[f's{i}'][0], cls, sig_num[cls]])
            by_date[d] = {
                'close': round(float(r['close']), 4),
                'chg':   round(float(r['chg_pct']), 3),
                's':     s_list,
            }
            name = r['name']
        # 最新一日用于 fill_names
        if hist and hist[-1] is not None:
            latest_rows.append({'code': code, 'name': hist[-1]['name']})
        etfs_payload.append({'code': code, 'name': name, 'byDate': by_date})

    fill_names(latest_rows)
    name_map = {r['code']: r['name'] for r in latest_rows}
    for e in etfs_payload:
        if e['code'] in name_map: e['name'] = name_map[e['code']]

    sorted_dates = sorted(all_dates)[-HIST_DAYS:]
    date = sorted_dates[-1] if sorted_dates else '-'

    import json as _json
    data_json = _json.dumps({'dates': sorted_dates, 'etfs': etfs_payload}, ensure_ascii=False)

    html = HTML_TMPL.format(
        date=date,
        now=datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
        n=len(etfs_payload),
        data_json=data_json,
    )
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'OK -> {OUT}  ({len(etfs_payload)} ETFs × {len(sorted_dates)} 天)')

if __name__ == '__main__':
    main()
