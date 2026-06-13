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
