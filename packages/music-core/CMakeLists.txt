cmake_minimum_required(VERSION 3.20)
if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Darwin" AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum supported macOS" FORCE)
endif()
project(tuneforge_music_core VERSION 0.1.0 LANGUAGES C CXX)
if(EMSCRIPTEN)
  add_compile_options(-fexceptions)
endif()

# Compilation never downloads sources. Acquire the pinned archive explicitly before building.
find_package(Python 3.11 COMPONENTS Interpreter REQUIRED)
set(POLICY_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/gingo")
execute_process(
  COMMAND "${Python_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/prepare_sources.py" "${POLICY_SOURCE}"
  RESULT_VARIABLE prepare_result
)
if(NOT prepare_result EQUAL 0)
  message(FATAL_ERROR "Locked source preparation failed. Run node scripts/build-music-core.mjs --fetch-sources [--offline] from the repository root.")
endif()

set(GINGO_SOURCES
  cpp/src/chord.cpp
  cpp/src/duration.cpp
  cpp/src/event.cpp
  cpp/src/field.cpp
  cpp/src/fretboard.cpp
  cpp/src/fretboard_svg.cpp
  cpp/src/internal/data_ops.cpp
  cpp/src/internal/lookup_data.cpp
  cpp/src/internal/lookup_progression.cpp
  cpp/src/internal/mode_data.cpp
  cpp/src/internal/notation_utils.cpp
  cpp/src/interval.cpp
  cpp/src/midi1.cpp
  cpp/src/midi2.cpp
  cpp/src/midi_format.cpp
  cpp/src/midici_handler.cpp
  cpp/src/monitor.cpp
  cpp/src/musicxml.cpp
  cpp/src/note.cpp
  cpp/src/piano.cpp
  cpp/src/piano_svg.cpp
  cpp/src/progression.cpp
  cpp/src/scale.cpp
  cpp/src/sequence.cpp
  cpp/src/sequence_midi.cpp
  cpp/src/tempo.cpp
  cpp/src/time_signature.cpp
  cpp/src/tree.cpp
)
foreach(variant IN ITEMS upstream policy)
  if(variant STREQUAL "upstream")
    set(source_root "${CMAKE_CURRENT_SOURCE_DIR}/vendor/gingo-src")
  else()
    set(source_root "${POLICY_SOURCE}")
  endif()
  list(TRANSFORM GINGO_SOURCES PREPEND "${source_root}/" OUTPUT_VARIABLE variant_sources)
  add_library(music_core_${variant} STATIC ${variant_sources})
  target_include_directories(music_core_${variant} PUBLIC "${source_root}/cpp/include")
  target_compile_features(music_core_${variant} PUBLIC cxx_std_17)
  set_target_properties(music_core_${variant} PROPERTIES CXX_EXTENSIONS OFF POSITION_INDEPENDENT_CODE ON)
  add_executable(music_core_structural_${variant} test/structural.cpp)
  target_link_libraries(music_core_structural_${variant} PRIVATE music_core_${variant})
endforeach()
target_compile_definitions(music_core_structural_policy PRIVATE TUNEFORGE_SEARCH_POLICY=1)

set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS resources/instruments-v1.json tools/generate_data.py)
execute_process(
  COMMAND "${Python_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/generate_data.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/resources/instruments-v1.json" "${CMAKE_CURRENT_BINARY_DIR}/knowledge.hpp"
  RESULT_VARIABLE data_result
)
if(NOT data_result EQUAL 0)
  message(FATAL_ERROR "Instrument data serialization failed")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS schema/operations-v1.json)
execute_process(
  COMMAND "${Python_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/generate_data.py"
    "${CMAKE_CURRENT_SOURCE_DIR}/schema/operations-v1.json" "${CMAKE_CURRENT_BINARY_DIR}/operation_schema.hpp" embedded_operation_schema
  RESULT_VARIABLE schema_result
)
if(NOT schema_result EQUAL 0)
  message(FATAL_ERROR "Operation schema serialization failed")
