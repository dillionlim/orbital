#!/usr/bin/env python3
"""Generate a ~10-year DAILY L1 (top-of-book) dataset for the dashboard's
tradeable symbols, as Parquet.

Provenance / honesty:
  REAL    columns  : open/high/low/close/volume  -> Yahoo Finance daily bars
                     (the same source backend/src/index-prices uses).
  MODELED columns  : mid/bid/ask/spread/bid_size/ask_size
                       mid    = close
                       spread = 1 tick (futures) or a nominal bps (ETFs)  [ASSUMPTION]
                       sizes  = crude function of daily volume            [ASSUMPTION]

You CANNOT recover a real bid/ask or order-book depth from OHLC. The modeled
columns only give the backtester a top-of-book *shape* to consume. For REAL
top-of-book history use a quote vendor (Databento bbo-1m, or Polygon/Massive
futures + stocks quotes).

Usage:  python3 scripts/gen_l1_parquet.py [--range 10y]
Output: data/l1_daily_10y/<SYM>.parquet, _ALL.parquet, README.md
"""
import argparse
import json
import os
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "l1_daily_10y")

# symbol -> (yahoo ticker, kind, spread spec)
#   futures spread spec: ("tick", tick_size_in_index_points)  -> 1-tick wide book
#   etf     spread spec: ("bps",  nominal_spread_bps)         -> bps of price
SYMBOLS = {
    "ES":  ("ES=F",  "future", ("tick", 0.25)),  # S&P 500 e-mini
    "NKD": ("NKD=F", "future", ("tick", 5.0)),   # Nikkei 225 (USD)
    "NQ":  ("NQ=F",  "future", ("tick", 0.25)),  # Nasdaq-100 e-mini
    "YM":  ("YM=F",  "future", ("tick", 1.0)),   # Dow e-mini
    "RTY": ("RTY=F", "future", ("tick", 0.10)),  # Russell 2000 e-mini
    "SPY": ("SPY",   "etf",    ("bps", 0.5)),    # S&P 500 ETF (very tight)
    "EWJ": ("EWJ",   "etf",    ("bps", 2.0)),    # Japan ETF
    "EWH": ("EWH",   "etf",    ("bps", 5.0)),    # Hong Kong ETF
    "EWY": ("EWY",   "etf",    ("bps", 3.0)),    # Korea ETF
    "FEZ": ("FEZ",   "etf",    ("bps", 3.0)),    # Euro Stoxx 50 ETF
    # Cash indices — display-only / NOT order-book-tradeable. The L1 below is
    # purely notional (a bps spread on an index level), included for completeness.
    "NIKKEI":  ("^N225",     "index", ("bps", 1.0)),  # Nikkei 225
    "HSI":     ("^HSI",      "index", ("bps", 1.0)),  # Hang Seng
    "KOSPI":   ("^KS11",     "index", ("bps", 1.0)),  # KOSPI
    "STOXX50": ("^STOXX50E", "index", ("bps", 1.0)),  # Euro Stoxx 50
}


def fetch_daily(yahoo: str, rng: str) -> pd.DataFrame:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(yahoo)}?range={rng}&interval=1d"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.load(r)
    res = d["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    df = pd.DataFrame(
        {
            "ts": [int(t) * 1000 for t in ts],  # epoch ms
            "open": q["open"],
            "high": q["high"],
            "low": q["low"],
            "close": q["close"],
            "volume": q["volume"],
        }
    )
    df = df.dropna(subset=["close"]).reset_index(drop=True)
    df["date"] = pd.to_datetime(df["ts"], unit="ms", utc=True).dt.date
    return df


def model_l1(df: pd.DataFrame, spec) -> pd.DataFrame:
    kind, val = spec
    mid = df["close"].astype(float)
    if kind == "tick":
        spread = pd.Series(float(val), index=df.index)
        model = f"1tick={val}"
    else:  # bps of price
        spread = mid * (val / 1e4)
        model = f"{val}bps"
    df["mid"] = mid
    df["bid"] = mid - spread / 2.0
    df["ask"] = mid + spread / 2.0
    df["spread"] = spread
    # Crude synthetic top-of-book size: ~5% of an average minute's volume.
    vol = df["volume"].fillna(0).astype(float)
    top = np.maximum(1, np.round(vol / 390.0 * 0.05)).astype("int64")
    df["bid_size"] = top
    df["ask_size"] = top
    df["spread_model"] = model
    return df


COLS = [
    "symbol", "kind", "ts", "date",
    "open", "high", "low", "close", "volume",   # REAL
    "mid", "bid", "ask", "spread", "bid_size", "ask_size", "spread_model",  # MODELED
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--range", default="10y")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    frames = []
    summary = []
    for sym, (yahoo, kind, spec) in SYMBOLS.items():
        try:
            df = fetch_daily(yahoo, args.range)
        except Exception as e:  # noqa: BLE001
            print(f"  {sym:4} FAIL  {e}")
            continue
        df = model_l1(df, spec)
        df.insert(0, "kind", kind)
        df.insert(0, "symbol", sym)
        df = df[COLS]
        path = os.path.join(OUT, f"{sym}.parquet")
        df.to_parquet(path, index=False, engine="pyarrow", compression="zstd")
        frames.append(df)
        first, last = df["date"].iloc[0], df["date"].iloc[-1]
        summary.append((sym, kind, len(df), str(first), str(last), df["spread_model"].iloc[0]))
        print(f"  {sym:4} {kind:6} {len(df):5} rows  {first} -> {last}  ({df['spread_model'].iloc[0]})")

    allp = os.path.join(OUT, "_ALL.parquet")
    combined = pd.concat(frames, ignore_index=True)
    combined.to_parquet(allp, index=False, engine="pyarrow", compression="zstd")
    print(f"\ncombined: {len(combined)} rows -> {allp}")

    # README documenting provenance + the real/modeled split.
    lines = [
        "# Daily L1 (top-of-book) dataset\n",
        f"Range requested: `{args.range}`  ·  source: Yahoo Finance daily bars  ·  one row per symbol per trading day.\n",
        "## REAL columns (market data)\n",
        "`open` `high` `low` `close` `volume` — Yahoo Finance daily OHLCV.\n",
        "## MODELED columns (NOT market data — assumptions)\n",
        "`mid`=close. `bid`/`ask`=mid ∓ spread/2. `spread`= 1 tick (futures) or a nominal",
        "bps of price (ETFs). `bid_size`/`ask_size` ≈ 5% of an average minute's volume.",
        "These are a synthetic top-of-book *shape*, not real quotes. A real bid/ask/depth",
        "cannot be recovered from OHLC — use a quote vendor (Databento bbo-1m, Polygon/Massive",
        "quotes) for that.\n",
        "## Per-symbol spread model\n",
        "| symbol | kind | rows | first | last | spread model |",
        "|--------|------|-----:|-------|------|--------------|",
    ]
    for sym, kind, n, first, last, model in summary:
        lines.append(f"| {sym} | {kind} | {n} | {first} | {last} | {model} |")
    lines.append("")
    with open(os.path.join(OUT, "README.md"), "w") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    main()
