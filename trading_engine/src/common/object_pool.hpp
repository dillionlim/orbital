#pragma once
#include <cstddef>
#include <memory>
#include <new>
#include <utility>
#include <vector>

namespace TradingSystem {

// Fixed-slab object pool. Objects are constructed in place inside large slabs
// and never relocated, so a T* handed out here stays valid until destroy() —
// which is exactly what the order book needs: the id index and the intrusive
// price-level lists both hold raw Order* into this pool.
//
// create() reuses a freed slot when one exists (O(1) free-list pop) and only
// touches the allocator when a fresh slab is needed. destroy() runs ~T() and
// returns the slot to the free list. Compared with per-object new/delete this
// removes the allocation from the insert hot path and keeps live orders packed
// into a handful of contiguous slabs (far fewer cache misses on match/cancel).
template <typename T>
class ObjectPool {
public:
    ObjectPool() = default;
    ObjectPool(const ObjectPool&) = delete;
    ObjectPool& operator=(const ObjectPool&) = delete;

    template <typename... Args>
    [[nodiscard]] T* create(Args&&... args) {
        void* mem;
        if (!free_.empty()) {
            mem = free_.back();
            free_.pop_back();
        } else {
            mem = raw_slot();
        }
        return new (mem) T(std::forward<Args>(args)...);
    }

    void destroy(T* p) noexcept {
        p->~T();
        free_.push_back(p);
    }

    // Number of slots currently handed out (created minus destroyed).
    [[nodiscard]] size_t live() const { return allocated_ - free_.size(); }

private:
    static constexpr size_t kSlabObjects = 1024;
    struct Slab {
        alignas(T) unsigned char bytes[sizeof(T) * kSlabObjects];
    };

    void* raw_slot() {
        if (slabs_.empty() || slab_used_ == kSlabObjects) {
            slabs_.push_back(std::make_unique<Slab>());
            slab_used_ = 0;
        }
        void* p = slabs_.back()->bytes + slab_used_ * sizeof(T);
        ++slab_used_;
        ++allocated_;
        return p;
    }

    std::vector<std::unique_ptr<Slab>> slabs_;
    std::vector<void*> free_;
    size_t slab_used_ = 0;
    size_t allocated_ = 0;
};

}  // namespace TradingSystem
