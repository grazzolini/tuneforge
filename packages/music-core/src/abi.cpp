#include "core.hpp"
#include "json.hpp"
#include "schema.hpp"
#include "tuneforge/music_core.h"
#include <cstdlib>
#include <cstring>
#include <new>

namespace {
#ifdef TUNEFORGE_MUSIC_TEST_ALLOCATOR
bool fail_next_allocation = false;
#endif
TfMusicStatus respond(TfMusicBuffer *output, const std::string &text,
                      TfMusicStatus status) noexcept {
  uint8_t *memory = nullptr;
#ifdef TUNEFORGE_MUSIC_TEST_ALLOCATOR
  if (fail_next_allocation)
    fail_next_allocation = false;
  else
#endif
    memory = static_cast<uint8_t *>(std::malloc(text.size() + 1));
  if (!memory)
    return TF_MUSIC_OUT_OF_MEMORY;
  std::memcpy(memory, text.data(), text.size());
  memory[text.size()] = 0;
  output->data = memory;
  output->length = text.size();
  return status;
}
} // namespace

extern "C" {
#ifdef TUNEFORGE_MUSIC_TEST_ALLOCATOR
void tf_music_core_test_fail_next_allocation() noexcept {
  fail_next_allocation = true;
}
#endif
uint32_t tf_music_core_api_version() noexcept { return 1; }
uint32_t tf_music_core_abi_version() noexcept { return 1; }
uint32_t tf_music_core_schema_version() noexcept { return 1; }
uint32_t tf_music_core_corpus_version() noexcept { return 1; }

TfMusicStatus tf_music_core_call(const uint8_t *request, size_t request_length,
                                 TfMusicBuffer *output) noexcept {
  if (!output)
    return TF_MUSIC_INVALID_ARGUMENT;
  *output = {nullptr, 0};
  if (!request)
    return TF_MUSIC_INVALID_ARGUMENT;
  try {
    tuneforge::J value;
    try {
      value = tuneforge::parse_json(
          std::string(reinterpret_cast<const char *>(request), request_length));
    } catch (const std::bad_alloc &) {
      return TF_MUSIC_OUT_OF_MEMORY;
    } catch (...) {
      return respond(output,
                     "{\"apiVersion\":1,\"schemaVersion\":1,\"error\":{"
                     "\"code\":\"invalid-json\"}}",
                     TF_MUSIC_INVALID_JSON);
    }
    try {
      if (!tuneforge::matches_schema(
              value, tuneforge::operation_schema()["oneOf"].a()[0]))
        return respond(output,
                       "{\"apiVersion\":1,\"schemaVersion\":1,\"error\":{"
                       "\"code\":\"invalid-argument\"}}",
                       TF_MUSIC_INVALID_ARGUMENT);
      const tuneforge::J response{{"apiVersion", 1},
                                  {"schemaVersion", 1},
                                  {"operation", value["operation"]},
                                  {"result", tuneforge::run(value)}};
      if (!tuneforge::matches_schema(
              response, tuneforge::operation_schema()["oneOf"].a()[1]))
        return respond(output,
                       "{\"apiVersion\":1,\"schemaVersion\":1,\"error\":{"
                       "\"code\":\"invalid-music-operation\"}}",
                       TF_MUSIC_OPERATION_FAILED);
      return respond(output, response.dump(), TF_MUSIC_OK);
    } catch (const std::bad_alloc &) {
      return TF_MUSIC_OUT_OF_MEMORY;
    } catch (...) {
      return respond(output,
                     "{\"apiVersion\":1,\"schemaVersion\":1,\"error\":{"
                     "\"code\":\"invalid-music-operation\"}}",
                     TF_MUSIC_OPERATION_FAILED);
    }
  } catch (...) {
    return TF_MUSIC_OUT_OF_MEMORY;
  }
}
void tf_music_core_buffer_free(TfMusicBuffer *buffer) noexcept {
  if (!buffer)
    return;
  std::free(buffer->data);
  *buffer = {nullptr, 0};
}
}
