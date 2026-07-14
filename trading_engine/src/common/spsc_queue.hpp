#pragma once
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <utility>
#include <vector>

#include "common/concepts.hpp"

namespace TradingSystem {

// Single-producer / single-consumer ring buffer. Capacity must be a power of two.
template <QueueValue T, size_t Capacity>
class SPSCQueue {
    static_assert(Capacity > 0 && (Capacity & (Capacity - 1)) == 0,
                  "Capacity must be a power of two");

public:
    SPSCQueue() : buf_(Capacity) {}

    [[nodiscard]] bool try_push(T value) {
        const size_t head = head_.load(std::memory_order_relaxed);
        const size_t next = (head + 1) & mask_;
        if (next == tail_.load(std::memory_order_acquire)) {
            return false;
        }
        buf_[head] = std::move(value);
        head_.store(next, std::memory_order_release);
        return true;
    }

    [[nodiscard]] bool try_pop(T& out) {
        const size_t tail = tail_.load(std::memory_order_relaxed);
        if (tail == head_.load(std::memory_order_acquire)) {
            return false;
        }
        out = std::move(buf_[tail]);
        tail_.store((tail + 1) & mask_, std::memory_order_release);
        return true;
    }

    [[nodiscard]] bool empty() const {
        return head_.load(std::memory_order_acquire) ==
               tail_.load(std::memory_order_acquire);
    }

private:
    static constexpr size_t mask_ = Capacity - 1;
    alignas(64) std::atomic<size_t> head_{0};
    alignas(64) std::atomic<size_t> tail_{0};
    std::vector<T> buf_;
};

// Bounded multi-producer / single-consumer ring (Vyukov). Capacity must be a power of two.
// Bounded, unlike MPSCQueue, so try_push can still report full and the Sequencer can reject.
template <QueueValue T, size_t Capacity>
class MPSCRing {
    static_assert(Capacity > 0 && (Capacity & (Capacity - 1)) == 0,
                  "Capacity must be a power of two");

public:
    MPSCRing() : buf_(Capacity) {
        for (size_t i = 0; i < Capacity; ++i) {
            buf_[i].seq.store(i, std::memory_order_relaxed);
        }
    }

    [[nodiscard]] bool try_push(T value) {
        size_t pos = enqueue_pos_.load(std::memory_order_relaxed);
        for (;;) {
            Cell& cell = buf_[pos & mask_];
            const size_t seq = cell.seq.load(std::memory_order_acquire);
            const auto diff =
                static_cast<std::intptr_t>(seq) - static_cast<std::intptr_t>(pos);
            if (diff == 0) {
                if (enqueue_pos_.compare_exchange_weak(pos, pos + 1,
                                                       std::memory_order_relaxed)) {
                    cell.data = std::move(value);
                    // Publish; the consumer may only read this cell once seq == pos + 1.
                    cell.seq.store(pos + 1, std::memory_order_release);
                    return true;
                }
            } else if (diff < 0) {
                return false;  // Full.
            } else {
                pos = enqueue_pos_.load(std::memory_order_relaxed);
            }
        }
    }

    [[nodiscard]] bool try_pop(T& out) {
        const size_t pos = dequeue_pos_.load(std::memory_order_relaxed);
        Cell& cell = buf_[pos & mask_];
        const size_t seq = cell.seq.load(std::memory_order_acquire);
        const auto diff =
            static_cast<std::intptr_t>(seq) - static_cast<std::intptr_t>(pos + 1);
        // Empty, or a producer has claimed the slot but not published it yet.
        if (diff != 0) return false;

        out = std::move(cell.data);
        // Hand the slot to the producer one lap ahead.
        cell.seq.store(pos + mask_ + 1, std::memory_order_release);
        dequeue_pos_.store(pos + 1, std::memory_order_relaxed);
        return true;
    }

    [[nodiscard]] bool empty() const {
        const size_t pos = dequeue_pos_.load(std::memory_order_relaxed);
        const size_t seq = buf_[pos & mask_].seq.load(std::memory_order_acquire);
        return static_cast<std::intptr_t>(seq) -
                   static_cast<std::intptr_t>(pos + 1) != 0;
    }

private:
    struct Cell {
        std::atomic<size_t> seq;
        T data;
    };

    static constexpr size_t mask_ = Capacity - 1;
    alignas(64) std::atomic<size_t> enqueue_pos_{0};
    alignas(64) std::atomic<size_t> dequeue_pos_{0};
    std::vector<Cell> buf_;
};

// Multi-producer / single-consumer queue. Simple mutex+deque; not on the per-symbol
// hot path. Used for the global inbound funnel and outbound broadcaster pipe.
template <QueueValue T>
class MPSCQueue {
public:
    void push(T value) {
        {
            std::lock_guard<std::mutex> lk(mu_);
            q_.push_back(std::move(value));
        }
        cv_.notify_one();
    }

    [[nodiscard]] bool try_pop(T& out) {
        std::lock_guard<std::mutex> lk(mu_);
        if (q_.empty()) return false;
        out = std::move(q_.front());
        q_.pop_front();
        return true;
    }

    [[nodiscard]] bool wait_pop(T& out, int timeout_ms) {
        std::unique_lock<std::mutex> lk(mu_);
        if (!cv_.wait_for(lk, std::chrono::milliseconds(timeout_ms),
                          [&] { return !q_.empty() || closed_; })) {
            return false;
        }
        if (q_.empty()) return false;
        out = std::move(q_.front());
        q_.pop_front();
        return true;
    }

    void close() {
        {
            std::lock_guard<std::mutex> lk(mu_);
            closed_ = true;
        }
        cv_.notify_all();
    }

    [[nodiscard]] size_t size() const {
        std::lock_guard<std::mutex> lk(mu_);
        return q_.size();
    }

private:
    mutable std::mutex mu_;
    std::condition_variable cv_;
    std::deque<T> q_;
    bool closed_ = false;
};

}  // namespace TradingSystem
