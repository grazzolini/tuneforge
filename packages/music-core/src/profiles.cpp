#include "core.hpp"
#include "knowledge.hpp"

namespace tuneforge {
const J &knowledge() {
  static const J data = embedded_knowledge();
  if (num(data, "schemaVersion") != 1)
    throw std::invalid_argument("unsupported-instrument-schema");
  return data;
}
J profiles() {
  J result(J::Object{});
  for (const auto &entry : knowledge()["instrumentProfiles"].o()) {
    const auto &source = entry.second;
    if (entry.first == "guitar") {
      J::Array tuning;
      std::set<int> strings;
      for (const auto &item : source["tuning"].a()) {
        const int string = num(item, "string");
        if (string < 1 || !strings.insert(string).second)
          throw std::invalid_argument("invalid-guitar-string");
        tuning.push_back(J{{"string", string},
                           {"openPitch", parse_pitch(str(item, "openPitch"))}});
      }
      const auto &fretboard = source["fretboard"];
      if (num(fretboard, "frets") <= 0 ||
          tuning.size() != fretboard["stringOrder"].a().size())
        throw std::invalid_argument("invalid-fretboard");
      result[entry.first] = J{{"id", entry.first},
                              {"label", source["label"]},
                              {"tuning", tuning},
                              {"frets", fretboard["frets"]},
                              {"canCapo", fretboard["canCapo"]},
                              {"canRetune", fretboard["canRetune"]}};
    } else {
      auto keyboard = source["keyboard"];
      keyboard["lowestPitch"] = parse_pitch(str(keyboard, "lowestPitch"));
      keyboard["highestPitch"] = parse_pitch(str(keyboard, "highestPitch"));
      if (num(keyboard["highestPitch"], "midi") -
              num(keyboard["lowestPitch"], "midi") + 1 !=
          num(keyboard, "keyCount"))
        throw std::invalid_argument("invalid-keyboard-range");
      J profile{{"id", entry.first},
                {"label", source["label"]},
                {"family", source["family"]},
                {"keyboard", keyboard}};
      if (entry.first == "accordion") {
        const auto &board = source["buttonBoard"];
        if (num(board, "rows") * num(board, "columns") !=
                num(board, "buttons") ||
            board["stradella"]["rows"].a().size() !=
                std::size_t(num(board, "rows")) ||
            board["stradella"]["rootAxis"].a().size() !=
                std::size_t(num(board, "columns")))
          throw std::invalid_argument("invalid-stradella-board");
        profile["buttonBoard"] = board;
      }
      result[entry.first] = profile;
    }
  }
  return result;
}
J seeds() {
  J::Array out;
  const auto &source = knowledge()["voicingSeeds"]["guitar"];
  for (const auto &item : source["common"].a())
    out.push_back(J{{"id", item["id"]},
                    {"label", item["label"]},
                    {"shapeChordLabel", item["chordLabel"]},
                    {"shapeFamily", item["shapeFamily"]},
                    {"rank", item["rank"]},
                    {"notes", item["notes"]}});
  const auto &strings =
      knowledge()["instrumentProfiles"]["guitar"]["fretboard"]["stringOrder"]
          .a();
  for (const auto &definition : source["moveableDefinitions"].a()) {
    if (definition["baseFrets"].a().size() != strings.size())
      throw std::invalid_argument("invalid-moveable-seed");
    for (const auto &root : definition["roots"].a()) {
      const auto label =
          str(root, "label") + suffix(str(definition, "quality"));
      J::Array notes;
      for (std::size_t i = 0; i < strings.size(); ++i)
        if (!definition["baseFrets"].a()[i].null())
          notes.push_back(J{{"string", strings[i]},
                            {"fret", definition["baseFrets"].a()[i].n() +
                                         num(root, "offset")}});
      out.push_back(J{{"id", slug(label) + "-" + str(definition, "id")},
                      {"label", label + " " + str(definition, "label")},
                      {"shapeChordLabel", label},
                      {"shapeFamily", definition["shapeFamily"]},
                      {"rank", num(definition, "rank") + num(root, "offset")},
                      {"notes", notes}});
    }
  }
  return out;
}
} // namespace tuneforge
