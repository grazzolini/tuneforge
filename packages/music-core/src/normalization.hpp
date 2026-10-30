#pragma once

#include "value.hpp"

namespace tuneforge {
std::string trim_js(const std::string &text);
std::string compact_js(const std::string &text);
J normalizeInstrumentKnowledgeBundle(const J &input);
J normalizeObservedGuitarGzipVoicingSeeds(const J &input,
                                          const J &options = J::Object{});
} // namespace tuneforge
