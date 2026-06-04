#pragma once
#include <iostream>
#include <mutex>
#include <sstream>
#include <string_view>

namespace TradingSystem {

class Log {
public:
    enum class Level { Debug, Info, Warn, Error };

    static Level& level() {
        static Level lvl = Level::Info;
        return lvl;
    }

    static std::mutex& mu() {
        static std::mutex m;
        return m;
    }

    static const char* tag(Level l) {
        switch (l) {
            case Level::Debug: return "DBG";
            case Level::Info:  return "INF";
            case Level::Warn:  return "WRN";
            case Level::Error: return "ERR";
        }
        return "???";
    }
};

#define LOG_AT(LVL, ...) do { \
    if ((LVL) >= ::TradingSystem::Log::level()) { \
        std::ostringstream _oss; \
        _oss << "[" << ::TradingSystem::Log::tag(LVL) << "] " << __VA_ARGS__; \
        std::lock_guard<std::mutex> _lk(::TradingSystem::Log::mu()); \
        std::cout << _oss.str() << std::endl; \
    } \
} while (0)

#define LOG_DEBUG(...) LOG_AT(::TradingSystem::Log::Level::Debug, __VA_ARGS__)
#define LOG_INFO(...)  LOG_AT(::TradingSystem::Log::Level::Info,  __VA_ARGS__)
#define LOG_WARN(...)  LOG_AT(::TradingSystem::Log::Level::Warn,  __VA_ARGS__)
#define LOG_ERROR(...) LOG_AT(::TradingSystem::Log::Level::Error, __VA_ARGS__)

}
