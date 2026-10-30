#include "core.hpp"
#include "json.hpp"
#include "schema.hpp"
#include "tuneforge/music_core.h"
#include <cassert>
#include <iostream>
#include <string>

extern "C" void tf_music_core_test_fail_next_allocation() noexcept;

static TfMusicStatus call(const std::string &request, TfMusicBuffer &buffer) {
  return tf_music_core_call(reinterpret_cast<const uint8_t *>(request.data()),
                            request.size(), &buffer);
}
int main() {
  assert(tf_music_core_api_version() == 1);
  assert(tf_music_core_abi_version() == 1);
  assert(tf_music_core_schema_version() == 1);
  assert(tf_music_core_corpus_version() == 1);
  TfMusicBuffer buffer{};
  assert(tf_music_core_call(nullptr, 0, &buffer) == TF_MUSIC_INVALID_ARGUMENT);
  assert(buffer.data == nullptr && buffer.length == 0);
  assert(tf_music_core_call(nullptr, 0, nullptr) == TF_MUSIC_INVALID_ARGUMENT);
  tf_music_core_buffer_free(nullptr);
  tf_music_core_buffer_free(&buffer);
  const std::string request = "{\"apiVersion\":1,\"schemaVersion\":1,"
                              "\"operation\":\"spell\",\"input\":\"Cdim7\"}";
  for (int i = 0; i < 1000; ++i) {
    assert(call(request, buffer) == TF_MUSIC_OK);
    assert(buffer.data && buffer.length > 0 && buffer.data[buffer.length] == 0);
    const auto response = tuneforge::parse_json(std::string(
        reinterpret_cast<const char *>(buffer.data), buffer.length));
    assert(tuneforge::str(response["result"], "label") == "Cdim7");
    tf_music_core_buffer_free(&buffer);
    assert(buffer.data == nullptr && buffer.length == 0);
    tf_music_core_buffer_free(&buffer);
  }
  tf_music_core_test_fail_next_allocation();
  assert(call(request, buffer) == TF_MUSIC_OUT_OF_MEMORY);
  assert(buffer.data == nullptr && buffer.length == 0);
  assert(call(request, buffer) == TF_MUSIC_OK);
  tf_music_core_buffer_free(&buffer);
  const std::string invalid_requests[]{
      "{}",
      "[]",
      "null",
      "{\"apiVersion\":2,\"schemaVersion\":1,\"operation\":\"profiles\"}",
      "{\"apiVersion\":1,\"schemaVersion\":1,\"operation\":\"unknown\"}",
      "{\"apiVersion\":1,\"schemaVersion\":1,\"operation\":\"spell\",\"input\":"
      "7}",
      "{\"apiVersion\":1,\"schemaVersion\":1,\"operation\":\"profiles\","
      "\"unexpected\":true}"};
  for (const auto &text : invalid_requests) {
    assert(call(text, buffer) == TF_MUSIC_INVALID_ARGUMENT);
    tf_music_core_buffer_free(&buffer);
  }
  const std::string invalid_json[]{"",
                                   "{",
                                   "[1,]",
                                   "{\"x\":1,}",
                                   "{} true",
                                   "01",
                                   "+1",
                                   "1.",
                                   ".1",
                                   "1e",
                                   "NaN",
                                   "Infinity",
                                   "1e309",
                                   "{\"x\":null,\"x\":1}",
                                   "\"\\uD800\"",
                                   "\"\\uDC00\"",
                                   "\"\\uD800\\u0041\"",
                                   "\"\\x00\"",
                                   std::string("\"\1\"", 3),
                                   std::string("\"\xC0\x80\"", 4),
                                   std::string(66, '[') + "0" +
                                       std::string(66, ']')};
  for (const auto &text : invalid_json) {
    assert(call(text, buffer) == TF_MUSIC_INVALID_JSON);
    tf_music_core_buffer_free(&buffer);
  }
  const auto unicode = tuneforge::parse_json(
      "\"\\u0041\\u0000\\n\\t\\r\\b\\f\\\"\\\\\\/\\uD834\\uDD1E\"");
  assert(unicode.s() ==
         std::string("A\0\n\t\r\b\f\"\\/", 10) + "\xF0\x9D\x84\x9E");
  assert(tuneforge::parse_json(unicode.dump()) == unicode);
  assert(tuneforge::parse_json("-1.25e+2").d() == -125);
  assert(tuneforge::parse_json("-0").dump() == "0");
  auto bad_profile_request = tuneforge::J{{"apiVersion", 1},
                                          {"schemaVersion", 1},
                                          {"operation", "guitar"},
                                          {"input", "C"}};
  const auto native_profiles =
      tuneforge::run(tuneforge::J{{"operation", "profiles"}});
  for (int ordinal : {-1, 0, 7, 2147483647}) {
    auto profile = native_profiles["guitar"];
    profile["tuning"].a()[0]["string"] = ordinal;
    bad_profile_request["profile"] = profile;
    assert(call(bad_profile_request.dump(), buffer) ==
           TF_MUSIC_OPERATION_FAILED);
    tf_music_core_buffer_free(&buffer);
  }
  {
    auto profile = native_profiles["guitar"];
    profile["tuning"].a()[0]["string"] = 5;
    bad_profile_request["profile"] = profile;
    assert(call(bad_profile_request.dump(), buffer) ==
           TF_MUSIC_OPERATION_FAILED);
    tf_music_core_buffer_free(&buffer);
    profile = native_profiles["guitar"];
    profile["tuning"].a().pop_back();
    bad_profile_request["profile"] = profile;
    assert(call(bad_profile_request.dump(), buffer) ==
           TF_MUSIC_OPERATION_FAILED);
    tf_music_core_buffer_free(&buffer);
  }
  // A malformed physical tuning remains a genuine operation exception;
  // structured chord spelling now canonicalizes its native search root.
  const std::string exceptional = bad_profile_request.dump();
  assert(call(exceptional, buffer) == TF_MUSIC_OPERATION_FAILED);
  tf_music_core_buffer_free(&buffer);
  (void)tuneforge::operation_schema();
  bool unsupported = false;
  try {
    tuneforge::require_schema_vocabulary(
        tuneforge::J{{"unimplementedKeyword", true}});
  } catch (const std::invalid_argument &) {
    unsupported = true;
  }
  assert(unsupported);
  std::cout << "C ABI: versions, grammar, Unicode, finite numbers, exceptions, "
               "allocation failure, 1000 calls/free PASS\n";
}
