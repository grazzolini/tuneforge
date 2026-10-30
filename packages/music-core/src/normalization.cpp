#include "normalization.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <regex>
#include <set>

namespace tuneforge {
namespace {
const std::set<std::string> degrees = {"1",  "b2", "#1", "2",   "#2", "b3",
                                       "3",  "4",  "#4", "b5",  "5",  "#5",
                                       "b6", "6",  "#6", "bb7", "b7", "7"};
const std::set<std::string> families = {"C", "A", "G", "E", "D"};
const std::set<std::string> rowIds = {"counterbass", "bass",    "major",
                                      "minor",       "seventh", "diminished"};
const J::Array emptyArray;

const J::Array &array(const J &input) {
  return std::holds_alternative<J::Array>(input.value) ? input.a() : emptyArray;
}
bool integer(const J &input) {
  return input.number() && std::abs(input.d()) <= 9007199254740991.0 &&
         std::floor(input.d()) == input.d();
}
bool positive(const J &input) { return integer(input) && input.d() > 0; }
bool nonnegative(const J &input) { return integer(input) && input.d() >= 0; }
bool one(const J &input) { return input.number() && input.d() == 1; }
bool yes(const J &input) {
  return std::holds_alternative<bool>(input.value) && input.b();
}
bool member(const J &input, const std::set<std::string> &values) {
  return input.string() && values.count(input.s());
}
bool finger(const J &input, int maximum) {
  return positive(input) && input.d() <= maximum;
}

// ECMAScript TrimString whitespace, independent of the process locale.
bool whitespace(unsigned cp) {
  return cp == 9 || cp == 10 || cp == 11 || cp == 12 || cp == 13 || cp == 32 ||
         cp == 0xa0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) ||
         cp == 0x2028 || cp == 0x2029 || cp == 0x202f || cp == 0x205f ||
         cp == 0x3000 || cp == 0xfeff;
}
std::string trim(const std::string &text) {
  std::size_t first = text.size(), last = 0;
  for (std::size_t i = 0; i < text.size();) {
    const auto start = i;
    auto c = static_cast<unsigned char>(text[i++]);
    unsigned cp = c;
    int extra = c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc0 ? 1 : 0;
    if (extra) {
      cp &= (1u << (6 - extra)) - 1;
      for (int j = 0; j < extra && i < text.size(); ++j)
        cp = (cp << 6) | (static_cast<unsigned char>(text[i++]) & 63);
    }
    if (!whitespace(cp)) {
      first = std::min(first, start);
      last = i;
    }
  }
  return first == text.size() ? "" : text.substr(first, last - first);
}
std::string text(const J &input) {
  return input.string() ? trim(input.s()) : "";
}
void optionalText(J &output, const J &input, const std::string &key) {
  auto value = text(input[key]);
  if (!value.empty())
    output[key] = value;
}
J strings(const J &input) {
  J result = J::array();
  for (const auto &value : array(input)) {
    auto normalized = text(value);
    if (!normalized.empty())
      result.a().push_back(normalized);
  }
  return result;
}
J stringOrder(const J &input) {
  if (array(input).size() != 6)
    return J::array();
  std::set<int> seen;
  for (const auto &value : input.a()) {
    if (!positive(value) || value.d() > 6)
      return J::array();
    seen.insert(value.n());
  }
  return seen.size() == 6 ? input : J::array();
}
J harmonicDefinitions(const J &input) {
  J result = J::Object{};
  for (const auto &key : input.ordered_keys()) {
    const auto &value = input[key];
    auto id = text(value["id"]);
    if (id.empty())
      id = trim(key);
    auto label = text(value["label"]);
    J tones = J::array();
    for (const auto &tone : array(value["tones"]))
      if (tone.object() && member(tone["degree"], degrees) &&
          integer(tone["interval"]))
        tones.a().push_back(
            J{{"degree", tone["degree"]}, {"interval", tone["interval"]}});
    if (id.empty() || label.empty() || !value["suffix"].string() ||
        tones.a().empty())
      continue;
    if (id == "__proto__")
      continue;
    result[id] = J{{"id", id},
                   {"label", label},
                   {"suffix", value["suffix"]},
                   {"aliases", strings(value["aliases"])},
                   {"tones", tones}};
  }
  return result;
}
J tuning(const J &input) {
  J result = J::array();
  for (const auto &value : array(input)) {
    auto pitch = text(value["openPitch"]);
    if (value.object() && positive(value["string"]) && !pitch.empty())
      result.a().push_back(
          J{{"string", value["string"]}, {"openPitch", pitch}});
  }
  return result;
}
J fretboard(const J &input) {
  if (!input.object() || !positive(input["frets"]))
    return nullptr;
  return J{{"frets", input["frets"]},
           {"stringOrder", stringOrder(input["stringOrder"])},
           {"canCapo", yes(input["canCapo"])},
           {"canRetune", yes(input["canRetune"])}};
}
J keyboard(const J &input) {
  auto low = text(input["lowestPitch"]), high = text(input["highestPitch"]);
  if (!input.object() || !positive(input["keyCount"]) || low.empty() ||
      high.empty())
    return nullptr;
  return J{{"keyCount", input["keyCount"]},
           {"lowestPitch", low},
           {"highestPitch", high},
           {"canTranspose", yes(input["canTranspose"])}};
}
J stradella(const J &input) {
  if (!input.object())
    return nullptr;
  J roots = J::array(), rows = J::array();
  std::set<std::string> seen;
  for (const auto &value : array(input["rootAxis"])) {
    auto root = text(value["root"]);
    const auto &pc = value["pitchClass"];
    if (!value.object() || root.empty() || !nonnegative(pc) || pc.d() > 11 ||
        !positive(value["column"]) || !value["visualColumn"].number() ||
        !nonnegative(value["visualOrder"]))
      continue;
    roots.a().push_back(J{{"root", root},
                          {"pitchClass", pc},
                          {"column", value["column"]},
                          {"visualColumn", value["visualColumn"]},
                          {"visualOrder", value["visualOrder"]}});
  }
  const std::set<std::string> kinds = {"bass", "chord"};
  for (const auto &value : array(input["rows"])) {
    auto label = text(value["label"]);
    if (!value.object() || !member(value["id"], rowIds) || label.empty() ||
        !member(value["kind"], kinds) || !nonnegative(value["visualOrder"]) ||
        !value["visualColumnOffset"].number() ||
        !value["visualYOffset"].number() || !value["visualYStep"].number())
      continue;
    rows.a().push_back(J{{"id", value["id"]},
                         {"label", label},
                         {"kind", value["kind"]},
                         {"visualOrder", value["visualOrder"]},
                         {"visualColumnOffset", value["visualColumnOffset"]},
                         {"visualYOffset", value["visualYOffset"]},
                         {"visualYStep", value["visualYStep"]}});
    seen.insert(value["id"].s());
  }
  if (roots.a().empty() || rows.a().size() != 6 || seen.size() != 6)
    return nullptr;
  return J{{"rootAxis", roots}, {"rows", rows}};
}
J buttonBoard(const J &input) {
  auto layout = text(input["layout"]);
  if (!input.object() || layout.empty() || !positive(input["buttons"]))
    return nullptr;
  J result{{"layout", layout},
           {"buttons", input["buttons"]},
           {"canTranspose", yes(input["canTranspose"])}};
  for (const auto &key : {"rows", "columns"})
    if (positive(input[key]))
      result[key] = input[key];
  auto board = stradella(input["stradella"]);
  if (!board.null())
    result["stradella"] = board;
  return result;
}
J profiles(const J &input) {
  J result = J::Object{};
  for (const auto &key : input.ordered_keys()) {
    const auto &value = input[key];
    auto id = text(value["id"]);
    if (id.empty())
      id = trim(key);
    auto label = text(value["label"]), family = text(value["family"]);
    auto layer = text(value["executionLayer"]);
    if (id.empty() || label.empty() || family.empty() || layer.empty())
      continue;
    J profile{{"id", id},
              {"label", label},
              {"family", family},
              {"executionLayer", layer}};
    auto strings = tuning(value["tuning"]);
    if (!strings.a().empty())
      profile["tuning"] = strings;
    for (const auto &[name, normalized] :
         std::vector<std::pair<std::string, J>>{
             {"fretboard", fretboard(value["fretboard"])},
             {"keyboard", keyboard(value["keyboard"])},
             {"buttonBoard", buttonBoard(value["buttonBoard"])}})
      if (!normalized.null())
        profile[name] = normalized;
    if (id != "__proto__")
      result[id] = profile;
  }
  return result;
}
J guitarNotes(const J &input) {
  J result = J::array();
  for (const auto &value : array(input)) {
    if (!value.object() || !positive(value["string"]) ||
        !nonnegative(value["fret"]))
      continue;
    J note{{"string", value["string"]}, {"fret", value["fret"]}};
    if (finger(value["finger"], 4))
      note["finger"] = value["finger"];
    result.a().push_back(note);
  }
  return result;
}
J baseSeed(const J &input, const std::string &instrument) {
  auto id = text(input["id"]), label = text(input["label"]),
       chord = text(input["chordLabel"]);
  if (id.empty() || label.empty() || chord.empty() || !integer(input["rank"]))
    return nullptr;
  return J{{"id", id},
           {"instrumentId", instrument},
           {"label", label},
           {"chordLabel", chord},
           {"rank", input["rank"]}};
}
J guitarSeeds(const J &input, const std::string &instrument) {
  J result = J::array();
  for (const auto &value : array(input)) {
    auto base = baseSeed(value, instrument),
         notes = guitarNotes(value["notes"]);
    if (base.null() || notes.a().empty())
      continue;
    if (member(value["shapeFamily"], families))
      base["shapeFamily"] = value["shapeFamily"];
    base["source"] = "first-party";
    base["notes"] = notes;
    result.a().push_back(base);
  }
  return result;
}
J moveableSeeds(const J &input, const std::string &instrument) {
  J result = J::array();
  for (const auto &value : array(input)) {
    auto id = text(value["id"]), label = text(value["label"]),
         quality = text(value["quality"]);
    const auto &frets = array(value["baseFrets"]);
    if (id.empty() || label.empty() || quality.empty() ||
        !member(value["shapeFamily"], families) || !integer(value["rank"]) ||
        frets.size() != 6 ||
        !std::all_of(frets.begin(), frets.end(),
                     [](const J &f) { return f.null() || nonnegative(f); }))
      continue;
    J roots = J::array();
    for (const auto &root : array(value["roots"])) {
      auto name = text(root["label"]);
      if (root.object() && !name.empty() && positive(root["offset"]))
        roots.a().push_back(J{{"label", name}, {"offset", root["offset"]}});
    }
    if (!roots.a().empty())
      result.a().push_back(J{{"id", id},
                             {"instrumentId", instrument},
                             {"label", label},
                             {"quality", quality},
                             {"shapeFamily", value["shapeFamily"]},
                             {"baseFrets", value["baseFrets"]},
                             {"rank", value["rank"]},
                             {"roots", roots}});
  }
  return result;
}
J positions(const J &input, bool buttons) {
  J result = J::array();
  const std::set<std::string> hands = {"left", "right"};
  for (const auto &value : array(input)) {
    auto pitch = text(value["pitch"]), side = text(value["side"]),
         button = text(value["button"]);
    if (!value.object() ||
        (buttons ? side.empty() || button.empty() || !positive(value["row"]) ||
                       !positive(value["column"])
                 : pitch.empty()))
      continue;
    J position = buttons ? J{{"side", side},
                             {"button", button},
                             {"row", value["row"]},
                             {"column", value["column"]}}
                         : J{{"pitch", pitch}};
    if (buttons)
      optionalText(position, value, "pitch");
    optionalText(position, value, "note");
    if (!buttons && member(value["hand"], hands))
      position["hand"] = value["hand"];
    if (finger(value["finger"], 5))
      position["finger"] = value["finger"];
    result.a().push_back(position);
  }
  return result;
}
J seedGroups(const J &input) {
  J result = J::Object{};
  for (const auto &instrument : input.ordered_keys()) {
    const auto &value = input[instrument];
    if (!value.object() || instrument == "__proto__")
      continue;
    auto common = guitarSeeds(value["common"], instrument);
    auto moveable = moveableSeeds(value["moveableDefinitions"], instrument);
    if (!common.a().empty() || !moveable.a().empty()) {
      result[instrument] =
          J{{"common", common}, {"moveableDefinitions", moveable}};
      continue;
    }
    const auto &layer = value["executionLayer"];
    if (!layer.string() ||
        (layer.s() != "keyboard" && layer.s() != "button-board"))
      continue;
    J seeds = J::array();
    for (const auto &seed : array(value["seeds"])) {
      auto base = baseSeed(seed, instrument);
      auto normalized =
          positions(seed["positions"], layer.s() == "button-board");
      if (base.null() || normalized.a().empty())
        continue;
      auto tags = strings(seed["tags"]);
      if (!tags.a().empty())
        base["tags"] = tags;
      base["executionLayer"] = layer;
      base["positions"] = normalized;
      seeds.a().push_back(base);
    }
    if (!seeds.a().empty())
      result[instrument] = J{{"executionLayer", layer}, {"seeds", seeds}};
  }
  return result;
}
J adapters(const J &input) {
  J result = J::Object{};
  for (const auto &id : input.ordered_keys()) {
    const auto &value = input[id];
    if (!value.object() || !one(value["schemaVersion"]))
      continue;
    J adapter{{"schemaVersion", 1}};
    optionalText(adapter, value, "description");
    auto order = stringOrder(value["stringOrder"]);
    if (!order.a().empty())
      adapter["stringOrder"] = order;
    if (id != "__proto__")
      result[id] = adapter;
  }
  return result;
}

J observedNumber(const J &input) {
  if (!input.string())
    return input;
  auto value = trim(input.s());
  if (value.empty())
    return 0;
  static const std::regex decimal(
      R"(^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$)");
  double number = 0;
  if (value.size() > 2 && value[0] == '0' &&
      (value[1] == 'x' || value[1] == 'X' || value[1] == 'b' ||
       value[1] == 'B' || value[1] == 'o' || value[1] == 'O')) {
    int base = std::tolower(value[1]) == 'x'   ? 16
               : std::tolower(value[1]) == 'b' ? 2
                                               : 8;
    for (std::size_t i = 2; i < value.size(); ++i) {
      auto c = static_cast<unsigned char>(value[i]);
      int digit = c >= '0' && c <= '9'   ? c - '0'
                  : c >= 'a' && c <= 'f' ? c - 'a' + 10
                  : c >= 'A' && c <= 'F' ? c - 'A' + 10
                                         : 99;
      if (digit >= base)
        return nullptr;
      number = number * base + digit;
    }
  } else {
    if (!std::regex_match(value, decimal))
      return nullptr;
    number = std::strtod(value.c_str(), nullptr);
  }
  return std::isfinite(number) ? J(number) : J();
}
J observedFinger(const J &input, std::size_t index) {
  const auto &rows = array(input);
  if (rows.empty())
    return nullptr;
  if (std::holds_alternative<J::Array>(rows[0].value) &&
      rows[0].a().size() == 6) {
    auto candidate = observedNumber(rows[0].a()[index]);
    return finger(candidate, 4) ? candidate : J();
  }
  if (index < rows.size())
    for (const auto &candidate : array(rows[index])) {
      auto normalized = observedNumber(candidate);
      if (finger(normalized, 4))
        return normalized;
    }
  return nullptr;
}
std::string slug(const std::string &input) {
  auto value = trim(input);
  // These are the Unicode lowercase mappings which introduce ASCII letters.
  for (const auto &[from, to] :
       std::vector<std::pair<std::string, std::string>>{{"K", "k"},
                                                        {"İ", "i-"}}) {
    std::size_t at = 0;
    while ((at = value.find(from, at)) != std::string::npos) {
      value.replace(at, from.size(), to);
      at += to.size();
    }
  }
  std::string result;
  bool separator = false;
  for (unsigned char c : value) {
    if (c >= 'A' && c <= 'Z')
      c += 'a' - 'A';
    if (c == '#') {
      result += "sharp";
      separator = false;
    } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' ||
               c == '/') {
      result += c == '/' ? '-' : char(c);
      separator = false;
    } else if (!separator) {
      result += '-';
      separator = true;
    }
  }
  const auto first = result.find_first_not_of('-');
  return first == std::string::npos
             ? ""
             : result.substr(first, result.find_last_not_of('-') - first + 1);
}
} // namespace

