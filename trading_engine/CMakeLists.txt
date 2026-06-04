cmake_minimum_required(VERSION 3.15)

project(TradingEngine VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Python3 REQUIRED COMPONENTS Interpreter)

# System libsqlite3
find_path(SQLITE3_INCLUDE_DIR NAMES sqlite3.h REQUIRED)
find_library(SQLITE3_LIBRARY NAMES sqlite3 REQUIRED)

# ---- Bundled docs ---------------------------------------------------------
# Walks docs/site/ (HTML/CSS/JS + api.md + openapi.yaml), embeds every file as
# byte arrays in a generated .cpp, which is compiled into the engine. The
# binary serves these from memory at /docs/* — no external files at runtime.

set(DOCS_SRC_DIR    "${CMAKE_SOURCE_DIR}/docs/site")
set(DOCS_BUNDLER    "${CMAKE_SOURCE_DIR}/scripts/bundle_docs.py")
set(DOCS_GEN_DIR    "${CMAKE_BINARY_DIR}/generated")
set(DOCS_GEN_FILE   "${DOCS_GEN_DIR}/docs_bundle.generated.cpp")

file(GLOB_RECURSE DOCS_INPUT_FILES "${DOCS_SRC_DIR}/*")

add_custom_command(
    OUTPUT  "${DOCS_GEN_FILE}"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${DOCS_GEN_DIR}"
    COMMAND ${Python3_EXECUTABLE} "${DOCS_BUNDLER}" "${DOCS_SRC_DIR}" "${DOCS_GEN_FILE}"
    DEPENDS ${DOCS_BUNDLER} ${DOCS_INPUT_FILES}
    COMMENT "Bundling docs/site/ → docs_bundle.generated.cpp"
    VERBATIM
)
add_custom_target(docs_bundle DEPENDS "${DOCS_GEN_FILE}")

# ---- Engine target --------------------------------------------------------

file(GLOB_RECURSE ENGINE_SOURCES "src/*.cpp")
list(APPEND ENGINE_SOURCES "${DOCS_GEN_FILE}")

add_executable(engine ${ENGINE_SOURCES})
add_dependencies(engine docs_bundle)

target_include_directories(engine PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/src
    ${SQLITE3_INCLUDE_DIR}
)

target_link_libraries(engine PRIVATE
    Threads::Threads
    OpenSSL::Crypto
    ${SQLITE3_LIBRARY}
)

if(CMAKE_BUILD_TYPE STREQUAL "Release")
    target_compile_options(engine PRIVATE -O3 -march=native -Wall -Wextra)
else()
    target_compile_options(engine PRIVATE -O0 -g -Wall -Wextra)
endif()
