cmake_minimum_required(VERSION 3.15)

project(TradingEngine VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)

file(GLOB_RECURSE ENGINE_SOURCES "src/*.cpp")
add_executable(engine ${ENGINE_SOURCES})

target_include_directories(engine PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(engine PRIVATE Threads::Threads)

if(CMAKE_BUILD_TYPE STREQUAL "Release")
    target_compile_options(engine PRIVATE -O3 -Wall -Wextra)
else()
    target_compile_options(engine PRIVATE -O0 -g -Wall -Wextra)
endif()
