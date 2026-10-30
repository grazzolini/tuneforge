#include "legacy_policies.hpp"
#include "json-protocol.hpp"
#include <iostream>

int main() {
  if (tuneforge::legacy_policy(tuneforge::J{{"operation", "not-a-policy"}}))
    return 1;
  auto invalid = tuneforge::legacy_policy(tuneforge::J{{"operation", "nativeParseChord"}, {"input", "mystery"}});
  if (!invalid || !invalid->null())
    return 1;
  std::string line;
  while (std::getline(std::cin, line)) {
    try {
      auto result = tuneforge::legacy_policy(tuneforge::parse_json(line));
      std::cout << (result ? result->dump() : "null") << '\n';
    } catch (const std::exception &error) {
      std::cout << tuneforge::J{{"error", error.what()}}.dump() << '\n';
    }
  }
}
