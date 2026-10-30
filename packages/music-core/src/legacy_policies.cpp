#include "legacy_policies.hpp"
#include "normalization.hpp"

#include <cctype>
#include <gingo/note.hpp>
#include <iomanip>
#include <locale>
#include <regex>
#include <sstream>

namespace tuneforge {
namespace {
const std::vector<std::string> degrees{"1",  "b2", "2",  "b3", "3",  "4",
                                       "b5", "5",  "b6", "6",  "b7", "7"};
std::string lower(std::string value) {
  for (auto &c : value)
    if (c >= 'A' && c <= 'Z')
      c += 'a' - 'A';
  return value;
}
std::string upper(std::string value) {
  for (auto &c : value)
    if (c >= 'a' && c <= 'z')
      c -= 'a' - 'A';
  return value;
}
bool contains(const std::vector<std::string> &values,
              const std::string &value) {
  return std::find(values.begin(), values.end(), value) != values.end();
}
bool integer(const J &value) { return value.as_i64().has_value(); }
bool pythonInteger(const J &value) {
  return value.integer_kind() || std::holds_alternative<bool>(value.value);
}
int modulo(const J &value) {
  if (value.integer_kind() && !value.numeric_token.empty()) {
    int result = 0;
    for (char c : value.numeric_token)
      if (c >= '0' && c <= '9')
        result = (result * 10 + c - '0') % 12;
    return !value.numeric_token.empty() && value.numeric_token[0] == '-'
               ? pc(-result)
               : result;
  }
  return std::holds_alternative<bool>(value.value)
             ? int(value.b())
             : int(std::fmod(std::fmod(value.d(), 12) + 12, 12));
}

std::string trim(const std::string &value, bool = false) { return trim_js(value); }
J notePitch(const std::string &value, bool sharpOnly = false) {
  auto note = upper(value);
  static const std::vector<std::string> names{
      "C",  "B#", "C#", "DB", "D",  "D#", "EB", "E",  "FB", "F", "E#",
      "F#", "GB", "G",  "G#", "AB", "A",  "A#", "BB", "B",  "CB"};
  if (sharpOnly) {
    for (int i = 0; i < 12; ++i)
      if (format_pc(i, J{{"mode", "sharps"}}) == value)
        return i;
    return nullptr;
  }
  if (!contains(names, note))
    return nullptr;
  if (note.size() == 2 && note[1] == 'B')
    note[1] = 'b';
  return gingo::Note(note).semitone();
}
J degreePitch(int root, const std::string &degree, bool native) {
  (void)native;
  static const std::regex valid("^(?:#|b|bb)?[1-7]$");
  if (!std::regex_match(degree, valid))
    return nullptr;
  static const int natural[]{0, 2, 4, 5, 7, 9, 11};
  const int alteration = degree[0] == '#' ? 1 : degree[0] == 'b' ? -(int(degree.size()) - 1) : 0;
  return pc(root + natural[degree.back() - '1'] + alteration);
}
J qualitySuffix(const std::string &quality, bool = false) {
  auto canonical = canonical_quality(quality);
  if (canonical.empty()) return quality == "no_chord" ? J("") : J();
  return suffix(canonical);
}
J qualityIntervals(const std::string &quality) {
  auto canonical = canonical_quality(quality);
  if (canonical.empty()) return nullptr;
  J result = J::array();
  for (const auto &tone : quality_definition(canonical)["tones"].a())
    result.a().push_back(tone["interval"]);
  return result;
}
J normalizeQuality(const J &input) {
  if (input.null()) return "major";
  const auto canonical = canonical_quality(input.s());
  return canonical.empty() ? J() : J(canonical);
}
std::string pythonFormat(const J &root, const J &quality, const J &bass) {
  if (root.null()) return quality.string() && quality.s() == "no_chord" ? "N.C." : "X";
  if (!quality.string()) return "X";
  auto ending = qualitySuffix(quality.s());
  if (ending.null()) return "X";
  auto label = format_pc(modulo(root), J{{"mode", "sharps"}}) + ending.s();
  if (!bass.null() && modulo(bass) != modulo(root))
    label += "/" + format_pc(modulo(bass), J{{"mode", "sharps"}});
  return label;
}
J backendParse(const std::string &raw) {
  const auto text = compact_js(raw);
  const bool no_chord = contains({"N", "NC", "N.C.", "NO_CHORD", "NO-CHORD"}, upper(text));
  const auto chord = no_chord ? std::nullopt : parse_chord(raw);
  return J{{"raw_label", raw},
      {"root_pitch_class", chord ? J(chord->pitch) : J()},
      {"quality", chord ? J(chord->quality) : no_chord ? J("no_chord") : J()},
      {"bass_pitch_class", chord && chord->bass_pitch >= 0 ? J(chord->bass_pitch) : J()},
      {"bass_degree", chord && !chord->bass_degree.empty() ? J(chord->bass_degree) : J()},
      {"display_label", chord ? pythonFormat(chord->pitch, chord->quality, chord->bass_pitch < 0 ? J() : J(chord->bass_pitch)) : no_chord ? "N.C." : trim_js(raw)},
      {"is_no_chord", no_chord}, {"is_unknown", !chord && !no_chord}};
}
J parseKey(const J &input, bool backend) {
  if (!input.string())
    return nullptr;
  auto normalized = trim(input.s(), backend);

  std::smatch match;
  std::string mode = "major";
  J root;
  if (backend) {
    if (std::regex_match(normalized, match,
                         std::regex("^([0-9]+):(major|m(?:i|İ|ı)nor)$",
                                    std::regex::icase))) {
      auto value = std::strtod(match[1].str().c_str(), nullptr);
      if (value < 0 || value > 11)
        return nullptr;
      root = int(value);
      mode = lower(match[2]);
    } else {
      if (!std::regex_match(
              normalized, match,
              std::regex(
                  "^([A-Ga-g](?:#|b)?)[\\t\\n\\v\\f\\r ]*(major|minor|m)?$")))
        return nullptr;
      root = notePitch(match[1]);
      if (match[2] == "minor" || match[2] == "m")
        mode = "minor";
    }
  } else return parseKey(input, true);
  return root.null() ? J() : J{{"pitch_class", root}, {"mode", mode}};
}
std::string spellingMode(const J &context) {
  auto mode = str(context, "display_mode");
  if (mode != "auto")
    return contains({"sharps", "flats", "dual"}, mode) ? mode : "neutral";
  const auto &key = context["active_key"];
  if (!pythonInteger(key["pitch_class"]))
    return "neutral";
  J options{
      {"mode", "auto"},
      {"activeKey",
       J{{"pitchClass", modulo(key["pitch_class"])},
         {"mode", str(key, "mode", "major") == "minor" ? "minor" : "major"}}}};
  const auto probe = format_pc(1, options);
  return probe == "Db"                   ? "flats"
         : format_pc(3, options) == "D#" ? "sharps"
                                         : "neutral";
}
J nativeFormat(int root, const std::string &quality, const J &bass,
               const std::string &mode, bool literal = false) {
  auto ending = literal ? J(quality) : qualitySuffix(quality);
  if (ending.null())
    return nullptr;
  auto label = format_pc(root, J{{"mode", mode}}) + ending.s();
  if (!bass.null() && modulo(bass) != pc(root))
    label += "/" + format_pc(modulo(bass), J{{"mode", mode}});
  return label;
}
J nativeParse(const std::string &input) {
  const auto chord = parse_chord(input);
  if (!chord) return nullptr;
  return J{{"root_pitch_class", chord->pitch}, {"quality", chord->quality},
      {"bass_pitch_class", chord->bass_pitch < 0 ? J() : J(chord->bass_pitch)}};
}
J cremaParse(const std::string &raw) {
  if (raw == "N" || raw == "X") return J{{"kind", raw == "N" ? "no_chord" : "unknown"}};
  const auto chord = parse_chord(raw);
  if (!chord) return J{{"kind", "unknown"}};
  const auto slash = raw.find('/'), colon = raw.find(':');
  return J{{"kind", "chord"}, {"root_pitch_class", chord->pitch}, {"quality", chord->quality},
      {"suffix", suffix(chord->quality)},
      {"bass_degree", chord->bass_degree.empty() ? J() : J(chord->bass_degree)},
      {"bass_pitch_class", chord->bass_pitch < 0 ? J() : J(chord->bass_pitch)},
      {"raw_quality_range", colon == std::string::npos ? J() : J::array({J(colon + 1), J(slash == std::string::npos ? raw.size() : slash)})},
      {"bass_degree_range", slash == std::string::npos ? J() : J::array({J(slash + 1), J(raw.size())})}};
}
J addInteger(const J &value, int offset) {
  if (!offset)
    return value;
  auto digits = value.numeric_token.empty() ? std::to_string(value.n())
                                            : value.numeric_token;
  bool negative = !digits.empty() && digits[0] == '-';
  if (negative)
    digits.erase(0, 1);
  int direction = offset < 0 ? -1 : 1;
  for (int iteration = 0; iteration < std::abs(offset); ++iteration) {
    if (digits == "0") {
      digits = "1";
      negative = direction < 0;
      continue;
    }
    bool increase = negative ? direction < 0 : direction > 0;
    for (std::size_t i = digits.size(); i > 0;) {
      auto &digit = digits[--i];
      if (increase ? digit != '9' : digit != '0') {
        digit += increase ? 1 : -1;
        break;
      }
      digit = increase ? '0' : '9';
      if (i == 0 && increase)
        digits.insert(0, "1");
    }
    auto first = digits.find_first_not_of('0');
    digits = first == std::string::npos ? "0" : digits.substr(first);
  }
  auto token = negative && digits != "0" ? "-" + digits : digits;
  J result(std::strtod(token.c_str(), nullptr));
  result.integer_token_kind = true;
  result.numeric_token = token;
  return result;
}

J documentContext(const J &request, bool backend) {
  auto detected = parseKey(request["detected_key"], backend),
       overridden = parseKey(request["override_key"], backend);
  const auto &audio = request["audio_set"];
  const auto &transpose = audio["metadata"]["transpose"]["semitones"];
  J delta = (backend ? transpose.integer_kind() : integer(transpose)) &&
                    (!backend || str(audio, "type") == "preview_mix")
                ? transpose
                : J(0);
  int correction =
      detected.null() || overridden.null()
          ? 0
          : pc(overridden["pitch_class"].n() - detected["pitch_class"].n());
  if (correction > 6)
    correction -= 12;
  auto active = overridden.null() ? detected : overridden;
  if (!active.null())
    active["pitch_class"] = pc(active["pitch_class"].n() + modulo(delta));
  return J{{"transpose_semitones", addInteger(delta, correction)},
           {"active_key", active},
           {"display_mode", request["display_mode"]}};
}
J formatTransposed(int root, const std::string &quality, const J &bass,
                   const J &context) {
  const int delta = modulo(context["transpose_semitones"]);
  J shiftedBass = bass.null() ? J() : J(pc(modulo(bass) + delta));
  root = pc(root + delta);
  auto mode = spellingMode(context);
  if (mode == "dual") {
    auto sharp = nativeFormat(root, quality, shiftedBass, "sharps");
    auto flat = nativeFormat(root, quality, shiftedBass, "flats");
    if (sharp.null())
      return nullptr;
    return sharp == flat ? sharp : J(sharp.s() + " / " + flat.s());
  }
  return nativeFormat(root, quality, shiftedBass, mode);
}
std::string segmentLabel(const J &segment) {
  if (segment["display_label"].string() &&
      !trim(segment["display_label"].s()).empty())
    return trim(segment["display_label"].s());
  return trim(str(segment, "label"));
}
J displaySegment(const J &segment, const J &context, bool backend) {
  if (backend &&
      (context.null() || !pythonInteger(context["transpose_semitones"]) ||
       !contains({"auto", "sharps", "flats", "neutral", "dual"},
                 str(context, "display_mode"))))
    return segment;
  J label;
  const auto &root = segment["pitch_class"], &quality = segment["quality"],
             &bass = segment["bass_pitch_class"];
  bool structured =
      (backend ? pythonInteger(root) : integer(root)) && quality.string();
  if (structured)
    label = formatTransposed(
        modulo(root), quality.s(),
        (backend ? pythonInteger(bass) : integer(bass)) ? bass : J(), context);
  if (backend && label.null()) {
    for (const auto &field : {"label", "display_label", "raw_label"}) {
      if (!segment[field].string() || trim(segment[field].s(), true).empty())
        continue;
      auto parsed = backendParse(segment[field].s());
      if (parsed["root_pitch_class"].null() || parsed["quality"].null())
        continue;
      label = formatTransposed(parsed["root_pitch_class"].n(),
                               parsed["quality"].s(),
                               parsed["bass_pitch_class"], context);
      if (!label.null())
        break;
    }
  } else if (!backend && !structured) {
    auto parsed = nativeParse(segmentLabel(segment));
    if (!parsed.null())
      label = formatTransposed(parsed["root_pitch_class"].n(),
                               parsed["quality"].s(),
                               parsed["bass_pitch_class"], context);
  }
  if (!backend)
    return label.null() ? J(segmentLabel(segment)) : label;
  if (label.null())
    return segment;
  auto result = segment;
  result["label"] = label;
  result["display_label"] = label;
  return result;
}
J constants() {
  J result{
      {"sharp_pitch_names", J::array()},   {"flat_pitch_names", J::array()},
      {"neutral_pitch_names", J::array()}, {"dual_pitch_names", J::array()},
      {"scale_degrees", J::array()},       {"quality_suffixes", J::Object{}},
      {"quality_intervals", J::Object{}}};
  for (const auto &[field, mode] :
       std::vector<std::pair<std::string, std::string>>{
           {"sharp_pitch_names", "sharps"},
           {"flat_pitch_names", "flats"},
           {"neutral_pitch_names", "neutral"},
           {"dual_pitch_names", "dual"}})
    for (int i = 0; i < 12; ++i)
      result[field].a().push_back(format_pc(i, J{{"mode", mode}}));
  for (const auto &degree : degrees)
    result["scale_degrees"].a().push_back(degree);
  for (const auto &quality : qualities())
    result["quality_suffixes"][quality] = suffix(quality);
  for (const auto &quality : qualities())
    result["quality_intervals"][quality] = qualityIntervals(quality);
  return result;
}
double pythonRound3(double value) {
  if (std::abs(value) >= 1e18)
    return value;
  std::ostringstream formatted;
  formatted.imbue(std::locale::classic());
  formatted << std::fixed << std::setprecision(3) << value;
  return std::stod(formatted.str());
}
} // namespace

std::optional<J> legacy_policy(const J &request) {
  auto operation = str(request, "operation"), input = str(request, "input");
  if (operation == "backendParseChord")
    return backendParse(input);
  if (operation == "backendNormalizeQuality")
    return normalizeQuality(request["input"]);
  if (operation == "backendFormatChord")
    return pythonFormat(request["root"], request["quality"], request["bass"]);
  if (operation == "backendChordSegment") {
    const auto parsed = backendParse(input);
    return J{{"start_seconds", pythonRound3(request["start_seconds"].d())},
             {"end_seconds", pythonRound3(request["end_seconds"].d())},
             {"label", parsed["display_label"]},
             {"display_label", parsed["display_label"]},
             {"raw_label", parsed["raw_label"]},
             {"confidence", request["confidence"]},
             {"pitch_class", parsed["root_pitch_class"]},
             {"root_pitch_class", parsed["root_pitch_class"]},
             {"quality", parsed["quality"]},
             {"bass_pitch_class", parsed["bass_pitch_class"]},
             {"bass_degree", parsed["bass_degree"]}};
  }
  if (operation == "backendParseKey" || operation == "nativeParseKey")
    return parseKey(request["input"], operation == "backendParseKey");
  if (operation == "shortestSemitoneDelta") {
    auto delta = pc(modulo(request["target"]) - modulo(request["source"]));
    return J(delta <= 6 ? delta : delta - 12);
  }
  if (operation == "backendDocumentContext" ||
      operation == "nativeDocumentContext")
    return documentContext(request, operation == "backendDocumentContext");
  if (operation == "backendDisplayChordSegment" ||
      operation == "nativeDisplayChordLabel")
    return displaySegment(request["segment"], request["context"],
                          operation == "backendDisplayChordSegment");
  if (operation == "nativeAutomaticPitchSpelling")
    return J(spellingMode(
        J{{"display_mode", "auto"}, {"active_key", request["input"]}}));
  if (operation == "nativeConstants")
    return constants();
  if (operation == "nativeNotePitchClass" ||
      operation == "nativeSharpPitchClass")
    return notePitch(input, operation == "nativeSharpPitchClass");
  if (operation == "nativePitchClassName")
    return J(format_pc(modulo(request["pitch_class"]),
                       J{{"mode", str(request, "spelling")}}));
  if (operation == "nativeFormatKey")
    return J(format_pc(modulo(request["pitch_class"]),
                       J{{"mode", str(request, "spelling")}}) +
             " " + str(request, "mode"));
  if (operation == "nativeQualitySuffix")
    return qualitySuffix(input);
  if (operation == "nativeQualityFromSuffix") {
    const auto canonical = canonical_quality(input);
    return canonical.empty() ? J() : J(canonical);
  }
  if (operation == "nativeQualityIntervals")
    return qualityIntervals(input);
  if (operation == "nativeDegreeName") {
    const auto &relative = request["input"];
    return integer(relative) && relative.d() >= 0 && relative.d() < 12
               ? J(degrees[relative.n()])
               : J();
  }
  if (operation == "nativeDegreePitchClass")
    return degreePitch(modulo(request["root"]), str(request, "degree"), true);
  if (operation == "nativeCremaContains") {
    const auto colon = input.find(':');
    auto quality =
        colon == std::string::npos
            ? "maj"
            : input.substr(colon + 1, input.find(':', colon + 1) - colon - 1);
    auto intervals = qualityIntervals(quality);
    bool found = false;
    if (!intervals.null())
      for (const auto &interval : intervals.a())
        found = found || interval == request["relative"];
    return J(found);
  }
  if (operation == "nativeParseCrema")
    return cremaParse(input);
  if (operation == "nativeParseChord")
    return nativeParse(input);
  if (operation == "nativeFormatChord" ||
      operation == "nativeFormatChordSuffix")
    return nativeFormat(
        modulo(request["root"]),
        str(request, operation == "nativeFormatChord" ? "quality" : "suffix"),
        request["bass"], str(request, "spelling"),
        operation == "nativeFormatChordSuffix");
  if (operation == "nativeRound3")
    return J(pythonRound3(request["input"].d()));
  return std::nullopt;
}
} // namespace tuneforge
