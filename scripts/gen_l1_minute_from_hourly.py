#!/usr/bin/env python3
"""Synthetic MINUTE L1 dataset, interpolated from REAL hourly Yahoo bars.

Why this shape:
  - Yahoo serves real `60m` (hourly) bars for ~2 years only -> the minute set
    spans ~2y (the 10y file stays DAILY).
  - Each real hourly bar (open/high/low/close/volume) is expanded into up to 60
    one-minute bars via a Brownian-bridge path that is CONSTRUCTED to:
        * start at the hour's open, end at the hour's close (exact),
        * touch the hour's high and low (exact),
        * never trade outside [low, high]  (clamped),
        * split the hour's volume across the minutes (sums back, ± rounding).
    => downsampling these minutes back to 60m reproduces the real hourly bar.

What is REAL vs INVENTED:
  REAL    : the hourly envelope (O/H/L/C/V per hour) from Yahoo.
  INVENTED: the intra-hour *path* (which minute hit what) and the modeled
            top-of-book (bid/ask/sizes). Do NOT read microstructure / queue /
            spread-capture results off this — the minute ordering is simulated.
            For real minute quotes use Databento bbo-1m or Polygon/Massive.

Deterministic: per-symbol seeded RNG, so re-runs are identical.

Usage:  python3 scripts/gen_l1_minute_from_hourly.py [--range 2y]
Output: data/l1_minute_2y/<SYM>.parquet, README.md
"""
import argparse
import json
import os
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "l1_minute_2y")

# symbol -> (yahoo ticker, kind, spread spec) — same model as the daily script.
SYMBOLS = {
    "ES":  ("ES=F",  "future", ("tick", 0.25)),
    "NKD": ("NKD=F", "future", ("tick", 5.0)),
    "NQ":  ("NQ=F",  "future", ("tick", 0.25)),
    "YM":  ("YM=F",  "future", ("tick", 1.0)),
    "RTY": ("RTY=F", "future", ("tick", 0.10)),
    "SPY": ("SPY",   "etf",    ("bps", 0.5)),
    "EWJ": ("EWJ",   "etf",    ("bps", 2.0)),
    "EWH": ("EWH",   "etf",    ("bps", 5.0)),
    "EWY": ("EWY",   "etf",    ("bps", 3.0)),
    "FEZ": ("FEZ",   "etf",    ("bps", 3.0)),
    # Cash indices — display-only / NOT tradeable; L1 is notional, for completeness.
    "NIKKEI":  ("^N225",     "index", ("bps", 1.0)),
    "HSI":     ("^HSI",      "index", ("bps", 1.0)),
    "KOSPI":   ("^KS11",     "index", ("bps", 1.0)),
    "STOXX50": ("^STOXX50E", "index", ("bps", 1.0)),
}

COLS = [
    "symbol", "kind", "ts", "datetime",
    "open", "high", "low", "close", "volume",      # synthetic minute OHLCV (aggregates to real hour)
    "mid", "bid", "ask", "spread", "bid_size", "ask_size", "spread_model",  # modeled L1
]


def fetch_hourly(yahoo: str, rng: str) -> pd.DataFrame:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(yahoo)}?range={rng}&interval=60m"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.load(r)
    res = d["chart"]["result"][0]
    ts = np.array(res["timestamp"], dtype="int64") * 1000  # epoch ms
    q = res["indicators"]["quote"][0]
    o = np.array([np.nan if v is None else v for v in q["open"]], dtype=float)
    h = np.array([np.nan if v is None else v for v in q["high"]], dtype=float)
    low = np.array([np.nan if v is None else v for v in q["low"]], dtype=float)
    c = np.array([np.nan if v is None else v for v in q["close"]], dtype=float)
    v = np.array([0 if x is None else x for x in q["volume"]], dtype=float)
    keep = ~np.isnan(c)
    ts, o, h, low, c, v = ts[keep], o[keep], h[keep], low[keep], c[keep], v[keep]
    # backfill missing o/h/l from close
    o = np.where(np.isnan(o), c, o)
    h = np.where(np.isnan(h), np.maximum(o, c), h)
    low = np.where(np.isnan(low), np.minimum(o, c), low)
    # guard: ensure h>=max(o,c), l<=min(o,c)
    h = np.maximum.reduce([h, o, c])
    low = np.minimum.reduce([low, o, c])
    return pd.DataFrame({"ts": ts, "open": o, "high": h, "low": low, "close": c, "volume": v})


def bridge_segment(pa: float, pb: float, seg: int, amp: float, rng) -> np.ndarray:
    """Brownian bridge prices for indices 1..seg, ending exactly at pb."""
    if seg <= 0:
        return np.array([])
    w = np.cumsum(rng.standard_normal(seg))
    w = w - (np.arange(1, seg + 1) / seg) * w[-1]          # pin end to 0
    lin = pa + (pb - pa) * (np.arange(1, seg + 1) / seg)
    out = lin + w * amp
    out[-1] = pb
    return out


def interp_bar(O, H, L, C, n, rng) -> np.ndarray:
    """Return n+1 prices p[0..n]: p[0]=O, p[n]=C, touches H&L, all within [L,H]."""
    if n <= 1:
        return np.array([O, C])
    i1, i2 = sorted(rng.choice(np.arange(1, n), size=2, replace=False))
    if i1 == i2:
        i2 = min(n - 1, i1 + 1)
    e1, e2 = (H, L) if rng.random() < 0.5 else (L, H)
    anchors = [(0, O), (int(i1), e1), (int(i2), e2), (n, C)]
    p = np.empty(n + 1)
    p[0] = O
    amp = (H - L) / max(1.0, np.sqrt(n)) * 0.5
    for (ia, pa), (ib, pb) in zip(anchors[:-1], anchors[1:]):
        seg = ib - ia
        if seg <= 0:
            p[ib] = pb
            continue
        p[ia + 1:ib + 1] = bridge_segment(pa, pb, seg, amp, rng)
    np.clip(p, L, H, out=p)
    p[0], p[int(i1)], p[int(i2)], p[n] = O, e1, e2, C
    return p


