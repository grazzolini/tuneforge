#include <gingo/chord.hpp>
#include <gingo/fretboard.hpp>
#include <gingo/piano.hpp>

#include <iostream>
#include <limits>
#include <set>
#include <sstream>
#include <string>
#include <vector>

// Test-only protocol: tab-separated operations in, one JSON result per
// operation out. Candidate enumeration stays in Gingo. No legacy search
// implementation is linked.
int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream input(line);
    std::string operation, label;
    input >> operation >> label;
    try {
      const gingo::Chord chord(label);
      if (operation == "chord") {
        std::cout << "{\"pitchClasses\":[";
        const auto notes = chord.notes();
        for (std::size_t i = 0; i < notes.size(); ++i) {
          if (i)
            std::cout << ',';
          std::cout << notes[i].semitone();
        }
        std::cout << "],\"intervals\":[";
        const auto intervals = chord.interval_labels();
        for (std::size_t i = 0; i < intervals.size(); ++i) {
          if (i)
            std::cout << ',';
          std::cout << '"' << intervals[i] << '"';
        }
        std::cout << "]}\n";
      } else if (operation == "guitar" || operation == "guitar-slash") {
        int capo = 0, additional_pitch_class = -1;
        input >> capo >> additional_pitch_class;
        const auto board = gingo::Fretboard::violao(22).capo(capo);
        // INT_MAX prevents result truncation from hiding feasible candidates.
#ifdef TUNEFORGE_SEARCH_POLICY
        const auto fingerings =
            operation == "guitar-slash"
                ? board.fingerings(chord, std::numeric_limits<int>::max(),
                                   additional_pitch_class)
                : board.fingerings(chord, std::numeric_limits<int>::max());
#else
        const auto fingerings =
            board.fingerings(chord, std::numeric_limits<int>::max());
#endif
        std::cout << "{\"positions\":[";
        for (int string = 1; string <= 6; ++string) {
          if (string > 1)
            std::cout << ',';
          std::cout << '[';
          for (int fret = 0; fret <= board.num_frets(); ++fret) {
            if (fret)
              std::cout << ',';
            std::cout << board.position(string, fret).midi;
          }
          std::cout << ']';
        }
        std::cout << "],\"shapes\":[";
        for (std::size_t i = 0; i < fingerings.size(); ++i) {
          if (i)
            std::cout << ',';
          std::cout << '[';
          for (std::size_t j = 0; j < fingerings[i].strings.size(); ++j) {
            if (j)
              std::cout << ',';
            std::cout << fingerings[i].strings[j].fret;
          }
          std::cout << ']';
        }
        std::cout << "]}\n";
      } else if (operation == "piano") {
        const gingo::Piano piano(88);
        std::set<std::vector<int>> rotations;
        for (int octave = -1; octave <= 9; ++octave) {
          const auto voicing =
              piano.voicing(chord, octave, gingo::VoicingStyle::Close);
          if (voicing.keys.size() != chord.size())
            continue;
          std::vector<int> keys;
          for (const auto &key : voicing.keys)
            keys.push_back(key.midi);
          // Additive inversion composition preserves Gingo's close-voicing
          // algorithm.
          for (std::size_t i = 0; i < keys.size(); ++i) {
            if (piano.in_range(keys.back()))
              rotations.insert(keys);
            const int first = keys.front();
            keys.erase(keys.begin());
            keys.push_back(first + 12);
          }
        }
        std::cout << "{\"lowest\":" << piano.lowest().midi
                  << ",\"highest\":" << piano.highest().midi
                  << ",\"rotations\":[";
        bool first = true;
        for (const auto &keys : rotations) {
          if (!first)
            std::cout << ',';
          first = false;
          std::cout << '[';
          for (std::size_t i = 0; i < keys.size(); ++i) {
            if (i)
              std::cout << ',';
            std::cout << keys[i];
          }
          std::cout << ']';
        }
        std::cout << "]}\n";
      } else {
        std::cout << "{\"error\":\"unknown operation\"}\n";
      }
    } catch (const std::exception &) {
      std::cout << "{\"error\":\"Gingo rejected operation\"}\n";
    }
  }
}