std::string trim_js(const std::string &text) { return trim(text); }
std::string compact_js(const std::string &text) {
  std::string result;
  for (std::size_t i = 0; i < text.size();) {
    const unsigned char c = text[i];
    const std::size_t count = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    const auto token = text.substr(i, count);
    if (!trim(token).empty())
      result += token;
    i += count;
  }
  return result;
}
J normalizeInstrumentKnowledgeBundle(const J &input) {
  const J empty{{"schemaVersion", 1},
                {"bundleId", ""},
                {"version", ""},
                {"harmonicDefinitions", J::Object{}},
                {"instrumentProfiles", J::Object{}},
                {"voicingSeeds", J::Object{}},
                {"importAdapters", J::Object{}}};
  if (!input.object() || !one(input["schemaVersion"]))
    return empty;
  return J{{"schemaVersion", 1},
           {"bundleId", text(input["bundleId"])},
           {"version", text(input["version"])},
           {"harmonicDefinitions",
            harmonicDefinitions(input["harmonicDefinitions"])},
           {"instrumentProfiles", profiles(input["instrumentProfiles"])},
           {"voicingSeeds", seedGroups(input["voicingSeeds"])},
           {"importAdapters", adapters(input["importAdapters"])}};
}
J normalizeObservedGuitarGzipVoicingSeeds(const J &input, const J &options) {
  J result = J::array();
  auto instrument =
      options["instrumentId"].null() ? J("guitar") : options["instrumentId"];
  auto source =
      options["sourceId"].null() ? J("observed-gzip") : options["sourceId"];
  const auto rank =
      options["rankStart"].null() ? J(1000) : options["rankStart"];
  for (const auto &label : input.ordered_keys()) {
    const auto &shapes = input[label];
    auto chord = trim(label);
    if (chord.empty())
      continue;
    const auto &values = array(shapes);
    for (std::size_t index = 0; index < values.size(); ++index) {
      const auto &shape = values[index];
      if (!shape.object() || array(shape["positions"]).size() != 6)
        continue;
      J notes = J::array();
      for (std::size_t position = 0; position < 6; ++position) {
        const auto &raw = shape["positions"].a()[position];
        if (raw.string() && trim(raw.s()).empty())
          continue;
        auto fret = observedNumber(raw);
        if (!nonnegative(fret))
          continue;
        J note{{"string", int(6 - position)}, {"fret", fret}};
        auto digit = observedFinger(shape["fingerings"], position);
        if (!digit.null())
          note["finger"] = digit;
        notes.a().push_back(note);
      }
      if (notes.a().empty())
        continue;
      const auto ordinal = std::to_string(index + 1);
      result.a().push_back(
          J{{"id", source.s() + "-" + slug(chord) + "-" + ordinal},
            {"instrumentId", instrument},
            {"label", chord + " observed " + ordinal},
            {"chordLabel", chord},
            {"rank", rank.d() + result.a().size()},
            {"source", "observed-gzip"},
            {"notes", notes}});
    }
  }
  return result;
}
} // namespace tuneforge
