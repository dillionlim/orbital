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
add_engine_test_case(order_book_tests fills_same_price_level_in_arrival_order)
add_engine_test_case(order_book_tests sweeps_multiple_price_levels_with_volume_weighted_average)
add_engine_test_case(order_book_tests partially_fills_crossing_limit_and_rests_remainder)
add_engine_test_case(order_book_tests cancels_partially_filled_resting_order_and_keeps_level_qty_honest)
add_engine_test_case(order_book_tests rejects_cancel_of_unknown_order)
add_engine_test_case(order_book_tests allows_internal_cancel_to_bypass_owner_check)
add_engine_test_case(order_book_tests cancels_every_same_user_maker_at_a_level)
add_engine_test_case(order_book_tests skips_same_user_maker_and_fills_other_maker_at_same_level)
add_engine_test_case(order_book_tests handles_top_n_and_empty_book_edges)
add_engine_test_case(order_book_tests rejects_duplicate_order_id_without_corrupting_the_level)

add_executable(mpsc_ring_tests EXCLUDE_FROM_ALL
    tests/mpsc_ring_test.cpp
)
configure_engine_test(mpsc_ring_tests)
add_engine_test_case(mpsc_ring_tests loses_no_commands_under_concurrent_producers)
add_engine_test_case(mpsc_ring_tests reports_full_instead_of_overwriting)

add_executable(session_tests EXCLUDE_FROM_ALL
    tests/session_test.cpp
    src/server/session.cpp
    src/server/protocol.cpp
    src/server/ws_frame.cpp
    src/common/config.cpp
)
configure_engine_test(session_tests)
add_engine_test_case(session_tests queues_outbound_without_touching_the_socket)
add_engine_test_case(session_tests kicks_a_session_whose_queue_overflows)
add_engine_test_case(session_tests refuses_to_queue_after_the_writer_exits)
add_engine_test_case(session_tests request_close_marks_the_session_closing)
add_engine_test_case(session_tests client_id_survives_concurrent_reads_and_writes)

add_executable(auth_tests EXCLUDE_FROM_ALL
    tests/auth_test.cpp
    src/auth/api_key_authenticator.cpp
    src/common/http_fetch.cpp
)
configure_engine_test(auth_tests)
add_engine_test_case(auth_tests extracts_bearer_token_from_authorization_header)
add_engine_test_case(auth_tests matches_only_the_two_spellings_of_each_header)
add_engine_test_case(auth_tests extracts_api_key_header_form)
add_engine_test_case(auth_tests ignores_query_string_api_key)
add_engine_test_case(auth_tests returns_empty_when_no_key_is_present)
add_engine_test_case(auth_tests handles_malformed_authorization_headers)
add_engine_test_case(auth_tests handles_whitespace_and_tab_variations)
add_engine_test_case(auth_tests stops_value_at_header_boundary_against_injection)
add_engine_test_case(auth_tests handles_truncated_and_oversized_requests)
add_engine_test_case(auth_tests takes_the_first_of_multiple_authorization_headers)
add_engine_test_case(auth_tests validates_known_key_offline)
add_engine_test_case(auth_tests rejects_unknown_and_malformed_keys)
add_engine_test_case(auth_tests revokes_keys_with_remove_key)
add_engine_test_case(auth_tests serves_cached_positive_and_honours_revocation)
add_engine_test_case(auth_tests survives_concurrent_validate_and_mutation)

add_executable(ws_frame_tests EXCLUDE_FROM_ALL
    tests/ws_frame_test.cpp
    src/server/ws_frame.cpp
)
configure_engine_test(ws_frame_tests)
add_engine_test_case(ws_frame_tests reads_and_unmasks_a_well_formed_text_frame)
add_engine_test_case(ws_frame_tests rejects_an_unmasked_client_frame)
add_engine_test_case(ws_frame_tests parses_every_payload_length_encoding)
add_engine_test_case(ws_frame_tests refuses_payloads_above_max_payload)
add_engine_test_case(ws_frame_tests rejects_truncated_frames)
add_engine_test_case(ws_frame_tests returns_false_on_immediate_eof)
add_engine_test_case(ws_frame_tests parses_control_frames_and_zero_length_payloads)
add_engine_test_case(ws_frame_tests reports_the_fin_bit_for_fragmented_frames)
add_engine_test_case(ws_frame_tests passes_unknown_opcodes_through)
add_engine_test_case(ws_frame_tests reads_headers_terminated_by_crlfcrlf)
add_engine_test_case(ws_frame_tests keeps_body_bytes_that_arrive_in_the_same_read)
add_engine_test_case(ws_frame_tests refuses_headers_above_max_size)
add_engine_test_case(ws_frame_tests enforces_the_deadline_against_a_trickling_client)
add_engine_test_case(ws_frame_tests treats_a_socket_recv_timeout_as_a_failed_read)
add_engine_test_case(ws_frame_tests computes_the_rfc6455_accept_key)
add_engine_test_case(ws_frame_tests builds_the_handshake_response)

add_executable(protocol_tests EXCLUDE_FROM_ALL
    tests/protocol_test.cpp
    src/server/protocol.cpp
    src/common/config.cpp
)
configure_engine_test(protocol_tests)
add_engine_test_case(protocol_tests parses_hello_and_ping)
add_engine_test_case(protocol_tests parses_limit_place_order)
add_engine_test_case(protocol_tests parses_market_place_order_without_price)
add_engine_test_case(protocol_tests parses_cancel_order)
add_engine_test_case(protocol_tests parses_subscribe_and_unsubscribe)
add_engine_test_case(protocol_tests rejects_malformed_json)
add_engine_test_case(protocol_tests rejects_non_object_toplevel)
add_engine_test_case(protocol_tests rejects_deeply_nested_payloads)
add_engine_test_case(protocol_tests rejects_missing_or_untyped_t)
add_engine_test_case(protocol_tests rejects_unknown_message_type)
add_engine_test_case(protocol_tests rejects_place_order_missing_required_fields)
add_engine_test_case(protocol_tests rejects_place_order_with_wrong_field_types)
add_engine_test_case(protocol_tests rejects_unknown_enum_spellings)
add_engine_test_case(protocol_tests rejects_zero_and_out_of_range_quantities)
add_engine_test_case(protocol_tests rejects_non_positive_and_non_finite_prices)
add_engine_test_case(protocol_tests rejects_zero_order_id_on_cancel)
add_engine_test_case(protocol_tests accepts_any_channel_string_on_subscribe)
add_engine_test_case(protocol_tests carries_long_and_escaped_strings_without_truncation)
add_engine_test_case(protocol_tests escapes_hostile_strings_in_welcome_and_error)
add_engine_test_case(protocol_tests escapes_hostile_strings_in_execution_reports)
add_engine_test_case(protocol_tests escapes_hostile_symbols_in_market_data_frames)
add_engine_test_case(protocol_tests keeps_frames_valid_json_under_every_control_byte)

add_executable(matching_engine_tests EXCLUDE_FROM_ALL
    tests/matching_engine_test.cpp
    src/book/order_book.cpp
    src/engine/matching_engine.cpp
)
configure_engine_test(matching_engine_tests)
add_engine_test_case(matching_engine_tests publishes_initial_snapshot_on_start)
add_engine_test_case(matching_engine_tests rejects_market_order_when_book_is_empty)
add_engine_test_case(matching_engine_tests emits_ack_fills_trade_print_and_book_delta_for_a_match)
add_engine_test_case(matching_engine_tests publishes_book_delta_when_self_trade_prevention_empties_the_book)

