#include "json.hpp"
#include "tuneforge/music_core.h"
#include <iostream>

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    auto request = tuneforge::parse_json(line);
    request["apiVersion"] = 1;
    request["schemaVersion"] = 1;
    const auto encoded = request.dump();
    TfMusicBuffer buffer{};
    const auto status =
        tf_music_core_call(reinterpret_cast<const uint8_t *>(encoded.data()),
                           encoded.size(), &buffer);
    const std::string text(reinterpret_cast<const char *>(buffer.data),
                           buffer.length);
    tf_music_core_buffer_free(&buffer);
    const auto response = tuneforge::parse_json(text);
    if (status != TF_MUSIC_OK) {
      std::cout << response.dump() << '\n';
      continue;
    }
    if (tuneforge::num(response, "apiVersion") != 1 ||
        tuneforge::num(response, "schemaVersion") != 1 ||
        response["operation"] != request["operation"])
      return 2;
    std::cout << response["result"].dump() << '\n';
  }
}
