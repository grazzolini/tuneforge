#include "core.hpp"
#include <gingo/piano.hpp>
#include <limits>

namespace tuneforge {
struct KeyboardCandidate {
  int inversion;
  std::vector<int> midis;
  double score;
  std::string key, id;
};
static std::string midi_key(const std::vector<int> &midis) {
  std::string key;
  for (int midi : midis) {
    if (!key.empty())
      key += '-';
    key += std::to_string(midi);
  }
  return key;
}
J keyboard(const J &input, const J &raw_context, const J &requested,
           bool accordion) {
  auto parsed = parse_input(input);
  if (!parsed || !flag(quality_definition(parsed->quality), "dictionarySupported"))
    return J::array();
  const auto resolved = context(raw_context);
  auto options = chord_options(*parsed, requested);
  if (requested["activeKey"].null() && !resolved.key.null())
    options["activeKey"] = resolved.key;
  const auto chord = spell(*parsed, options);
  const auto profile = profiles()[accordion ? "accordion" : "piano"];
  const int low = num(profile["keyboard"]["lowestPitch"], "midi"),
            high = num(profile["keyboard"]["highestPitch"], "midi");
  const int region = !resolved.key.null() ? pc(resolved.key["pitchClass"].d()) : chord.pitch;
  const auto &explicit_center = resolved.preferred_region["centerMidi"];
  if (!resolved.preferred_region.null() &&
      (!explicit_center.number() || std::floor(explicit_center.d()) != explicit_center.d() ||
       explicit_center.d() < low || explicit_center.d() > high))
    throw std::invalid_argument("preferred-treble-region-out-of-range");
  const int target = explicit_center.number() ? explicit_center.n() : anchor(region, low, high);
  int bass_inversion = -1;
  if (!accordion && chord.bass_pitch >= 0) {
    for (std::size_t i = 0; i < chord.tones.size(); ++i)
      if (chord.tones[i].pitch == chord.bass_pitch)
        bass_inversion = int(i);
    if (bass_inversion < 0)
      return J::array();
  }
  const gingo::Piano piano(88);
  const gingo::Chord native(chord.root + native_suffix(chord.quality));
  std::vector<KeyboardCandidate> candidates;
  for (int octave = -1; octave <= 9; ++octave) {
    auto base = piano.voicing(native, octave, gingo::VoicingStyle::Close);
    if (base.keys.size() != chord.tones.size())
      continue;
    std::vector<int> midis;
    for (const auto &key : base.keys)
      midis.push_back(key.midi);
    for (int inversion = 0; inversion < int(chord.tones.size()); ++inversion) {
      if (midis.front() >= low && midis.back() <= high &&
          (accordion || bass_inversion < 0 || inversion == bass_inversion)) {
        double sum = 0;
        for (int midi : midis) sum += midi;
        // Stateless nearby register preference; stable cyclic inversions break ties.
        const double score = std::abs(sum / midis.size() - target);
        auto key = midi_key(midis);
        candidates.push_back(KeyboardCandidate{
            inversion, midis, score, key,
            "rh-" + slug(inversion_name(inversion, true)) + "-" + key});
      }
      int first = midis.front();
      midis.erase(midis.begin());
      midis.push_back(first + 12);
    }
  }
  if (!accordion) {
    std::map<int, KeyboardCandidate> best;
    for (const auto &candidate : candidates) {
      auto it = best.find(candidate.inversion);
      if (it == best.end() || candidate.score < it->second.score)
        best.insert_or_assign(candidate.inversion, candidate);
    }
    candidates.clear();
    for (const auto &entry : best)
      candidates.push_back(entry.second);
  }
  std::sort(candidates.begin(), candidates.end(),
            [&](const KeyboardCandidate &a, const KeyboardCandidate &b) {
              if (a.score != b.score)
                return a.score < b.score;
              if (a.inversion != b.inversion) return a.inversion < b.inversion;
              return a.key < b.key;
            });
  if (candidates.size() > (accordion ? 6u : 8u))
    candidates.resize(accordion ? 6u : 8u);
  const auto left = accordion ? stradella(chord, options) : J::array();
  const auto selected = left.a().empty() ? J() : left.a().front();
  const auto visible =
      accordion
          ? visible_board(chord, region, resolved.current, selected, options)
          : J::array();
  std::map<int, int> occurrences;
  J::Array result;
  for (const auto &candidate : candidates) {
    J::Array notes;
    const auto inversion = candidate.inversion;
    for (std::size_t i = 0; i < candidate.midis.size(); ++i) {
      const int midi = candidate.midis[i];
      const auto &tone =
          chord.tones[(i + std::size_t(inversion)) % chord.tones.size()];
      auto p = named_pitch(midi, tone.name, options);
      J note{{"id", (accordion ? "accordion-rh-" : "piano-note-") +
                        std::to_string(i) + "-" + std::to_string(midi)},
             {"pitch", p},
             {"note", p["label"]},
             {"degree", tone.degree}};
      if (accordion) {
        note["hand"] = "right";
        note["side"] = "treble";
      } else
        note["handHint"] = midi < 60 ? "left" : "right";
      notes.push_back(note);
    }
    J region_root{{"pitchClass", region}, {"note", format_pc(region, options)}, {"centerMidi", target}};
    if (accordion) {
      const int occurrence = occurrences[inversion]++;
      const auto inv = inversion_name(inversion, true);
      const auto register_label =
          occurrence == 0 ? ""
          : occurrence == 1
              ? "octave "
              : std::to_string(occurrence + 1) +
                    (occurrence + 1 == 3 ? "rd octave " : "th octave ");
      const auto id =
          "accordion-" + slug(chord.label) + "-rh-" + slug(inv) +
          (occurrence == 0 ? "" : "-octave-" + std::to_string(occurrence + 1)) +
          "-" + candidate.key;
      result.push_back(
          J{{"id", id},
            {"label", chord.label + " " + register_label + inv},
            {"chordLabel", chord.label},
            {"rank", int(result.size()) + num(selected, "rank", 1000)},
            {"rightHandNotes", notes},
            {"inversion", J{{"index", inversion}, {"label", inv}, {"bassDegree", notes.front()["degree"]}, {"isRootPosition", inversion == 0}}},
            {"combinedCoverage", J{{"complete", true}, {"missingTones", J::array()}}},
            {"leftHandCandidates", left},
            {"selectedLeftHandCandidate", selected},
            {"visibleStradellaButtons", visible},
            {"regionRoot", region_root}});
    } else {
      const auto inv = inversion_name(inversion);
      J inv_metadata{{"index", inversion},
                     {"label", inv},
                     {"bassDegree", notes.front()["degree"]},
                     {"isRootPosition", inversion == 0}};
      result.push_back(J{{"id", "piano-" + slug(chord.label) + "-" + slug(inv) +
                                    "-" + candidate.key},
                         {"label", chord.label + " " + inv},
                         {"chordLabel", chord.label},
                         {"rank", int(result.size() + 1)},
                         {"notes", notes},
                         {"inversion", inv_metadata},
                         {"regionRoot", region_root}});
    }
  }
  return result;
}
} // namespace tuneforge
