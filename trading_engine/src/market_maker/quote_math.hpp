#pragma once
#include <algorithm>
#include <cmath>

#include "common/types.hpp"

namespace TradingSystem {

// Pure pricing rules for the in-process market maker's ladder. Kept out of
// mm_bot.cpp so the grid and the repaint threshold can be exercised directly,
// without standing up a Sequencer and its matching shards.

// Per-symbol tick derived from the anchor's magnitude (~4 significant figures),
// floored at 0.01. e.g. 66020->1.0, 6155->0.1, 740->0.01, 22->0.01. Keeps ladder
// levels visually distinct across instruments spanning a 3000x price range.
inline Price adaptive_tick(Price p) {
    if (p <= 0) return 0.01;
    const double tick = std::pow(10.0, std::floor(std::log10(p)) - 4.0);
    return std::max(tick, 0.01);
}

// How far the anchor has to move from the one the resting ladder was built on
// before that ladder is repainted. `drift_bps` is MarketMakerConfig::
// requote_drift_bps; 0 selects one tick, which is the grid the ladder is priced
// on and therefore the smallest move that can reprice it at all.
inline Price requote_threshold(int drift_bps, Price quoted_anchor, Price tick) {
    if (drift_bps <= 0) return tick;
    return quoted_anchor * (static_cast<double>(drift_bps) / 10000.0);
}

// True when the resting ladder should be repainted around `anchor`. An unset or
// non-positive anchor on either side means we have nothing meaningful resting,
// so repaint unconditionally.
inline bool anchor_has_drifted(int drift_bps, Price quoted_anchor, Price anchor, Price tick) {
    if (quoted_anchor <= 0 || anchor <= 0) return true;
    return std::fabs(anchor - quoted_anchor) >=
           requote_threshold(drift_bps, quoted_anchor, tick);
}

}  // namespace TradingSystem
