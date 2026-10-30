#include "core.hpp"
#include <array>
#include <limits>

namespace tuneforge {
static const J &board_data() {
  return knowledge()["instrumentProfiles"]["accordion"]["buttonBoard"]
                    ["stradella"];
}
static int center_index(int pitch_class) {
  const auto &axis = board_data()["rootAxis"].a();
  double best = std::numeric_limits<double>::infinity();
  int selected = 0;
  for (std::size_t i = 0; i < axis.size(); ++i)
    if (num(axis[i], "pitchClass") == pc(pitch_class)) {
      const double score = (std::max(0, 5 - int(i)) +
                            std::max(0, 5 - int(axis.size() - i - 1))) *
                               100 +
                           std::abs(double(i) - (double(axis.size()) - 1) / 2);
      if (score < best) {
        best = score;
        selected = int(i);
      }
    }
  return selected;
}
static J::Array buttons(const J::Array &axis, const J &options) {
  J::Array out;
  for (const auto &entry : axis)
    for (const auto &row : board_data()["rows"].a()) {
      const auto id = str(row, "id");
      const int root =
          pc(num(entry, "pitchClass") + (id == "counterbass" ? 4 : 0));
      const auto name = format_pc(root, options);
      J::Array classes;
      if (id == "counterbass" || id == "bass")
        classes.push_back(root);
      else {
        const auto quality = id == "major"     ? "major"
                             : id == "minor"   ? "minor"
                             : id == "seventh" ? "7"
                                               : "dim7";
        const auto notes = gingo::Chord(gingo::Note::chromatic()[root] +
                                        native_suffix(quality))
                               .notes();
        for (std::size_t i = 0; i < notes.size(); ++i)
          if (!((id == "seventh" || id == "diminished") && i == 2))
            classes.push_back(notes[i].semitone());
      }
      const auto label = name + (id == "counterbass" ? " counterbass"
                                 : id == "bass"      ? " bass"
                                 : id == "major"     ? "M"
                                 : id == "minor"     ? "m"
                                 : id == "seventh"   ? "7"
                                                     : "dim");
      out.push_back(J{{"id", "accordion-left-" + id + "-" +
                                 std::to_string(num(entry, "column"))},
                      {"side", "bass"},
                      {"rowId", id},
                      {"rowLabel", row["label"]},
                      {"kind", row["kind"]},
                      {"label", label},
                      {"root", name},
                      {"pitchClass", root},
                      {"pitchClasses", classes},
                      {"column", entry["column"]},
                      {"row", num(row, "visualOrder") + 1},
                      {"visualColumn", entry["visualColumn"]},
                      {"visualOrder", row["visualOrder"]},
                      {"visualColumnOffset", row["visualColumnOffset"]},
                      {"visualYOffset", row["visualYOffset"]},
                      {"visualYStep", row["visualYStep"]},
                      {"visualX", entry["visualColumn"].d() +
                                      row["visualColumnOffset"].d()},
                      {"visualY", row["visualYOffset"]}});
    }
  return out;
}
J stradella(const Chord &chord, const J &options) {
  const auto all = buttons(board_data()["rootAxis"].a(), options);
  std::set<int> target;
  for (const auto &tone : chord.tones) target.insert(tone.pitch);
  const int bass_target = chord.bass_pitch >= 0 ? chord.bass_pitch : chord.pitch;
  target.insert(bass_target);
  const std::string standard_row = chord.quality == "major" ? "major" :
      chord.quality == "minor" ? "minor" : chord.quality == "7" ? "seventh" :
      chord.quality == "dim7" ? "diminished" : "";
  J::Array candidates;
  auto append = [&](const J &bass, const J &button) {
    std::set<int> sounding{num(bass, "pitchClass")};
    if (!button.null())
      for (const auto &p : button["pitchClasses"].a()) sounding.insert(p.n());
    std::vector<int> missing, added;
    for (int p : target) if (!sounding.count(p)) missing.push_back(p);
    for (int p : sounding) if (!target.count(p)) added.push_back(p);
    const bool standard = !button.null() && !standard_row.empty() &&
        str(button, "rowId") == standard_row && num(button, "pitchClass") == chord.pitch;
    const bool complete = missing.empty() && added.empty();
    // Keep correct factor combinations. Unsupported buttons fall back to bass + treble.
    if (!button.null() && !standard && !complete) return;
    const auto kind = standard ? "standard" : complete ? "complete" : "approx";
    J::Array missing_names, added_names, tones;
    for (int p : sounding) tones.push_back(p);
    for (int p : missing) {
      auto name = format_pc(p, options);
      for (const auto &tone : chord.tones) if (tone.pitch == p) name = tone.name;
      missing_names.push_back(name);
    }
    for (int p : added) added_names.push_back(format_pc(p, options));
    const int separation = button.null() ? 0 : std::abs(num(button, "column") - num(bass, "column"));
    const int rank = (standard ? 0 : complete ? 100 : 200) + separation;
    const auto label = str(bass, "label") + (button.null() ? " + treble completion" : " + " + str(button, "label"));
    candidates.push_back(J{
        {"id", str(bass, "id") + (button.null() ? "-bass-only" : "-" + str(button, "id"))},
        {"label", label}, {"kind", kind}, {"bassButton", bass}, {"chordButton", button},
        {"soundingPitchClasses", tones}, {"requestedBassMatches", true},
        {"coverageComplete", complete},
        {"fingering", J{{"bass", 4}, {"chord", button.null() ? J() : J(str(button, "rowId") == "major" ? 3 : 2)},
            {"label", button.null() ? "4" : str(button, "rowId") == "major" ? "4-3" : "4-2"}}},
        {"missingTones", missing_names}, {"addedTones", added_names}, {"rank", rank}});
  };
  for (const auto &bass : all) {
    if (str(bass, "kind") != "bass" || num(bass, "pitchClass") != bass_target) continue;
    for (const auto &button : all) if (str(button, "kind") == "chord") append(bass, button);
    append(bass, J());
  }
  std::stable_sort(candidates.begin(), candidates.end(), [](const J &a, const J &b) {
    if (num(a, "rank") != num(b, "rank")) return num(a, "rank") < num(b, "rank");
    return str(a, "id") < str(b, "id");
  });
  std::set<std::string> seen;
  J::Array out;
  for (const auto &candidate : candidates) {
    const auto key = str(candidate["bassButton"], "rowId") + ":" +
        str(candidate["chordButton"], "rowId") + ":" +
        std::to_string(num(candidate["chordButton"], "pitchClass", -1));
    if (seen.insert(key).second) out.push_back(candidate);
    if (out.size() == 16) break;
  }
  return out;
}
J visible_board(const Chord &chord, int region, int current, const J &selected,
                const J &options) {
  const auto &axis = board_data()["rootAxis"].a();
  if (axis.size() <= 11)
    return buttons(axis, options);
  const int center = center_index(region),
            default_start = std::clamp(center - 5, 0, int(axis.size()) - 11);
  int start = default_start, best = std::numeric_limits<int>::max();
  std::set<int> columns;
  if (!selected.null()) {
    columns.insert(num(selected["bassButton"], "column"));
    if (!selected["chordButton"].null())
      columns.insert(num(selected["chordButton"], "column"));
  }
  const int required_pitch = current >= 0 ? current : chord.pitch;
  for (int candidate = 0; candidate <= int(axis.size()) - 11; ++candidate) {
    bool has_pitch = false;
    std::set<int> present;
    for (int i = candidate; i < candidate + 11; ++i) {
      const auto &entry = axis[std::size_t(i)];
      if (num(entry, "pitchClass") == pc(required_pitch))
        has_pitch = true;
      present.insert(num(entry, "column"));
    }
    int missing = has_pitch ? 0 : 1;
    for (int column : columns)
      if (!present.count(column))
        ++missing;
    const int center_penalty =
        center >= candidate && center < candidate + 11
            ? 0
            : std::min(std::abs(center - candidate),
                       std::abs(center - candidate - 10));
    const int score = missing * 10000 + center_penalty * 1000 +
                      std::abs(candidate - default_start);
    if (score < best) {
      best = score;
      start = candidate;
    }
  }
  return buttons(J::Array(axis.begin() + start, axis.begin() + start + 11),
                 options);
}
} // namespace tuneforge
