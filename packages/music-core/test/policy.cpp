#include "core.hpp"
#include "json-protocol.hpp"
#include <iostream>

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    try {
      const auto request = tuneforge::parse_json(line);
      tuneforge::J result;
      if (tuneforge::str(request, "operation") == "native-input") {
        auto chord = tuneforge::parse_chord(tuneforge::str(request, "input"));
        if (!chord)
          throw std::invalid_argument("invalid-native-test-input");
        result = tuneforge::J{
            {"label", chord->root + tuneforge::native_suffix(chord->quality)},
            {"bass", chord->bass_pitch}};
      } else if (tuneforge::str(request, "operation") == "oracle-chord") {
        const std::map<std::string, std::string> aliases{
            {"maj", "M"},       {"min", "m"},       {"min7", "m7"},
            {"maj7", "7M"},     {"maj6", "6"},      {"min6", "m6"},
            {"minmaj7", "mM7"}, {"hdim7", "m7(b5)"}};
        const auto quality = tuneforge::str(request, "input");
        auto it = aliases.find(quality);
        tuneforge::J::Array pitches;
        for (const auto &note :
             gingo::Chord("C" + (it == aliases.end() ? quality : it->second))
                 .notes())
          pitches.emplace_back(note.semitone());
        result = pitches;
      } else
        result = tuneforge::run(request);
      std::cout << result.dump() << '\n';
    } catch (const std::exception &error) {
      std::cout << tuneforge::J{{"error", error.what()}}.dump() << '\n';
    }
  }
}
