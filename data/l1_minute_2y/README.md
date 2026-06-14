# Synthetic MINUTE L1 (interpolated from real hourly)

Range: `2y` of real Yahoo `60m` bars, each expanded to <=60 one-minute bars.

## Construction

Each REAL hourly bar (O/H/L/C/V) -> Brownian-bridge minute path that starts at the
hour open, ends at the hour close, touches the hour high & low, stays within [low,high],
and splits the hour volume. Downsampling the minutes back to 60m reproduces the real bar.

## REAL vs INVENTED

REAL: the hourly envelope. INVENTED: the intra-hour path (which minute hit what) and the
modeled top-of-book (mid=close, bid/ask=mid ∓ spread/2, sizes ≈ 5% of minute volume).
Not usable for microstructure/queue/spread-capture analysis — use Databento bbo-1m or
Polygon/Massive quotes for real minute book data.

## Per-symbol

| symbol | kind | hours | minutes | first | last | file MB |
|--------|------|------:|--------:|-------|------|--------:|
| ES | future | 11397 | 683640 | 2024-06-13 | 2026-06-12 | 36.6 |
| NKD | future | 11282 | 676739 | 2024-06-13 | 2026-06-12 | 34.2 |
| NQ | future | 11395 | 683520 | 2024-06-13 | 2026-06-12 | 36.5 |
| YM | future | 11390 | 683220 | 2024-06-13 | 2026-06-12 | 35.4 |
| RTY | future | 11421 | 685080 | 2024-06-13 | 2026-06-12 | 35.7 |
| SPY | etf | 3480 | 208770 | 2024-06-13 | 2026-06-12 | 16.0 |
| EWJ | etf | 3480 | 208770 | 2024-06-13 | 2026-06-12 | 15.3 |
| EWH | etf | 3480 | 208770 | 2024-06-13 | 2026-06-12 | 15.2 |
| EWY | etf | 3480 | 208770 | 2024-06-13 | 2026-06-12 | 15.6 |
| FEZ | etf | 3480 | 208770 | 2024-06-13 | 2026-06-12 | 15.2 |
| NIKKEI | index | 3389 | 203310 | 2024-06-13 | 2026-06-12 | 14.1 |
| HSI | index | 3404 | 204240 | 2024-06-13 | 2026-06-12 | 14.2 |
| KOSPI | index | 2900 | 174000 | 2024-06-13 | 2026-06-12 | 13.2 |
| STOXX50 | index | 4471 | 268230 | 2024-06-13 | 2026-06-12 | 17.4 |
