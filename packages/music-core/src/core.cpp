#include "core.hpp"
#include "legacy_policies.hpp"
#include "normalization.hpp"
#include <cctype>
#include <gingo/note.hpp>
#include <regex>

namespace tuneforge {
static double js_number(const J &value, const std::string &key,
                        double fallback = 0) {
  return value[key].number() ? value[key].d() : fallback;
}
static std::string js_number_text(double value) {
  if (value == 0)
    return "0";
  // Find the shortest decimal that round-trips, without newer platform charconv
  // APIs.
  std::string text;
  for (int precision = 1; precision <= 17; ++precision) {
    std::ostringstream formatter;
    formatter.imbue(std::locale::classic());
    formatter << std::setprecision(precision) << value;
    text = formatter.str();
    std::istringstream parser(text);
    parser.imbue(std::locale::classic());
    double parsed = 0;
    if (parser >> parsed && parsed == value)
      break;
  }
  const auto exponent = text.find('e');
  if (exponent == std::string::npos)
    return text;
  const int power = std::stoi(text.substr(exponent + 1));
  if (std::abs(value) < 1e-6 || std::abs(value) >= 1e21) {
    return text.substr(0, exponent) + "e" + (power >= 0 ? "+" : "") +
           std::to_string(power);
  }
  auto digits = text.substr(value < 0 ? 1 : 0, exponent - (value < 0 ? 1 : 0));
  const auto dot = digits.find('.');
  int position = (dot == std::string::npos ? digits.size() : dot) + power;
  if (dot != std::string::npos)
    digits.erase(dot, 1);
  const auto sign = value < 0 ? "-" : "";
  if (position <= 0)
    return sign + std::string("0.") + std::string(-position, '0') + digits;
  if (position >= static_cast<int>(digits.size()))
    return sign + digits + std::string(position - digits.size(), '0');
  return sign + digits.substr(0, position) + "." + digits.substr(position);
}
static double js_midi(double octave, double pitch_class) {
  const double base = (octave + 1.0) * 12.0;
  return base + pc(pitch_class);
}

const J &quality_definition(const std::string &quality) {
  return knowledge()["harmonicDefinitions"][quality];
}
std::vector<std::string> qualities(bool dictionary_only) {
  std::vector<std::string> result;
  for (const auto &name : knowledge()["harmonicDefinitions"].ordered_keys())
    if (!dictionary_only || flag(quality_definition(name), "dictionarySupported"))
      result.push_back(name);
  return result;
}
std::string canonical_quality(const std::string &input) {
  auto quality = compact_js(input);
  // Symbolic case carries meaning. Fold word aliases only after exact lookup.
  for (const auto &name : qualities()) {
    if (name == quality) return name;
    for (const auto &alias : quality_definition(name)["aliases"].a())
      if (alias.s() == quality) return name;
  }
  std::transform(quality.begin(), quality.end(), quality.begin(),
                 [](unsigned char c) { return char(std::tolower(c)); });
  for (const auto &name : qualities()) {
    if (name == quality) return name;
    for (const auto &alias : quality_definition(name)["aliases"].a())
      if (alias.s() == quality) return name;
  }
  return "";
}
std::string native_suffix(const std::string &quality) {
  return str(quality_definition(canonical_quality(quality)), "gingoSuffix");
}
std::string suffix(const std::string &quality) {
  return str(quality_definition(quality), "suffix");
}
std::string format_pc(double value, const J &options) {
  static const std::vector<std::string> sharp{
      "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};
  static const std::vector<std::string> flat{"C",  "Db", "D",  "Eb", "E",  "F",
                                             "Gb", "G",  "Ab", "A",  "Bb", "B"};
  static const std::vector<std::string> neutral{
      "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"};
  static const int major[]{0, 2, 1, 2, 1, 2, 1, 1, 2, 1, 2, 1},
      minor[]{2, 1, 2, 2, 1, 2, 1, 2, 1, 0, 2, 1};
  const int p = pc(value);
  auto mode = str(options, "mode", "auto");
  int family = 0;
  if (mode == "dual")
    return sharp[p] == flat[p] ? sharp[p] : sharp[p] + '/' + flat[p];
  if (mode == "sharps")
    family = 1;
  else if (mode == "flats")
    family = 2;
  else if (mode == "auto" && !options["activeKey"].null()) {
    const auto &key = options["activeKey"];
    family =
        (str(key, "mode") == "minor" ? minor
                                     : major)[pc(js_number(key, "pitchClass"))];
  }
  return (family == 1 ? sharp : family == 2 ? flat : neutral)[p];
}
J pitch(double midi, const J &options) {
  const double octave = std::floor(midi / 12.0) - 1.0;
  const int p = pc(midi);
  const auto name = format_pc(p, options);
  return J{{"pitchClass", p},
           {"octave", octave},
           {"midi", midi},
           {"noteName", name},
           {"label", name + js_number_text(octave)}};
}
static std::optional<int> written_pitch_offset(const std::string &name) {
  if (!std::regex_match(name, std::regex("^[A-G][#b]{0,2}$")))
    return std::nullopt;
  static const std::map<char, int> natural{
      {'C', 0}, {'D', 2}, {'E', 4}, {'F', 5}, {'G', 7}, {'A', 9}, {'B', 11}};
  int offset = natural.at(name[0]);
  for (std::size_t i = 1; i < name.size(); ++i)
    offset += name[i] == '#' ? 1 : -1;
  return offset;
}
J named_pitch(double midi, const std::string &name, const J &options) {
  const auto offset = written_pitch_offset(name);
  if (!offset || pc(*offset) != pc(midi))
    return pitch(midi, options);
  // The written octave follows the note letter, including B#/Cb crossings.
  const double octave = (midi - *offset) / 12.0 - 1;
  return J{{"pitchClass", pc(midi)}, {"octave", octave}, {"midi", midi},
           {"noteName", name}, {"label", name + js_number_text(octave)}};
}
static double pitch_midi(const J &input) {
  const double pitch_class = js_number(input, "pitchClass");
  const auto offset = written_pitch_offset(str(input, "noteName"));
  return offset && pc(*offset) == pc(pitch_class)
             ? (js_number(input, "octave") + 1) * 12 + *offset
             : js_midi(js_number(input, "octave"), pitch_class);
}
J parse_pitch(const std::string &input) {
  std::smatch match;
  const auto normalized = trim_js(input);
  if (!std::regex_match(normalized, match,
                        std::regex("^([A-Ga-g][#b]{0,2})(-?[0-9]+)$")))
    throw std::invalid_argument("invalid-pitch");
  auto note = match[1].str();
  note[0] = char(std::toupper(static_cast<unsigned char>(note[0])));
  const double octave = std::strtod(match[2].str().c_str(), nullptr);
  if (!std::isfinite(octave) || std::floor(octave) != octave)
    throw std::invalid_argument("invalid-octave");
  const auto offset = written_pitch_offset(note);
  return named_pitch((octave + 1) * 12 + *offset, note);
}
J chord_options(const Chord &chord, J options) {
  if (!options["activeKey"].null() || !options["mode"].null())
    return options;
  const bool minor = chord.quality == "minor" || chord.quality == "m7" ||
                     chord.quality == "dim" || chord.quality == "dim7" ||
                     chord.quality == "hdim7";
  options["activeKey"] =
      J{{"pitchClass", chord.pitch}, {"mode", minor ? "minor" : "major"}};
  return options;
}
static std::string degree_name(const std::string &root,
                               const std::string &degree, int pitch_class,
                               const J &options) {
  if (str(options, "mode") == "dual")
    return format_pc(pitch_class, options);
  static const std::string letters = "CDEFGAB";
  static const int natural[]{0, 2, 4, 5, 7, 9, 11};
  auto digit = degree.find_first_of("1234567");
  if (root.empty() || digit == std::string::npos)
    return format_pc(pitch_class, options);
  const auto root_index = letters.find(
      static_cast<char>(std::toupper(static_cast<unsigned char>(root[0]))));
  if (root_index == std::string::npos)
    return format_pc(pitch_class, options);
  auto index = (root_index + std::size_t(degree[digit] - '1')) % 7;
  int accidental = pc(pitch_class - natural[index]);
  if (accidental > 6)
    accidental -= 12;
  if (accidental < -2 || accidental > 2)
    return format_pc(pitch_class, options);
  return std::string(1, letters[index]) + (accidental < 0
                                               ? std::string(-accidental, 'b')
                                               : std::string(accidental, '#'));
}
std::optional<Chord> parse_chord(const std::string &input) {
  const auto compact = compact_js(input);
  std::smatch match;
  if (!std::regex_match(compact, match,
                        std::regex("^([A-Ga-g][#b]?)([^/]*)(?:/(.+))?$")))
    return std::nullopt;
  Chord chord;
  chord.root = match[1];
  chord.root[0] = char(std::toupper(static_cast<unsigned char>(chord.root[0])));
  auto quality = match[2].str();
  const bool harte = !quality.empty() && quality[0] == ':';
  if (harte)
    quality.erase(0, 1);
  chord.quality = canonical_quality(quality);
  if (chord.quality.empty())
    return std::nullopt;
  try {
    chord.pitch = gingo::Note(chord.root).semitone();
  } catch (const std::exception &) {
    return std::nullopt;
  }
  if (match[3].matched) {
    auto bass = match[3].str();
    auto note = bass;
    if (!note.empty())
      note[0] = char(std::toupper(static_cast<unsigned char>(note[0])));
    if (std::regex_match(note, std::regex("^[A-G][#b]?$"))) {
      try {
        chord.bass_pitch = gingo::Note(note).semitone();
        chord.bass = note;
      } catch (const std::exception &) {
        return std::nullopt;
      }
    } else {
      static const std::map<std::string, int> degrees{
          {"1", 0},  {"#1", 1}, {"b2", 1},  {"2", 2},   {"#2", 3},  {"b3", 3},
          {"3", 4},  {"4", 5},  {"#4", 6},  {"b5", 6},  {"5", 7},   {"#5", 8},
          {"b6", 8}, {"6", 9},  {"#6", 10}, {"bb7", 9}, {"b7", 10}, {"7", 11}};
      std::transform(bass.begin(), bass.end(), bass.begin(),
                     [](unsigned char c) { return char(std::tolower(c)); });
      auto it = degrees.find(bass);
      if (it == degrees.end())
        return std::nullopt;
      chord.bass_pitch = pc(chord.pitch + it->second);
      chord.bass_degree = bass;
      chord.bass =
          degree_name(chord.root, bass, chord.bass_pitch, chord_options(chord));
    }
  }
  chord = spell(chord);
  const auto &q = chord.quality;
  if (harte || !chord.bass_degree.empty() || q == "7b5" || q == "sus2" ||
      q == "sus4" || q == "aug" || q == "dim7" || q == "hdim7" ||
      compact != chord.label)
    chord.raw = input;
  return chord;
}
std::optional<Chord> parse_input(const J &input) {
  if (input.string())
    return parse_chord(input.s());
  if (!input.object() || canonical_quality(str(input, "quality")).empty())
    return std::nullopt;
  Chord chord;
  chord.raw = str(input, "rawLabel");
  chord.root = str(input, "root");
  chord.pitch = pc(js_number(input, "rootPitchClass"));
  chord.quality = canonical_quality(str(input, "quality"));
  chord.bass = str(input, "bass");
  chord.bass_pitch = input["bassPitchClass"].number()
                         ? pc(js_number(input, "bassPitchClass"))
                         : -1;
  chord.bass_degree = str(input, "bassDegree");
  return spell(chord);
}
Chord spell(Chord chord, const J &requested) {
  const auto options = chord_options(chord, requested);
  chord.tones.clear();
  const auto native =
      gingo::Chord(format_pc(chord.pitch, J{{"mode", "sharps"}}) +
                   native_suffix(chord.quality))
          .notes();
  const auto &metadata = quality_definition(chord.quality)["tones"].a();
  if (native.size() != metadata.size())
    throw std::invalid_argument("chord-metadata-size");
  for (std::size_t i = 0; i < native.size(); ++i) {
    const auto degree = str(metadata[i], "degree");
    const int interval = pc(native[i].semitone() - chord.pitch);
    if (interval != num(metadata[i], "interval"))
      throw std::invalid_argument("chord-metadata-interval");
    chord.tones.push_back(Tone{
        degree, degree_name(chord.root, degree, native[i].semitone(), options),
        interval, native[i].semitone()});
  }
  chord.label = format_pc(chord.pitch, options) + suffix(chord.quality);
  if (str(options, "mode") == "dual") {
    const auto sharp = format_pc(chord.pitch, J{{"mode", "sharps"}}),
               flat = format_pc(chord.pitch, J{{"mode", "flats"}});
    chord.label = sharp + suffix(chord.quality) +
                  (sharp == flat ? "" : "/" + flat + suffix(chord.quality));
  }
  if (chord.bass_pitch >= 0 && chord.bass_pitch != chord.pitch) {
    const bool explicit_options =
        !requested["activeKey"].null() || !requested["mode"].null();
    bool matching_bass_label = false;
    const auto prefix = chord.bass.substr(0, 2);
    if (std::regex_match(prefix, std::regex("^[A-G][#b]?$"))) {
      try {
        matching_bass_label =
            gingo::Note(prefix).semitone() == chord.bass_pitch;
      } catch (const std::exception &) {
      }
    }
    chord.label += '/' + (explicit_options || !matching_bass_label
                              ? format_pc(chord.bass_pitch, options)
                              : chord.bass);
  }
  chord.bass_name =
      chord.bass_pitch < 0
          ? ""
          : (!requested["activeKey"].null() || !requested["mode"].null() ||
                     chord.bass.empty()
                 ? format_pc(chord.bass_pitch, options)
                 : chord.bass);
  return chord;
}
J spelling(const Chord &chord) {
  J::Array tones, notes;
  for (const auto &tone : chord.tones) {
    tones.push_back(J{{"degree", tone.degree},
                      {"interval", tone.interval},
                      {"pitchClass", tone.pitch},
                      {"noteName", tone.name}});
    notes.emplace_back(tone.name);
  }
  J result{{"root", chord.root},
           {"rootPitchClass", chord.pitch},
           {"quality", chord.quality},
           {"bass", chord.bass_pitch < 0 ? J() : J(chord.bass)},
           {"bassPitchClass", chord.bass_pitch < 0 ? J() : J(chord.bass_pitch)},
           {"label", chord.label},
           {"tones", tones},
           {"notes", notes},
           {"bassNoteName", chord.bass_pitch < 0 ? J() : J(chord.bass_name)}};
  if (!chord.raw.empty())
    result["rawLabel"] = chord.raw;
  if (!chord.bass_degree.empty())
    result["bassDegree"] = chord.bass_degree;
  return result;
}
Context context(const J &input) {
  Context out;
  if (input.null())
    return out;
  if (input["pitchClass"].number() &&
      (str(input, "mode") == "major" || str(input, "mode") == "minor"))
    out.key = input;
  else {
    out.key = input["activeKey"];
    out.preferred_region = input["preferredTrebleRegion"];
    const auto &current = input["currentChordRoot"];
    if (current.number())
      out.current = pc(current.d());
    else if (current.string() || current.object()) {
      auto parsed = parse_input(current);
      if (parsed)
        out.current = parsed->pitch;
    }
  }
  return out;
}
std::string slug(const std::string &input) {
  std::string out;
  for (unsigned char c : input) {
    if (c == '#')
      out += "sharp";
    else if (std::isalnum(c))
      out += char(std::tolower(c));
    else if (!out.empty() && out.back() != '-')
      out += '-';
  }
  while (!out.empty() && out.back() == '-')
    out.pop_back();
  return out;
}
std::string inversion_name(int inversion, bool accordion) {
  static const std::vector<std::string> names{
      "root position", "first inversion", "second inversion",
      "third inversion"};
  if (inversion == 0 && accordion)
    return "root";
  return names.at(std::size_t(inversion));
}
int anchor(int pitch_class, int low, int high) {
  int best = 60, distance = 10000;
  for (int midi = low; midi <= high; ++midi)
    if (pc(midi) == pc(pitch_class) && std::abs(midi - 60) < distance) {
      best = midi;
      distance = std::abs(midi - 60);
    }
  return best;
}
static J parsed_value(const Chord &chord) {
  J result{
      {"root", chord.root},
      {"rootPitchClass", chord.pitch},
      {"quality", chord.quality},
      {"bass", chord.bass_pitch < 0 ? J() : J(chord.bass)},
      {"bassPitchClass", chord.bass_pitch < 0 ? J() : J(chord.bass_pitch)}};
  if (!chord.raw.empty())
    result["rawLabel"] = chord.raw;
  if (!chord.bass_degree.empty())
    result["bassDegree"] = chord.bass_degree;
  return result;
}
Chord transpose_chord(Chord chord, double delta) {
  if (delta == 0)
    return spell(chord);
  const int bass_interval = pc(chord.bass_pitch - chord.pitch);
  chord.pitch = pc(chord.pitch + delta);
  const auto options = chord_options(chord);
  chord.root = format_pc(chord.pitch, options);
  if (chord.bass_pitch >= 0) {
    chord.bass_pitch = chord.bass_degree.empty()
                           ? pc(chord.bass_pitch + delta)
                           : pc(chord.pitch + bass_interval);
    chord.bass = chord.bass_degree.empty()
                     ? format_pc(chord.bass_pitch, options)
                     : degree_name(chord.root, chord.bass_degree,
                                   chord.bass_pitch, options);
  }
  return spell(chord);
}
static J parse_key(const J &value, bool stored = false,
                   bool serialized = false) {
  if (!value.string() || value.s().empty())
    return serialized ? J{{"pitchClass", 0}, {"mode", "major"}} : J();
  auto text = trim_js(value.s());
  if (serialized || (stored && text.find(':') != std::string::npos)) {
    const auto separator = text.find(':');
    const auto raw = text.substr(0, separator);
    char *end = nullptr;
    const auto normalized = trim_js(raw);
    const double pitch_class =
        normalized.empty() ? 0 : std::strtod(normalized.c_str(), &end);
    if ((!normalized.empty() && (!end || *end)) ||
        !std::isfinite(pitch_class) || std::floor(pitch_class) != pitch_class ||
        pitch_class < 0 || pitch_class > 11)
      return J{{"pitchClass", 0}, {"mode", "major"}};
    const auto mode =
        separator == std::string::npos
            ? ""
            : text.substr(separator + 1,
                          text.find(':', separator + 1) - separator - 1);
    return J{{"pitchClass", int(pitch_class)},
             {"mode", mode == "minor" ? "minor" : "major"}};
  }
  std::smatch match;
  const auto flags = std::regex_constants::icase;
  bool verbose_fallback = false;
  if (!std::regex_match(text, match, std::regex("^([A-G][#b]?)(m)?$", flags))) {
    if (!std::regex_match(text, match, std::regex("^([A-G][#b]?)(.*)$", flags)))
      return J();
    const auto remaining = match[2].str();
    auto normalized_mode = trim_js(remaining);
    std::transform(normalized_mode.begin(), normalized_mode.end(),
                   normalized_mode.begin(),
                   [](unsigned char c) { return char(std::tolower(c)); });
    if (remaining == trim_js(remaining) ||
        (normalized_mode != "major" && normalized_mode != "minor"))
      return J();
    verbose_fallback = true;
  }
  auto note = match[1].str();
  note[0] = char(std::toupper(static_cast<unsigned char>(note[0])));
  auto mode = verbose_fallback ? trim_js(match[2].str()) : match[2].str();
  std::transform(mode.begin(), mode.end(), mode.begin(),
                 [](unsigned char c) { return char(std::tolower(c)); });
  try {
    return J{{"pitchClass", gingo::Note(note).semitone()},
             {"mode", mode == "m" || mode == "minor" ? "minor" : "major"}};
  } catch (const std::exception &) {
    return J();
  }
}
static std::string format_key(const J &key, bool long_format, J options) {
  if (options["activeKey"].null())
    options["activeKey"] = key;
  const double root = js_number(key, "pitchClass");
  const auto mode = str(key, "mode");
  const auto suffix = mode == "minor" ? "m" : "";
  if (str(options, "mode") == "dual") {
    const auto sharp = format_pc(root, J{{"mode", "sharps"}}),
               flat = format_pc(root, J{{"mode", "flats"}});
    const auto ending = long_format ? " " + mode : suffix;
    return sharp == flat
               ? sharp + ending
               : sharp + ending + (long_format ? " / " : "/") + flat + ending;
  }
  return format_pc(root, options) + (long_format ? " " + mode : suffix);
}
static J label_part(const std::string &label) {
  std::smatch match;
  if (!std::regex_match(label, match, std::regex("^([A-G][#b]?)(.*)$")))
    return J{{"root", label}, {"suffix", ""}};
  return J{{"root", match[1].str()}, {"suffix", match[2].str()}};
}
static J display_label(const std::string &primary,
                       const std::string &secondary = "") {
  return J{
      {"ariaLabel", secondary.empty() ? primary : primary + " / " + secondary},
      {"primary", label_part(primary)},
      {"secondary", secondary.empty() ? J() : label_part(secondary)}};
}
static std::optional<std::string> alternate(double root, const J &options) {
  if (str(options, "mode") == "dual")
    return std::nullopt;
  const auto sharp = format_pc(root, J{{"mode", "sharps"}}),
             flat = format_pc(root, J{{"mode", "flats"}});
  if (sharp == flat)
    return std::nullopt;
  return format_pc(root, options) == sharp ? flat : sharp;
}
static std::pair<std::string, std::string>
dual_chord(double root, const std::string &quality,
           std::optional<double> bass) {
  const auto sharp = format_pc(root, J{{"mode", "sharps"}}),
             flat = format_pc(root, J{{"mode", "flats"}});
  std::string sharp_bass, flat_bass;
  if (bass && *bass != root) {
    sharp_bass = "/" + format_pc(*bass, J{{"mode", "sharps"}});
    flat_bass = "/" + format_pc(*bass, J{{"mode", "flats"}});
  }
  const auto primary = sharp + suffix(quality) + sharp_bass;
  return {primary, sharp != flat || sharp_bass != flat_bass
                       ? flat + suffix(quality) + flat_bass
                       : ""};
}
static std::string chord_label(double root, const std::string &quality,
                               const J &options,
                               std::optional<double> bass = {}) {
  if (str(options, "mode") == "dual") {
    const auto labels = dual_chord(root, quality, bass);
    const auto sharp = format_pc(root, J{{"mode", "sharps"}}),
               flat = format_pc(root, J{{"mode", "flats"}});
    return sharp == flat || labels.second.empty()
               ? labels.first
               : labels.first + "/" + labels.second;
  }
  return format_pc(root, options) + suffix(quality) +
         (bass && *bass != root ? "/" + format_pc(*bass, options) : "");
}
static J display_context(const J &context, const J &profile) {
  const double raw_capo =
      context["capoFret"].number() ? context["capoFret"].d() : 0;
  return J{
      {"sourceKey", context["sourceKey"]},
      {"transposeSemitones", js_number(context, "transposeSemitones")},
      {"capoFret", J(std::max(0.0, std::trunc(raw_capo)))},
      {"useCapoShapes", flag(context, "useCapoShapes")},
      {"canCapo", flag(context, "canCapo", flag(profile, "canCapo", true))}};
}
static std::optional<J> notation_operation(const J &request) {
  const auto operation = str(request, "operation");
  const auto &input = request["input"], &options = request["options"];
  if (operation == "parseKey" || operation == "parseStoredKey" ||
      operation == "deserializeKey")
    return parse_key(input, operation == "parseStoredKey",
                     operation == "deserializeKey");
  if (operation == "serializeKey")
    return J(js_number_text(js_number(input, "pitchClass")) + ":" +
             str(input, "mode"));
  if (operation == "formatKey")
    return J(format_key(input, str(request, "format") == "long", options));
  if (operation == "formatKeyDisplay") {
    if (str(options, "mode") != "dual")
      return display_label(format_key(input, false, options));
    const auto ending = str(input, "mode") == "minor" ? "m" : "";
    const auto sharp = format_pc(js_number(input, "pitchClass"),
                                 J{{"mode", "sharps"}}),
               flat = format_pc(js_number(input, "pitchClass"),
                                J{{"mode", "flats"}});
    return display_label(sharp + ending, sharp == flat ? "" : flat + ending);
  }
  if (operation == "formatAlternateKey") {
    auto resolved = options;
    if (resolved["activeKey"].null())
      resolved["activeKey"] = input;
    const auto name = alternate(js_number(input, "pitchClass"), resolved);
    if (!name)
      return J();
    return J(*name + (str(request, "format") == "long"
                          ? " " + str(input, "mode")
                      : str(input, "mode") == "minor" ? "m"
                                                      : ""));
  }
  if (operation == "getEnharmonicContext") {
    const auto mode = str(request, "mode", "auto");
    J opts{{"mode", mode}, {"activeKey", input}};
    const auto family = mode == "dual" || mode == "neutral" ? "neutral"
                        : format_pc(1, opts) == "Db"        ? "flat"
                        : format_pc(3, opts) == "D#"        ? "sharp"
                                                            : "neutral";
    return J{{"mode", mode}, {"family", family}};
  }
  if (operation == "formatPitchClass" || operation == "formatChordRoot")
    return J(format_pc(input.d(), options));
  if (operation == "formatAlternatePitchClass") {
    const auto result = alternate(input.d(), options);
    return result ? J(*result) : J();
  }
  if (operation == "formatChordLabel" || operation == "formatChordDisplay" ||
      operation == "formatAlternateChordLabel") {
    const double root = input.d();
    const std::optional<double> bass =
        request["bassPitchClass"].number()
            ? std::optional<double>(request["bassPitchClass"].d())
            : std::nullopt;
    const auto quality = str(request, "quality");
    if (operation == "formatChordLabel")
      return J(chord_label(root, quality, options, bass));
    if (operation == "formatChordDisplay") {
      const auto labels = dual_chord(root, quality, bass);
      return str(options, "mode") == "dual"
                 ? display_label(labels.first, labels.second)
                 : display_label(chord_label(root, quality, options, bass));
    }
    const auto name = alternate(root, options);
    if (!name)
      return J();
    const auto bass_name =
        bass && *bass != root
            ? alternate(*bass, options).value_or(format_pc(*bass, options))
            : "";
    return J(*name + suffix(quality) +
             (bass_name.empty() ? "" : "/" + bass_name));
  }
  if (operation == "isSupportedChordQuality" ||
      operation == "isChordSpellingQuality")
    return J(input.string() && !quality_definition(input.s()).null() &&
             (operation == "isChordSpellingQuality" || flag(quality_definition(input.s()), "dictionarySupported")));
  if (operation == "formatRawMusicalLabel")
    return display_label(input.s());
  if (operation == "transposePitchClass")
    return J(pc(input.d() + js_number(request, "semitones")));
  if (operation == "transposeKey")
    return J{{"pitchClass", pc(js_number(input, "pitchClass") +
                               js_number(request, "semitones"))},
             {"mode", input["mode"]}};
  if (operation == "semitoneDelta") {
    const double distance =
        std::fmod(js_number(request["target"], "pitchClass") -
                      js_number(input, "pitchClass") + 12.0,
                  12.0);
    return J(distance <= 6 ? distance : distance - 12);
  }
  if (operation == "parsePitch") {
    try {
      return input.string() && !input.s().empty() ? parse_pitch(input.s())
                                                  : J();
    } catch (const std::exception &) {
      return J();
    }
  }
  if (operation == "formatPitch") {
    const double midi = pitch_midi(input);
    const bool explicit_spelling = !options["mode"].null() || !options["activeKey"].null();
    return explicit_spelling ? pitch(midi, options)["label"]
                             : named_pitch(midi, str(input, "noteName"), options)["label"];
  }
  if (operation == "pitchToMidi")
    return J(pitch_midi(input));
  if (operation == "midiToPitch")
    return input.number() && std::floor(input.d()) == input.d()
               ? pitch(input.d(), options)
               : J();
  if (operation == "parseChordLabel") {
    const auto chord = input.string() ? parse_chord(input.s()) : std::nullopt;
    return chord ? parsed_value(*chord) : J();
  }
  if (operation == "formatParsedChordLabel") {
    const auto chord = parse_input(input);
    return chord ? J(spell(*chord, options).label) : J();
  }
  if (operation == "transposeChord" || operation == "transposeChordLabel" ||
      operation == "getCapoShapeChord") {
    auto chord = parse_input(input);
    if (!chord)
      return J();
    Chord transposed;
    if (operation == "getCapoShapeChord") {
      const auto resolved =
          display_context(request["context"], request["profile"]);
      transposed =
          transpose_chord(*chord, js_number(resolved, "transposeSemitones"));
      transposed =
          transpose_chord(transposed, flag(resolved, "useCapoShapes") &&
                                              flag(resolved, "canCapo")
                                          ? -js_number(resolved, "capoFret")
                                          : 0);
    } else
      transposed = transpose_chord(*chord, js_number(request, "semitones"));
    return operation == "transposeChordLabel"
               ? J(spell(transposed, options).label)
               : parsed_value(transposed);
  }
  if (operation == "resolveChordDisplayContext")
    return display_context(request["context"], request["profile"]);
  if (operation == "getCapoShapeSemitones") {
    const auto context =
        display_context(request["context"], request["profile"]);
    return J(flag(context, "useCapoShapes") && flag(context, "canCapo")
                 ? -js_number(context, "capoFret")
                 : 0);
  }
  return std::nullopt;
}

static J legacy_instrument_bundle() {
  auto source = knowledge();
  source["harmonicDefinitions"] = J(J::Object{});
  for (const auto &quality : qualities()) {
    source["harmonicDefinitions"][quality] = quality_definition(quality);
  }
  return normalizeInstrumentKnowledgeBundle(source);
}
static J constants() {
  J definitions(J::Object{});
  for (const auto &quality : qualities()) {
    const auto &source = quality_definition(quality);
    definitions[quality] = J{{"label", source["label"]},
                             {"suffix", source["suffix"]},
                             {"dictionarySupported", source["dictionarySupported"]},
                             {"tones", source["tones"]}};
  }
  J::Array keys;
  for (const auto &mode : {std::string("major"), std::string("minor")})
    for (int pc = 0; pc < 12; ++pc) {
      J key{{"pitchClass", pc}, {"mode", mode}};
      key["value"] = std::to_string(pc) + ":" + mode;
      key["label"] = format_key(key, false, J());
      keys.push_back(key);
    }
  return J{{"CHORD_QUALITY_DEFINITIONS", definitions},
           {"DEFAULT_KEY", J{{"pitchClass", 0}, {"mode", "major"}}},
           {"MUSICAL_KEYS", keys},
           {"DEFAULT_CHORD_DISPLAY_CONTEXT", display_context(J(), J())},
           {"INSTRUMENT_KNOWLEDGE_BUNDLE_V1", legacy_instrument_bundle()}};
}
static J run_frontend(const J &request) {
  const auto operation = str(request, "operation");
  if (operation == "normalizeBundle")
    return normalizeInstrumentKnowledgeBundle(request["input"]);
  if (operation == "normalizeObserved")
    return normalizeObservedGuitarGzipVoicingSeeds(request["input"],
                                                   request["options"]);
  if (operation == "constants")
    return constants();
  if (operation == "profiles")
    return profiles();
  if (operation == "seeds")
    return seeds();
  if (operation == "spell") {
    auto chord = parse_input(request["input"]);
    return chord ? spelling(spell(*chord, request["options"])) : J();
  }
  if (operation == "guitar")
    return guitar(request["input"], request["context"], request["options"],
                  request["profile"]);
  if (operation == "piano" || operation == "accordion")
    return keyboard(request["input"], request["context"], request["options"],
                    operation == "accordion");
  if (const auto result = notation_operation(request))
    return *result;
  throw std::invalid_argument("unknown-music-operation");
}
J run(const J &request) {
  if (const auto legacy = legacy_policy(request))
    return *legacy;
  auto result = run_frontend(request);
  result.canonicalize_js_numbers();
  return result;
}
} // namespace tuneforge
