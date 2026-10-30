#include "core.hpp"
#include <gingo/fretboard.hpp>
#include <limits>

namespace tuneforge {
static std::string degree(const Chord &chord, int pitch_class) {
  for (const auto &tone : chord.tones)
    if (tone.pitch == pitch_class)
      return tone.degree;
  if (chord.bass_pitch == pitch_class) {
    if (!chord.bass_degree.empty())
      return chord.bass_degree;
    static const std::string degrees[]{"1",  "b2", "2",  "b3", "3",  "4",
                                       "b5", "5",  "#5", "6",  "b7", "7"};
    return degrees[pc(pitch_class - chord.pitch)];
  }
  return "";
}
J guitar(const J &input, const J &context, const J &requested,
         const J &custom_profile) {
  const auto parsed = parse_input(input);
  if (!parsed || !flag(quality_definition(parsed->quality), "dictionarySupported"))
    return J::array();
  const auto profile =
      custom_profile.null() ? profiles()["guitar"] : custom_profile;
  const double raw_capo =
      flag(context, "useCapoShapes") &&
              flag(context, "canCapo", flag(profile, "canCapo")) &&
              context["capoFret"].number()
          ? std::max(0.0, std::trunc(context["capoFret"].d()))
          : 0;
  if (raw_capo >= num(profile, "frets"))
    return J::array();
  const int capo = static_cast<int>(raw_capo);
  auto chord = transpose_chord(*parsed, context["transposeSemitones"].number()
                                            ? context["transposeSemitones"].d()
                                            : 0);
  auto shape = transpose_chord(chord, -capo);
  auto options = chord_options(chord, requested);
  if (requested["activeKey"].null() && !context["sourceKey"].null())
    options["activeKey"] = context["sourceKey"];
  chord = spell(chord, options);
  shape = spell(shape, options);
  std::vector<int> tuning(6);
  std::set<int> seen_strings;
  if (!std::holds_alternative<J::Array>(profile["tuning"].value) ||
      profile["tuning"].a().size() != tuning.size())
    throw std::invalid_argument("unsupported-guitar-tuning");
  for (const auto &string : profile["tuning"].a()) {
    const auto &ordinal = string["string"];
    if (!ordinal.number() || std::floor(ordinal.d()) != ordinal.d() ||
        ordinal.d() < 1 || ordinal.d() > 6)
      throw std::invalid_argument("unsupported-guitar-string");
    const int index = ordinal.n();
    if (!seen_strings.insert(index).second)
      throw std::invalid_argument("duplicate-guitar-string");
    tuning[std::size_t(index - 1)] = num(string["openPitch"], "midi");
  }
  const auto board =
      gingo::Fretboard("guitar", tuning, num(profile, "frets")).capo(capo);
  auto render = [&](const J::Array &positions) -> J {
    J::Array notes, muted;
    std::set<std::string> degrees;
    std::set<int> played;
    int lowest = 10000, bass = -1;
    for (const auto &position : positions) {
      const int string = num(position, "string"), fret = num(position, "fret");
      if (fret < 0 || fret > board.num_frets())
        return J();
      const int midi = board.position(string, fret).midi;
      const auto d = degree(chord, pc(midi));
      if (d.empty())
        return J();
      std::string name = chord.bass_name;
      for (const auto &tone : chord.tones)
        if (tone.pitch == pc(midi)) name = tone.name;
      auto p = named_pitch(midi, name, options);
      J note{{"string", string},
             {"fret", fret},
             {"soundingFret", fret + capo},
             {"degree", d},
             {"note", p["label"]},
             {"pitch", p}};
      if (!position["finger"].null())
        note["finger"] = position["finger"];
      notes.push_back(note);
      degrees.insert(d);
      played.insert(string);
      if (midi < lowest) {
        lowest = midi;
        bass = pc(midi);
      }
    }
    for (const auto &tone : chord.tones)
      if (!degrees.count(tone.degree))
        return J();
    if (chord.bass_pitch >= 0 && bass != chord.bass_pitch)
      return J();
    for (const auto &string : profile["tuning"].a())
      if (!played.count(num(string, "string")))
        muted.push_back(string["string"]);
    return J{{"chordLabel", chord.label},
             {"shapeChordLabel", shape.label},
             {"capoFret", capo},
             {"mutedStrings", muted},
             {"notes", notes}};
  };
  J::Array result;
  // Gingo owns enumeration, pruning, deduplication, and playability ordering.
  // Enumerate before enforcing slash bass, then truncate the valid results.
  std::vector<gingo::Fingering> fingerings;
  try {
    fingerings = board.fingerings(
        gingo::Chord(chord.root + native_suffix(chord.quality)),
        std::numeric_limits<int>::max(), chord.bass_pitch);
  } catch (const std::invalid_argument &) {
    return J::array();
  }
  for (const auto &fingering : fingerings) {
    J::Array positions;
    std::string identity;
    for (const auto &position : fingering.strings) {
      identity += "-" + std::to_string(position.string) + ":" + std::to_string(position.fret);
      if (position.fret >= 0)
        positions.push_back(J{{"string", position.string}, {"fret", position.fret}});
    }
    auto value = render(positions);
    if (value.null()) continue;
    value["id"] = "guitar" + identity + "-capo-" + std::to_string(capo);
    value["label"] = chord.label + " voicing " + std::to_string(result.size() + 1);
    value["source"] = "generated";
    value["rank"] = int(result.size() + 1);
    result.push_back(value);
    if (result.size() == 8) break;
  }
  return result;
}
} // namespace tuneforge
