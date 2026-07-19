#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

#include "common/types.hpp"

namespace TradingSystem {

struct Order;

// Open-addressing (linear-probing) map from OrderId to a resting Order*.
//
// Replaces std::unordered_map<OrderId, ...> on the book's hot path. The node
// map chased a pointer per lookup and freed a node per erase; this keeps every
// slot in one contiguous array, so find/insert/erase touch one or two cache
// lines instead of a scattered node. Deletion uses Knuth's backward-shift so
// there are no tombstones to poison later probes.
//
// OrderId 0 is reserved as the empty sentinel. Every id the engine assigns is
// >= 1 (the Sequencer starts at 1), so this is free.
class OrderIndex {
public:
    explicit OrderIndex(size_t initial_capacity = 1024) { init(round_up_pow2(initial_capacity)); }

    [[nodiscard]] Order* find(OrderId key) const {
        size_t i = hash(key) & mask_;
        while (slots_[i].key != kEmpty) {
            if (slots_[i].key == key) return slots_[i].val;
            i = (i + 1) & mask_;
        }
        return nullptr;
    }

    // Caller guarantees `key` is not already present (the book rejects
    // duplicate ids up front).
    void insert(OrderId key, Order* val) {
        if ((count_ + 1) * 10 >= slots_.size() * 7) grow();  // keep load factor < 0.7
        place(key, val);
        ++count_;
    }

    bool erase(OrderId key) {
        size_t i = hash(key) & mask_;
        while (slots_[i].key != kEmpty) {
            if (slots_[i].key == key) {
                backward_shift(i);
                --count_;
                return true;
            }
            i = (i + 1) & mask_;
        }
        return false;
    }

    [[nodiscard]] size_t size() const { return count_; }

private:
    static constexpr OrderId kEmpty = 0;
    struct Slot {
        OrderId key = kEmpty;
        Order* val = nullptr;
    };

    static size_t round_up_pow2(size_t n) {
        size_t c = 16;
        while (c < n) c <<= 1;
        return c;
    }

    // splitmix64 finalizer — spreads sequential ids across the table so linear
    // probing keeps short runs.
    static size_t hash(OrderId k) {
        k ^= k >> 30;
        k *= 0xbf58476d1ce4e5b9ULL;
        k ^= k >> 27;
        k *= 0x94d049bb133111ebULL;
        k ^= k >> 31;
        return static_cast<size_t>(k);
    }

    void init(size_t capacity) {
        slots_.assign(capacity, Slot{});
        mask_ = capacity - 1;
        count_ = 0;
    }

    void place(OrderId key, Order* val) {
        size_t i = hash(key) & mask_;
        while (slots_[i].key != kEmpty) i = (i + 1) & mask_;
        slots_[i].key = key;
        slots_[i].val = val;
    }

    void grow() {
        std::vector<Slot> old = std::move(slots_);
        const size_t kept = count_;
        // Quadruple rather than double: reaching a deep book (millions of
        // resting orders) then costs ~half as many full-table re-probes, which
        // is where open addressing otherwise loses ground to a node map on the
        // insert path. Small books stay small — one 256 KB table covers ~180k
        // orders before the first grow.
        init(old.size() * 4);  // resets count_ to 0
        for (const auto& s : old) {
            if (s.key != kEmpty) place(s.key, s.val);
        }
        count_ = kept;
    }

    // Fill the hole at `hole` by shifting back any following element whose ideal
    // slot is not cyclically inside (hole, j]. Classic linear-probing deletion.
    void backward_shift(size_t hole) {
        size_t j = hole;
        for (;;) {
            slots_[hole] = Slot{};
            for (;;) {
                j = (j + 1) & mask_;
                if (slots_[j].key == kEmpty) return;  // hole stays empty
                size_t home = hash(slots_[j].key) & mask_;
                bool in_range = (hole <= j) ? (hole < home && home <= j)
                                            : (hole < home || home <= j);
                if (!in_range) break;  // slots_[j] can move back into the hole
            }
            slots_[hole] = slots_[j];
            hole = j;
        }
    }

    std::vector<Slot> slots_;
    size_t mask_ = 0;
    size_t count_ = 0;
};

}  // namespace TradingSystem
