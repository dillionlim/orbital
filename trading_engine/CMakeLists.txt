cmake_minimum_required(VERSION 3.15)

project(TradingEngine VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(SOURCES
    src/main.cpp
)

set(HEADERS
    src/common/types.hpp
    src/public_api.hpp
)

add_executable(engine ${SOURCES} ${HEADERS})

target_include_directories(engine PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src
)

if(CMAKE_BUILD_TYPE STREQUAL "Release")
    target_compile_options(engine PRIVATE
        -O3
        -Wall
        -Wextra
    )
endif()
