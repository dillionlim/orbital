#include "news_bot/news_bot.hpp"

#include <algorithm>
#include <cmath>
#include <random>
#include <utility>

#include "common/time.hpp"

namespace TradingSystem {

namespace {

// Persona dispatch — return how each persona reacts to a buy/sell signal.
// Returns Hold to abort the trade entirely (e.g. unknown persona string).
NewsDirection map_for_persona(const std::string& persona, NewsDirection signal) {
    if (signal == NewsDirection::Hold) return NewsDirection::Hold;
    if (persona == "momentum")    return signal;
    if (persona == "contrarian")  return (signal == NewsDirection::Buy)
                                            ? NewsDirection::Sell : NewsDirection::Buy;
    if (persona == "scalper")     return signal;     // direction same; sizing/pricing differ
    return NewsDirection::Hold;
}

// Persona-specific size scale.
//   momentum / contrarian: full base size
//   scalper:               half — designed to take small bites
double size_scale_for_persona(const std::string& persona) {
    if (persona == "scalper") return 0.5;
    return 1.0;
}

// Persona-specific base price offset, in bps relative to symbol mid.
//   momentum / contrarian: aggressive — cross 50 bps into the book.
//                          (MM half-spread defaults to 10 bps so this
//                          comfortably executes and rests if depth is shallow)
//   scalper:               passive — sit 10 bps INSIDE the spread on the
//                          named side, hoping to scalp a small move.
double base_price_offset_bps(const std::string& persona) {
    if (persona == "scalper") return -10.0;
    return 50.0;
}

// Per-thread RNG seeded once. Cheap to call and avoids the overhead of
// constructing a std::mt19937 on every signal.
std::mt19937& trade_rng() {
    static thread_local std::mt19937 g(std::random_device{}());
    return g;
}

// Sample a uniform multiplier in [1 - pct/100, 1 + pct/100]. pct clamped
// to [0, 90] so we never zero out the size.
double sample_size_multiplier(int pct) {
    if (pct <= 0) return 1.0;
    if (pct > 90) pct = 90;
    std::uniform_real_distribution<double> dist(-pct / 100.0, pct / 100.0);
    return 1.0 + dist(trade_rng());
}

// Sample a uniform offset in [-bps, +bps] bps. bps clamped to [0, 500] so
// pathological configs can't fire trades a mile away from mid.
double sample_offset_bps(int bps) {
    if (bps <= 0) return 0.0;
    if (bps > 500) bps = 500;
    std::uniform_real_distribution<double> dist(-static_cast<double>(bps),
                                                 static_cast<double>(bps));
    return dist(trade_rng());
}

}  // namespace

NewsBot::NewsBot(NewsBotConfig cfg, int instance_id, Sequencer& seq,
                 std::shared_ptr<SymbolRegistry> registry,
                 std::shared_ptr<BotTracker> bot_tracker,
                 std::shared_ptr<MarketFlow> market_flow)
    : cfg_(std::move(cfg)), instance_id_(instance_id <= 0 ? 1 : instance_id),
      seq_(seq), registry_(std::move(registry)),
      bot_tracker_(std::move(bot_tracker)),
      market_flow_(std::move(market_flow)) {
    // Distinct user_id per instance so STP doesn't pair siblings against
    // each other. bot_tracker recognises the prefix and groups display.
    user_id_  = "internal:news_" + cfg_.persona + "_" + std::to_string(instance_id_);
    client_id_ = "news-" + cfg_.persona + "-" + std::to_string(instance_id_);
}

NewsBot::~NewsBot() { stop(); }

void NewsBot::attach_to(NewsAnalyzer& analyzer) {
    // Pre-register so the dashboard's bot list shows this strategy as "idle"
    // immediately rather than only appearing after the first trade — which
    // can be tens of minutes away if the news feed is slow.
    if (bot_tracker_) {
        bot_tracker_->register_internal_bot(user_id_, client_id_);
    }
    analyzer.subscribe([this](const NewsItem& it, const NewsAnalysis& a) {
        on_signal(it, a);
    });
    // Per-instance log intentionally omitted — main.cpp logs one summary
    // line per persona group instead, since count=N could otherwise dump
    // N nearly-identical lines into the boot log.
}

void NewsBot::start() {
    // Worker thread is only needed when there's something to do
    // asynchronously: periodic noise OR delayed signal drainage. With
    // both at 0 we keep the legacy zero-thread path (on_signal fires
    // synchronously inline on the analyzer's poll thread).
    const bool has_noise = cfg_.noise_interval_seconds > 0;
    const bool has_delay = cfg_.signal_delay_ms > 0;
    if (!has_noise && !has_delay) return;
    if (running_.exchange(true)) return;
    worker_thread_ = std::thread([this] { worker_loop(); });
}

void NewsBot::stop() {
    if (!running_.exchange(false)) return;
    queue_cv_.notify_all();   // unblock worker if waiting on the cv
    if (worker_thread_.joinable()) worker_thread_.join();
}

OrderSide NewsBot::effective_side(NewsDirection dir) const {
    return (dir == NewsDirection::Buy) ? OrderSide::Buy : OrderSide::Sell;
}

// Shared "place an order at mid ± offset, with jitter" path. Used by both
// signal-driven trades (where confidence multiplies size) and noise trades
// (where confidence=1 so size_per_signal isn't deflated by a fake "0.5").
void NewsBot::emit_order(SymbolId symbol, OrderSide side, Quantity base_qty,
                         double base_off_bps, double signal_confidence) {
    Price mid = 0.0;
    for (const auto& s : registry_->symbols()) {
        if (s.id == symbol) { mid = s.mid; break; }
    }
    if (mid <= 0.0) return;

    const double jitter_off = sample_offset_bps(cfg_.price_offset_jitter_bps);
    const double sign = (side == OrderSide::Buy) ? 1.0 : -1.0;
    const Price limit_price = mid * (1.0 + sign * (base_off_bps + jitter_off) / 10000.0);

    const double persona_scale = size_scale_for_persona(cfg_.persona);
    const double conf = std::clamp(signal_confidence, 0.0, 1.0);
    const double jitter_mult = sample_size_multiplier(cfg_.size_jitter_pct);
    const double sized = static_cast<double>(base_qty)
                       * persona_scale * conf * jitter_mult;
    Quantity qty = static_cast<Quantity>(std::llround(sized));
    if (qty < 1) qty = 1;

    PlaceOrderCmd cmd;
    cmd.symbol = symbol;
    cmd.side = side;
    cmd.type = OrderType::Limit;
    cmd.quantity = qty;
    cmd.limit_price = limit_price;
    cmd.user_id = user_id_;
    cmd.client_id = client_id_;
    cmd.client_order_id = cmd.client_id + "-" + std::to_string(++seq_num_);
    cmd.session_id = kInternalSession;
    cmd.is_internal = true;
    cmd.ts = now_ms();
    seq_.submit_place(std::move(cmd));
}

void NewsBot::on_signal(const NewsItem& news, const NewsAnalysis& a) {
    // Instances are only constructed when count > 0, so we don't need an
    // enabled-style gate here. Just respect the per-bot threshold.
    //
    // Per-instance log intentionally omitted — count=N would emit N
    // identical lines per signal. The analyzer logs once at receive
    // time; per-bot trade evidence shows up in /bots fills and the
    // SQLite trade ledger.
    (void)news;
    if (a.confidence < cfg_.confidence_threshold) return;

    const NewsDirection dir = map_for_persona(cfg_.persona, a.direction);
    if (dir == NewsDirection::Hold) return;

    const auto sym_id = registry_->id_for(a.symbol_name);
    if (!sym_id) return;

    const OrderSide side = effective_side(dir);

    // signal_delay_ms == 0 → legacy synchronous fire (no worker thread,
    // no queue cost). When > 0, each instance picks an independent
    // random delay in [0, signal_delay_ms] so a count=N cohort spreads
    // its reaction across the window — the in-process MM gets time to
    // requote between waves of bot fills, producing gradual price
    // discovery instead of an instantaneous step jump.
    if (cfg_.signal_delay_ms <= 0 || !running_.load()) {
        emit_order(*sym_id, side, cfg_.size_per_signal,
                   base_price_offset_bps(cfg_.persona), a.confidence);
        return;
    }
    int max_delay = cfg_.signal_delay_ms;
    if (max_delay > 60'000) max_delay = 60'000;   // 60s sanity cap
    std::uniform_int_distribution<int> jit(0, max_delay);
    PendingSignal ps;
    ps.fire_at = std::chrono::steady_clock::now()
               + std::chrono::milliseconds(jit(trade_rng()));
    ps.symbol = *sym_id;
    ps.side = side;
    ps.base_qty = cfg_.size_per_signal;
    ps.off_bps = base_price_offset_bps(cfg_.persona);
    ps.confidence = a.confidence;
    {
        std::lock_guard<std::mutex> lk(queue_mu_);
        pending_.push(std::move(ps));
    }
    queue_cv_.notify_one();
}

// One iteration of the background-noise behaviour. Picks a random symbol
// and fires a persona-shaped order. Extracted from the old noise_loop so
// the unified worker_loop below can call it on its noise schedule.
//
// Persona-aware direction + sizing. The market-microstructure refinements
// vs. plain herding:
//
//   momentum   — nonlinear feedback. Tilt grows with |bias|, so a strong
//                trend pulls harder than a weak one. Positive-feedback
//                loop that produces visible cascades when many momentum
//                bots are online together.
//
//   contrarian — threshold-gated. Real fade traders sit out noise and
//                only step in once the trend has run "too far". Below
//                |bias| ≈ 0.3 we mostly skip this noise tick; above the
//                threshold, fade hard.
//
//   scalper    — vol-aware. Size scales DOWN with realized volatility
//                (risk-off when wild); direction stays mostly random
//                with a small flow lean.
void NewsBot::run_noise_tick() {
    const auto& syms = registry_->symbols();
    if (syms.empty()) return;
    std::uniform_int_distribution<size_t> sym_pick(0, syms.size() - 1);
    const SymbolId chosen = syms[sym_pick(trade_rng())].id;

    const double bias = market_flow_ ? market_flow_->bias() : 0.0;
    const double vol  = market_flow_ ? market_flow_->volatility() : 0.0;

    std::uniform_real_distribution<double> coin(0.0, 1.0);
    double tilt = 0.0;
    double size_scale = 0.5;   // base "noise vs signal" ratio
    if (cfg_.persona == "momentum") {
        const double absb = std::abs(bias);
        const double herd = 0.30 + 0.55 * absb;
        tilt = herd * bias;
    } else if (cfg_.persona == "contrarian") {
        const double absb = std::abs(bias);
        if (absb < 0.3) {
            // Below threshold — mostly skip this tick. ~30% chance of
            // trading anyway so the bot doesn't disappear entirely from
            // /bots when the market is calm.
            if (coin(trade_rng()) > 0.3) return;
            tilt = -0.15 * bias;
        } else {
            tilt = -0.65 * bias;
        }
    } else if (cfg_.persona == "scalper") {
        tilt = 0.10 * bias;
        const double vz = std::min(vol / 0.05, 1.0);
        size_scale *= 1.0 - 0.7 * vz;
    }
    double p_buy = 0.5 + tilt;
    if (p_buy < 0.05) p_buy = 0.05;
    if (p_buy > 0.95) p_buy = 0.95;
    const OrderSide side = (coin(trade_rng()) < p_buy) ? OrderSide::Buy : OrderSide::Sell;

    const Quantity base = std::max<Quantity>(1, cfg_.size_per_signal);
    emit_order(chosen, side, base,
               base_price_offset_bps(cfg_.persona), size_scale);
}

// Unified worker. Wakes either at the next noise tick, the next pending
// signal's fire_at, or on shutdown — whichever comes first. Drains all
// ready signals, fires noise if due, sleeps until the next deadline.
//
// No per-instance startup/shutdown log — with count=N these would emit
// N lines on every restart. The persona-level summary in main.cpp covers
// it.
void NewsBot::worker_loop() {
    using clock = std::chrono::steady_clock;
    auto schedule_next_noise = [&](clock::time_point& next) {
        if (cfg_.noise_interval_seconds <= 0) {
            next = clock::time_point::max();
            return;
        }
        // Random jitter prevents siblings spawned at the same instant
        // from firing in lockstep.
        std::uniform_real_distribution<double> jitter(0.5, 1.5);
        const double secs = cfg_.noise_interval_seconds * jitter(trade_rng());
        next = clock::now() + std::chrono::milliseconds(
                                   static_cast<int>(secs * 1000));
    };
    clock::time_point next_noise_at;
    schedule_next_noise(next_noise_at);

    while (running_.load()) {
        // Compute the next wake. Cap at 1s so we still tick periodically
        // even when the queue is empty and no noise is configured (lets
        // running_ flips be honoured promptly).
        clock::time_point next_wake = clock::now() + std::chrono::seconds(1);
        if (next_noise_at < next_wake) next_wake = next_noise_at;
        {
            std::unique_lock<std::mutex> lk(queue_mu_);
            if (!pending_.empty() && pending_.top().fire_at < next_wake) {
                next_wake = pending_.top().fire_at;
            }
            queue_cv_.wait_until(lk, next_wake);
        }
        if (!running_.load()) break;

        // Drain all pending signals whose fire_at has elapsed.
        std::vector<PendingSignal> ready;
        {
            std::lock_guard<std::mutex> lk(queue_mu_);
            const auto now = clock::now();
            while (!pending_.empty() && pending_.top().fire_at <= now) {
                ready.push_back(pending_.top());
                pending_.pop();
            }
        }
        for (const auto& ps : ready) {
            emit_order(ps.symbol, ps.side, ps.base_qty, ps.off_bps, ps.confidence);
        }

        // Fire a noise tick if the next-noise deadline has elapsed.
        if (cfg_.noise_interval_seconds > 0 && clock::now() >= next_noise_at) {
            run_noise_tick();
            schedule_next_noise(next_noise_at);
        }
    }
}

}  // namespace TradingSystem
