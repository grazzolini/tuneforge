#pragma once
#include "value.hpp"
#include <algorithm>
#include <gingo/chord.hpp>
#include <optional>
#include <set>

namespace tuneforge {
inline int pc(double n) {
  return static_cast<int>(std::fmod(std::fmod(n, 12.0) + 12.0, 12.0));
}
struct Tone {
  std::string degree, name;
  int interval = 0, pitch = 0;
};
struct Chord {
  std::string raw, root, quality, bass, bass_degree, label, bass_name;
  int pitch = 0, bass_pitch = -1;
  std::vector<Tone> tones;
};
struct Context {
  J key, preferred_region;
  int current = -1;
};
const J &knowledge();
J profiles();
J seeds();
std::string suffix(const std::string &quality);
const J &quality_definition(const std::string &quality);
std::vector<std::string> qualities(bool dictionary_only = false);
std::string canonical_quality(const std::string &input);
std::string native_suffix(const std::string &quality);
std::string format_pc(double pitch, const J &options = {});
J pitch(double midi, const J &options = {});
J named_pitch(double midi, const std::string &name, const J &options = {});
J parse_pitch(const std::string &value);
std::optional<Chord> parse_chord(const std::string &input);
std::optional<Chord> parse_input(const J &input);
Chord spell(Chord chord, const J &options = {});
Chord transpose_chord(Chord chord, double delta);
J spelling(const Chord &chord);
J chord_options(const Chord &chord, J options = {});
Context context(const J &input);
std::string slug(const std::string &input);
std::string inversion_name(int inversion, bool accordion = false);
int anchor(int pitch, int low = 48, int high = 72);
J guitar(const J &input, const J &context, const J &options = {},
         const J &profile = {});
J keyboard(const J &input, const J &context, const J &options, bool accordion);
J stradella(const Chord &chord, const J &options);
J visible_board(const Chord &chord, int region, int current, const J &selected,
                const J &options);
J run(const J &request);
} // namespace tuneforge
