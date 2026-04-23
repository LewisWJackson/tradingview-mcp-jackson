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
import numpy as np

HERE  = os.path.dirname(os.path.abspath(__file__))
RULES = os.path.join(HERE, 'rules.json')
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
def fetch(code):
    end = datetime.datetime.now().strftime('%Y%m%d')
    # 500 天：覆盖 Adaptive Z-Score 的 252 交易日分位 + 20 日基期 + 缓冲
    beg = (datetime.datetime.now()-datetime.timedelta(days=500)).strftime('%Y%m%d')
    try:
        df = ef.stock.get_quote_history(code, beg=beg, end=end, klt=101, fqt=1)
        if df is None or len(df) < 60: return code, None
        return code, df
    except Exception as e:
        print(f'  {code} err: {e}', file=sys.stderr)
        return code, None

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
    m = {'bull':1, 'bear':-1, 'neutral':0}
    return sum(m[row[f's{i}'][1]] for i in range(1, 9))

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
  .up   {{ color:#f87171; }}   /* A 股: 红涨 */
  .down {{ color:#4ade80; }}   /* 绿跌 */
  .score-pos {{ color:#f87171; font-weight:bold; }}
  .score-neg {{ color:#4ade80; font-weight:bold; }}
  .score-neu {{ color:#9ca3af; }}
  tr:hover td {{ filter:brightness(1.15); }}
  .legend {{ margin-top: 16px; color:#888; font-size:12px; line-height:1.8; }}
  .legend b {{ color:#bbb; }}
  .sep {{ border-left:2px solid #333; }}
</style></head><body>
<h1>40 只 ETF 风控信号看板</h1>
<div class="meta">数据日期：{date} ｜ 生成时间：{now} ｜ 共 {n} 只 ｜ 按合计分降序</div>
<table>
<thead><tr>
  <th>名称</th><th>代码</th><th>收盘</th><th>涨跌</th>
  <th>趋势<span class="sub">vs EMA20</span></th>
  <th>均线排列<span class="sub">EMA 5/10/20</span></th>
  <th>RSI(14)</th>
  <th>量能<span class="sub">vs 20日均</span></th>
  <th class="sep">Andean<span class="sub">(50, 9)</span></th>
  <th>Volume Δ<span class="sub">[hapharmonic]</span></th>
  <th>DMH<span class="sub">(10, 2)</span></th>
  <th>Z-Score<span class="sub">(20, EMA, 3, 85/15)</span></th>
  <th class="sep">合计</th>
</tr></thead>
<tbody>
{rows}
</tbody></table>
<div class="legend">
  <b>评分：</b>每条信号 多头+1 / 空头-1 / 中性0，共 8 条，合计范围 -8 ~ +8。<br>
  <b>基础 4 条：</b>
  趋势（收盘&gt;EMA20=多）｜
  均线排列（EMA5&gt;10&gt;20=多头）｜
  RSI（&gt;70 超买=空信号，&lt;30 超卖=多信号）｜
  量能（今日成交额/20日均额，&gt;1.5x 放量=多，&lt;0.5x 缩量=空）。<br>
  <b>指标 4 条：</b>
  <b>Andean(50,9)</b>：bull &gt; bear 且 &gt; signal 为多，反之为空，否则观望；
  <b>Volume Delta</b>：按 Close/High/Low 估算买量占比，&gt;55% 多，&lt;45% 空；
  <b>DMH(10,2)</b>：Ehlers 方向运动 + Hann 滤波，&gt;0 多，&lt;0 空；
  <b>Adaptive Z-Score</b>：EMA(20) 为基期，Z 平滑 EMA(3)，以 252 日 15/85 分位自适应阈值，&gt;上阈值=强多，&gt;中位=偏多，反向同理。
</div>
</body></html>"""

ROW_TMPL = ('<tr><td class="name">{name}</td><td class="code">{code}</td>'
            '<td class="price">{close:.3f}</td><td class="{chg_cls}">{chg_pct:+.2f}%</td>'
            '<td class="{c1}">{t1}</td><td class="{c2}">{t2}</td>'
            '<td class="{c3}">{t3}</td><td class="{c4}">{t4}</td>'
            '<td class="{c5} sep">{t5}</td><td class="{c6}">{t6}</td>'
            '<td class="{c7}">{t7}</td><td class="{c8}">{t8}</td>'
            '<td class="{sc_cls} sep">{sc:+d}</td></tr>')

def main():
    with open(RULES, encoding='utf-8') as f:
        wl = json.load(f)['watchlist']
    print(f'拉取 {len(wl)} 只 ETF (500 天)...')
    results = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        for fut in as_completed([ex.submit(fetch, c) for c in wl]):
            code, df = fut.result()
            if df is not None: results[code] = df
    print(f'成功 {len(results)}/{len(wl)}')

    rows_data = []
    for code in wl:
        if code not in results: continue
        try:
            r = signals(results[code]); r['code']=code; r['sc']=score(r)
            rows_data.append(r)
        except Exception as e:
            print(f'  {code} signals err: {e}', file=sys.stderr)
    rows_data.sort(key=lambda r: -r['sc'])

    html_rows = []
    for r in rows_data:
        sc = r['sc']
        sc_cls = 'score-pos' if sc>0 else ('score-neg' if sc<0 else 'score-neu')
        chg_cls = 'up' if r['chg_pct']>0 else ('down' if r['chg_pct']<0 else '')
        kv = {f'c{i}': r[f's{i}'][1] for i in range(1,9)}
        kv.update({f't{i}': r[f's{i}'][0] for i in range(1,9)})
        html_rows.append(ROW_TMPL.format(
            name=r['name'], code=r['code'], close=r['close'],
            chg_cls=chg_cls, chg_pct=r['chg_pct'],
            sc_cls=sc_cls, sc=sc, **kv,
        ))

    date = str(rows_data[0]['date']) if rows_data else '-'
    html = HTML_TMPL.format(
        date=date,
        now=datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
        n=len(rows_data),
        rows='\n'.join(html_rows),
    )
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'OK -> {OUT}')

if __name__ == '__main__':
    main()