def model_l1(df: pd.DataFrame, spec) -> pd.DataFrame:
    kind, val = spec
    mid = df["close"].astype(float)
    if kind == "tick":
        spread = pd.Series(float(val), index=df.index)
        model = f"1tick={val}"
    else:
        spread = mid * (val / 1e4)
        model = f"{val}bps"
    df["mid"] = mid
    df["bid"] = mid - spread / 2.0
    df["ask"] = mid + spread / 2.0
    df["spread"] = spread
    top = np.maximum(1, np.round(df["volume"].astype(float) * 0.05)).astype("int64")
    df["bid_size"] = top
    df["ask_size"] = top
    df["spread_model"] = model
    return df


def build_symbol(sym, yahoo, kind, spec, rng_seed, rngrange):
    bars = fetch_hourly(yahoo, rngrange)
    ts = bars["ts"].to_numpy()
    O, H, L, C, V = (bars[k].to_numpy() for k in ("open", "high", "low", "close", "volume"))
    rng = np.random.default_rng(rng_seed)
    nbars = len(bars)
    m_ts, m_o, m_h, m_l, m_c, m_v = [], [], [], [], [], []
    for i in range(nbars):
        if i < nbars - 1:
            gap_min = int(round((ts[i + 1] - ts[i]) / 60000.0))
            n = max(1, min(60, gap_min))
        else:
            n = 60
        p = interp_bar(O[i], H[i], L[i], C[i], n, rng)  # len n+1
        opens = p[:-1]
        closes = p[1:]
        highs = np.minimum(H[i], np.maximum(opens, closes))
        lows = np.maximum(L[i], np.minimum(opens, closes))
        # split volume across the n minutes (weights sum to V, ± rounding)
        wv = rng.random(n) + 0.5
        wv /= wv.sum()
        vol = np.maximum(0, np.round(V[i] * wv)).astype("int64")
        tmin = ts[i] + np.arange(n, dtype="int64") * 60000
        m_ts.append(tmin); m_o.append(opens); m_h.append(highs)
        m_l.append(lows); m_c.append(closes); m_v.append(vol)
    df = pd.DataFrame({
        "ts": np.concatenate(m_ts),
        "open": np.concatenate(m_o), "high": np.concatenate(m_h),
        "low": np.concatenate(m_l), "close": np.concatenate(m_c),
        "volume": np.concatenate(m_v),
    })
    df["datetime"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = model_l1(df, spec)
    df.insert(0, "kind", kind)
    df.insert(0, "symbol", sym)
    return df[COLS], len(bars)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--range", default="2y")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    summary = []
    for seed, (sym, (yahoo, kind, spec)) in enumerate(SYMBOLS.items()):
        try:
            df, nhours = build_symbol(sym, yahoo, kind, spec, 1000 + seed, args.range)
        except Exception as e:  # noqa: BLE001
            print(f"  {sym:4} FAIL  {e}")
            continue
        path = os.path.join(OUT, f"{sym}.parquet")
        df.to_parquet(path, index=False, engine="pyarrow", compression="zstd")
        first = df["datetime"].iloc[0].strftime("%Y-%m-%d")
        last = df["datetime"].iloc[-1].strftime("%Y-%m-%d")
        mb = os.path.getsize(path) / 1e6
        summary.append((sym, kind, nhours, len(df), first, last, mb))
        print(f"  {sym:4} {kind:6} {nhours:6} hrs -> {len(df):8} min  {first}..{last}  {mb:5.1f}MB")

    lines = [
        "# Synthetic MINUTE L1 (interpolated from real hourly)\n",
        f"Range: `{args.range}` of real Yahoo `60m` bars, each expanded to <=60 one-minute bars.\n",
        "## Construction\n",
        "Each REAL hourly bar (O/H/L/C/V) -> Brownian-bridge minute path that starts at the",
        "hour open, ends at the hour close, touches the hour high & low, stays within [low,high],",
        "and splits the hour volume. Downsampling the minutes back to 60m reproduces the real bar.\n",
        "## REAL vs INVENTED\n",
        "REAL: the hourly envelope. INVENTED: the intra-hour path (which minute hit what) and the",
        "modeled top-of-book (mid=close, bid/ask=mid ∓ spread/2, sizes ≈ 5% of minute volume).",
        "Not usable for microstructure/queue/spread-capture analysis — use Databento bbo-1m or",
        "Polygon/Massive quotes for real minute book data.\n",
        "## Per-symbol\n",
        "| symbol | kind | hours | minutes | first | last | file MB |",
        "|--------|------|------:|--------:|-------|------|--------:|",
    ]
    for sym, kind, nh, nm, first, last, mb in summary:
        lines.append(f"| {sym} | {kind} | {nh} | {nm} | {first} | {last} | {mb:.1f} |")
    lines.append("")
    with open(os.path.join(OUT, "README.md"), "w") as f:
        f.write("\n".join(lines))
    print(f"\nwrote {len(summary)} symbols -> {OUT}")


if __name__ == "__main__":
    main()
