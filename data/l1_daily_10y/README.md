# Daily L1 (top-of-book) dataset

Range requested: `10y`  ·  source: Yahoo Finance daily bars  ·  one row per symbol per trading day.

## REAL columns (market data)

`open` `high` `low` `close` `volume` — Yahoo Finance daily OHLCV.

## MODELED columns (NOT market data — assumptions)

`mid`=close. `bid`/`ask`=mid ∓ spread/2. `spread`= 1 tick (futures) or a nominal
bps of price (ETFs). `bid_size`/`ask_size` ≈ 5% of an average minute's volume.
These are a synthetic top-of-book *shape*, not real quotes. A real bid/ask/depth
cannot be recovered from OHLC — use a quote vendor (Databento bbo-1m, Polygon/Massive
quotes) for that.

## Per-symbol spread model

| symbol | kind | rows | first | last | spread model |
|--------|------|-----:|-------|------|--------------|
| ES | future | 2516 | 2016-06-13 | 2026-06-12 | 1tick=0.25 |
| NKD | future | 2516 | 2016-06-13 | 2026-06-12 | 1tick=5.0 |
| NQ | future | 2516 | 2016-06-13 | 2026-06-12 | 1tick=0.25 |
| YM | future | 2516 | 2016-06-13 | 2026-06-12 | 1tick=1.0 |
| RTY | future | 2248 | 2017-07-10 | 2026-06-12 | 1tick=0.1 |
| SPY | etf | 2515 | 2016-06-13 | 2026-06-12 | 0.5bps |
| EWJ | etf | 2515 | 2016-06-13 | 2026-06-12 | 2.0bps |
| EWH | etf | 2515 | 2016-06-13 | 2026-06-12 | 5.0bps |
| EWY | etf | 2515 | 2016-06-13 | 2026-06-12 | 3.0bps |
| FEZ | etf | 2515 | 2016-06-13 | 2026-06-12 | 3.0bps |
| NIKKEI | index | 2443 | 2016-06-13 | 2026-06-12 | 1.0bps |
| HSI | index | 2460 | 2016-06-13 | 2026-06-12 | 1.0bps |
| KOSPI | index | 2449 | 2016-06-13 | 2026-06-12 | 1.0bps |
| STOXX50 | index | 2512 | 2016-06-13 | 2026-06-12 | 1.0bps |
