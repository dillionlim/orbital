cmake_minimum_required(VERSION 3.15)

project(TradingEngine VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)

# SQLite. Prefer the static archive so the shipped binary doesn't drag in
# libsqlite3.so.0 — that single dep was the difference between "works on any
# modern Linux" and "fails on older / minimal images". libsqlite3.a is in
# `libsqlite3-dev` on Debian/Ubuntu; if it's missing we fall back to the .so.
find_path(SQLITE3_INCLUDE_DIR NAMES sqlite3.h REQUIRED)
find_library(SQLITE3_STATIC_LIBRARY NAMES libsqlite3.a)
if(SQLITE3_STATIC_LIBRARY)
    message(STATUS "Linking SQLite statically: ${SQLITE3_STATIC_LIBRARY}")
    set(SQLITE3_LIBRARY ${SQLITE3_STATIC_LIBRARY})
else()
    find_library(SQLITE3_LIBRARY NAMES sqlite3 REQUIRED)
    message(WARNING "libsqlite3.a not found — falling back to shared sqlite3 "
                    "(${SQLITE3_LIBRARY}). Binary will require libsqlite3.so.0 at runtime.")
endif()

# ---- Engine target --------------------------------------------------------

file(GLOB_RECURSE ENGINE_SOURCES "src/*.cpp")

add_executable(engine ${ENGINE_SOURCES})

target_include_directories(engine PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src
    ${SQLITE3_INCLUDE_DIR}
)

target_link_libraries(engine PRIVATE
    Threads::Threads
    ${SQLITE3_LIBRARY}
    ${CMAKE_DL_LIBS}
)

# Static libstdc++/libgcc removes the libstdc++.so.6 + libgcc_s.so.1 runtime
# deps; combined with the static sqlite3 above this leaves only glibc + the
# dynamic linker on the .so list, which is the most portable a Linux ELF can
# be without going full -static (which breaks NSS/getaddrinfo).
target_link_options(engine PRIVATE -static-libstdc++ -static-libgcc)

# `-march=native` tunes for the build host's CPU — perfect for local runs,
# fatal for binaries shipped to other machines (illegal-instruction crashes
# on older CPUs). Drop it; opt in via `-DENGINE_NATIVE=ON` for max-perf
# local builds.
option(ENGINE_NATIVE "Tune for the build machine's CPU (-march=native)" OFF)
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    target_compile_options(engine PRIVATE -O3 -Wall -Wextra)
    if(ENGINE_NATIVE)
        target_compile_options(engine PRIVATE -march=native)
    endif()
else()
    target_compile_options(engine PRIVATE -O0 -g -Wall -Wextra)
endif()

# ---- Tests ---------------------------------------------------------------

enable_testing()

function(configure_engine_test target)
    target_include_directories(${target} PRIVATE
        ${CMAKE_SOURCE_DIR}/include
        ${CMAKE_SOURCE_DIR}/src
        ${SQLITE3_INCLUDE_DIR}
    )
    target_link_libraries(${target} PRIVATE
        Threads::Threads
        ${SQLITE3_LIBRARY}
        ${CMAKE_DL_LIBS}
    )
    if(CMAKE_BUILD_TYPE STREQUAL "Release")
        target_compile_options(${target} PRIVATE -O3 -Wall -Wextra)
    else()
        target_compile_options(${target} PRIVATE -O0 -g -Wall -Wextra)
    endif()
endfunction()

function(add_engine_test_case target case_name)
    add_test(NAME ${target}.${case_name} COMMAND ${target} ${case_name})
endfunction()

add_executable(order_book_tests EXCLUDE_FROM_ALL
    tests/order_book_test.cpp
    src/book/order_book.cpp
)
configure_engine_test(order_book_tests)
add_engine_test_case(order_book_tests rests_limit_orders_by_price_priority)
add_engine_test_case(order_book_tests matches_crossing_order_at_maker_price)
add_engine_test_case(order_book_tests rejects_market_order_without_liquidity)
add_engine_test_case(order_book_tests enforces_cancel_ownership)
add_engine_test_case(order_book_tests cancels_resting_self_trade_and_keeps_incoming_remainder)

add_executable(matching_engine_tests EXCLUDE_FROM_ALL
    tests/matching_engine_test.cpp
    src/book/order_book.cpp
    src/engine/matching_engine.cpp
)
configure_engine_test(matching_engine_tests)
add_engine_test_case(matching_engine_tests publishes_initial_snapshot_on_start)
add_engine_test_case(matching_engine_tests rejects_market_order_when_book_is_empty)
add_engine_test_case(matching_engine_tests emits_ack_fills_trade_print_and_book_delta_for_a_match)