endif()
add_library(tuneforge_music_policies STATIC src/core.cpp src/profiles.cpp src/guitar.cpp src/keyboard.cpp src/stradella.cpp src/normalization.cpp src/legacy_policies.cpp)
target_link_libraries(tuneforge_music_policies PUBLIC music_core_policy)
target_include_directories(tuneforge_music_policies PUBLIC src PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
add_executable(music_core_policy_contract test/policy.cpp)
target_link_libraries(music_core_policy_contract PRIVATE tuneforge_music_policies)

add_executable(music_core_normalization_contract test/normalization.cpp)
target_link_libraries(music_core_normalization_contract PRIVATE tuneforge_music_policies)

set_target_properties(tuneforge_music_policies PROPERTIES POSITION_INDEPENDENT_CODE ON)
foreach(linkage IN ITEMS STATIC SHARED)
  string(TOLOWER "${linkage}" name)
  add_library(tuneforge_music_abi_${name} ${linkage} src/abi.cpp)
  target_link_libraries(tuneforge_music_abi_${name} PUBLIC tuneforge_music_policies)
  target_include_directories(tuneforge_music_abi_${name} PUBLIC include PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
  set_target_properties(tuneforge_music_abi_${name} PROPERTIES OUTPUT_NAME tuneforge_music_core POSITION_INDEPENDENT_CODE ON)
endforeach()
add_library(tuneforge_music_core ALIAS tuneforge_music_abi_static)

add_executable(music_core_abi_contract test/abi.cpp)
target_link_libraries(music_core_abi_contract PRIVATE tuneforge_music_abi_shared)
add_executable(music_core_abi_header test/abi-header.c)
target_link_libraries(music_core_abi_header PRIVATE tuneforge_music_abi_static)
add_executable(music_core_abi_boundary test/abi-boundary.cpp src/abi.cpp)
target_compile_definitions(music_core_abi_boundary PRIVATE TUNEFORGE_MUSIC_TEST_ALLOCATOR=1)
target_compile_options(music_core_abi_boundary PRIVATE -UNDEBUG)
target_include_directories(music_core_abi_boundary PRIVATE include "${CMAKE_CURRENT_BINARY_DIR}")
target_link_libraries(music_core_abi_boundary PRIVATE tuneforge_music_policies)

option(TUNEFORGE_BUILD_PYTHON "Build the Python transport module" OFF)
if(TUNEFORGE_BUILD_PYTHON)
  set(PYBIND11_FINDPYTHON ON)
  find_package(Python 3.11 COMPONENTS Interpreter Development.Module REQUIRED)
  find_package(pybind11 3.1.0 EXACT CONFIG REQUIRED)
  pybind11_add_module(_native bindings/python/native.cpp)
  target_link_libraries(_native PRIVATE tuneforge_music_abi_static)
  install(TARGETS _native LIBRARY DESTINATION tuneforge_music_core)
  install(DIRECTORY resources schema DESTINATION tuneforge_music_core)
  install(FILES sources.lock.json toolchains.lock.json DESTINATION tuneforge_music_core)
endif()
if(EMSCRIPTEN)
  add_executable(music_core_wasm src/abi.cpp)
  target_link_libraries(music_core_wasm PRIVATE tuneforge_music_policies)
  target_include_directories(music_core_wasm PRIVATE include "${CMAKE_CURRENT_BINARY_DIR}")
  set_target_properties(music_core_wasm PROPERTIES OUTPUT_NAME music-core SUFFIX .mjs)
  target_link_options(music_core_wasm PRIVATE --no-entry -fexceptions -sDISABLE_EXCEPTION_CATCHING=0 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,node -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 -sABORTING_MALLOC=0 -sSTACK_SIZE=1048576 "-sEXPORTED_RUNTIME_METHODS=[\"HEAPU8\",\"HEAPU32\"]"
    "-sEXPORTED_FUNCTIONS=[\"_tf_music_core_api_version\",\"_tf_music_core_abi_version\",\"_tf_music_core_schema_version\",\"_tf_music_core_corpus_version\",\"_tf_music_core_call\",\"_tf_music_core_buffer_free\",\"_malloc\",\"_free\"]")
endif()

add_executable(music_core_legacy_policies_contract test/legacy-policies.cpp)
target_link_libraries(music_core_legacy_policies_contract PRIVATE tuneforge_music_policies)
