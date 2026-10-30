#include "normalization.hpp"
#include "json-protocol.hpp"
#include <iostream>

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    auto request = tuneforge::parse_json(line);
    auto result =
        request["operation"].s() == "normalizeBundle"
            ? tuneforge::normalizeInstrumentKnowledgeBundle(request["input"])
            : tuneforge::normalizeObservedGuitarGzipVoicingSeeds(
                  request["input"], request["options"]);
    std::cout << result.dump() << '\n';
  }
}
