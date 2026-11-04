import { fileURLToPath } from "node:url";
// Test input builders only. Folded tokens, cursor advances, chord labels and
// complete output strings are independent literals in the shared tables.
const lyric = (text, start_seconds, end_seconds, words) => ({ text, start_seconds, end_seconds, ...(words === undefined ? {} : { words }), });
const word = (text, start_seconds, end_seconds) => ({ text, start_seconds, end_seconds });
const chord = (label, start_seconds) => ({ label, start_seconds });
const preparedWord = ([token, cursor_advance, start_seconds, end_seconds]) => ({ token, cursor_advance, start_seconds, end_seconds, });
const preparedLyric = ([text, search_text, start_seconds, end_seconds, words]) => ({ text, search_text, start_seconds, end_seconds, words: words.map(preparedWord), });
const request = (lyrics, chords = [], document_id = "lyrics_with_chords") => ({ operation: "renderDocumentText", document_id, lyrics, chords: chords.map(chord => ({ ...chord })), });
const shared = value => ({ backend: value, native: value });
const runtimeValue = (values, runtime) => values.common ?? values[runtime];
export function documentExamples() {
  const cases = [];
  const context = { transpose_semitones: 0, active_key: null, display_mode: "sharps" };
  const add = (id, fields, prepared) => cases.push({ id, document_id: "lyrics_with_chords", context, ...fields, prepared, });
  // Raw strings pass unchanged into plain requests, including the CR boundary.
  for (const [id, texts, expected] of [
    ["empty", [], "\n"],
    ["newline-only", ["\r\n\n\r"], "\n"],
    ["whitespace", ["  \t  "], "  \t  \n"],
    ["raw-cr-boundary", ["A\r", "B"], "A\nB\n"],
    ["mixed-newlines", ["A\r\nB\rC\n\n"], "A\nB\nC\n"],
    ["multilingual", ["Olá 世界 🙂 é"], "Olá 世界 🙂 é\n"],
  ])
    add("plain-" + id, { document_id: "lyrics", lyrics: texts.map(text => ({ text })),
      chords: [], expected: { common: expected } }, shared(request(texts.map(text => ({ text })), [], "lyrics")));
  add("plain-coercions", {
    document_id: "lyrics",
    lyrics: [{ text: null }, { text: true }, { text: 17 }, { text: 2.5 }, { text: ["a", false] }, { text: { x: 1 } }, {}], chords: [],
    expected: { backend: "None\nTrue\n17\n2.5\n['a', False]\n{'x': 1}\n", native: "\n" }
  }, {
    backend: request([
      { text: "None" },
      { text: "True" },
      { text: "17" },
      { text: "2.5" },
      { text: "['a', False]" },
      { text: "{'x': 1}" },
      { text: "" }
    ], [], "lyrics"), native: request([{ text: "" }, { text: "" }, { text: "" }, { text: "" }, { text: "" }, { text: "" }, { text: "" }], [], "lyrics")
  });
  add("nonobject-lyrics", {
    document_id: "lyrics",
    lyrics: [null, 17, "raw", false], chords: [],
    expected: { native: "\n" }, expected_error: { backend: true }
  }, { native: request([{ text: "" }, { text: "" }, { text: "" }, { text: "" }], [], "lyrics") });
  add("plain-ignores-unused-chords", { document_id: "lyrics",
    lyrics: [{ text: "safe" }], chords: [null, {}, false],
    expected: { common: "safe\n" } }, shared(request([{ text: "safe" }], [], "lyrics")));
  // Timed Unicode: explicit fold results and advances; no casing in the builder.
  for (const [id, text, wordTexts, preprocessing, expected] of [
    [
      "sharp-s", "Straße X",
      ["STRASSE", "X"],
      {
        native: { search: "straße x", words: [["strasse", 7], ["x", 1]] },
        backend: { search: "strasse x", words: [["strasse", 7], ["x", 1]] }
      },
      { backend: "C       G\nStraße X\n",
        native: " C     G\nStraße X\n" }
    ],
    [
      "capital-sharp-s", "STRAẞE X",
      ["straße", "X"],
      {
        native: { search: "straße x", words: [["straße", 6], ["x", 1]] }, backend: { search: "strasse x", words: [["strasse", 6], ["x", 1]] }
      },
      { backend: "C       G\nSTRAẞE X\n", native: "C      G\nSTRAẞE X\n" }
    ],
    [
      "ligature", "ﬃ X",
      ["FFI", "X"],
      {
        native: { search: "ﬃ x", words: [["ffi", 3], ["x", 1]] },
        backend: { search: "ffi x", words: [["ffi", 3], ["x", 1]] }
      },
      { backend: "C   G\nﬃ X\n",
        native: "C G\nﬃ X\n" }
    ],
    [
      "dotted-i", "İ X",
      ["İ", "X"],
      {
        native: { search: "i̇ x", words: [["i̇", 2], ["x", 1]] },
        backend: { search: "i̇ x", words: [["i̇", 1], ["x", 1]] }
      },
      { common: "C  G\nİ X\n" }
    ],
    [
      "final-sigma", "ΟΣ X",
      ["οσ", "X"],
      {
        native: { search: "ος x", words: [["οσ", 2], ["x", 1]] },
        backend: { search: "οσ x", words: [["οσ", 2], ["x", 1]] }
      },
      { common: "C  G\nΟΣ X\n" }
    ],
    [
      "combining", "é X",
      ["é", "X"],
      { common: { search: "é x", words: [["é", 2], ["x", 1]] } },
      { common: "C  G\né X\n" }
    ],
    [
      "supplementary", "🙂 X",
      ["🙂", "X"],
      { common: { search: "🙂 x", words: [["🙂", 1], ["x", 1]] } },
      { common: "C G\n🙂 X\n" }
    ],
    [
      "multilingual", "Olá 世界",
      ["OLÁ", "世界"],
      { common: { search: "olá 世界", words: [["olá", 3], ["世界", 2]] } },
      { common: "C   G\nOlá 世界\n" }
    ],
  ]) {
    const words = wordTexts.map((text, index) => word(text, index * 2, (index + 1) * 2));
    const chords = [chord("C", 0.5), chord("G", 2.5)];
    const prepared = {};
    for (const runtime of ["backend", "native"]) {
      const values = runtimeValue(preprocessing, runtime);
      const words = values.words.map(([token, advance], index) => [token, advance, index * 2, (index + 1) * 2]);
      prepared[runtime] = request([preparedLyric([text, values.search, 0, 4, words])], chords);
    }
    add("timed-" + id, { lyrics: [lyric(text, 0, 4, words)], chords, expected }, prepared);
  }
  // Named layout constraints; expected strings and prepared DTO rows stay literal.
  add("empty-combined", { lyrics: [],
    chords: [],
    expected: { common: "\n" } }, shared(request([], [])));
  add("cr-search", {
    lyrics: [lyric("A\r\nB\r C", 0, 4, [word("A", 0, 1), word("B", 1, 2), word("C", 2, 4)])],
    chords: [chord("C", 0.5), chord("F", 1.5), chord("G", 3)],
    expected: { common: "C F  G\nA\nB\n C\n" }
  }, shared(request([
    preparedLyric(["A\r\nB\r C", "a\r\nb\r c", 0.0, 4.0, [["a", 1, 0.0, 1.0], ["b", 1, 1.0, 2.0], ["c", 1, 2.0, 4.0]]])
  ], [chord("C", 0.5), chord("F", 1.5), chord("G", 3.0)])));
  add("internal-token-cr", {
    lyrics: [lyric("A\r\nB X", 0, 4, [word("A\r\nB", 0, 2), word("X", 2, 4)])],
    chords: [chord("C", 0.5), chord("G", 2.5)],
    expected: { common: "C   G\nA\nB X\n" }
  }, shared(request([preparedLyric(["A\r\nB X", "a\r\nb x", 0.0, 4.0, [["a\r\nb", 4, 0.0, 2.0], ["x", 1, 2.0, 4.0]]])], [chord("C", 0.5), chord("G", 2.5)])));
  add("unmatched-selected-word", {
    lyrics: [lyric("hello world", 0, 4, [word("hello", 0, 1), word("missing", 1, 3), word("world", 3, 4)])],
    chords: [chord("C", 2)],
    expected: { common: "     C\nhello world\n" }
  }, shared(request([
    preparedLyric([
      "hello world", "hello world", 0.0, 4.0,
      [["hello", 5, 0.0, 1.0], ["missing", 7, 1.0, 3.0], ["world", 5, 3.0, 4.0]]
    ])
  ], [chord("C", 2.0)])));
  add("all-unmatched", {
    lyrics: [lyric("hello world", 0, 4, [word("missing", 0, 4)])],
    chords: [chord("C", 2)],
    expected: { common: "     C\nhello world\n" }
  }, shared(request([preparedLyric(["hello world", "hello world", 0.0, 4.0, [["missing", 7, 0.0, 4.0]]])], [chord("C", 2.0)])));
  add("zero-and-reversed-words", {
    lyrics: [lyric("A B C", 0, 4, [word("A", 0, 0), word("B", 2, 1), word("C", 2, 4)])],
    chords: [chord("C", 0), chord("F", 1), chord("G", 3)],
    expected: { common: "    C F G\nA B C\n" }
  }, shared(request([preparedLyric(["A B C", "a b c", 0.0, 4.0, [["a", 1, 0.0, 0.0], ["b", 1, 2.0, 1.0], ["c", 1, 2.0, 4.0]]])], [chord("C", 0.0), chord("F", 1.0), chord("G", 3.0)])));
  add("invalid-word-timing", {
    lyrics: [lyric("A B", 0, 4, [null, 17, { text: true }, word("A", "bad", 2), word("B", 2, null)])],
    chords: [chord("C", 1), chord("G", 3)],
    expected: { common: "C G\nA B\n" }
  }, shared(request([
    preparedLyric([
      "A B", "a b", 0.0, 4.0,
      [["", 0, null, null], ["", 0, null, null], ["", 0, null, null], ["a", 1, null, 2.0], ["b", 1, 2.0, null]]
    ])
  ], [chord("C", 1.0), chord("G", 3.0)])));
  add("boolean-timing", {
    lyrics: [lyric("A B", false, 4, [word("A", false, true), word("B", true, 4)])],
    chords: [chord("C", false), chord("G", true)],
    expected: { backend: "C G\nA B\n", native: "A B\n\nC G\n" }
  }, {
    backend: request([preparedLyric(["A B", "a b", 0.0, 4.0, [["a", 1, 0.0, 1.0], ["b", 1, 1.0, 4.0]]])], [chord("C", 0.0), chord("G", 1.0)]),
    native: request([preparedLyric(["A B", "a b", null, 4.0, [["a", 1, null, null], ["b", 1, null, 4.0]]])], [chord("C", null), chord("G", null)])
  });
  add("missing-invalid-timings", {
    lyrics: [{ text: "missing" }, lyric("reversed", 4, 2), lyric("zero", 5, 5), lyric("bad", "0", 8)],
    chords: [chord("C", null), chord("G", "bad"), chord("F", 3)],
    expected: { common: "missing\n\nF\n\nreversed\n\nzero\n\nbad\n\nC G\n" }
  }, shared(request([
    preparedLyric(["missing", "missing", null, null, []]), preparedLyric(["reversed", "reversed",
      4.0, 2.0, []]), preparedLyric(["zero", "zero", 5.0, 5.0, []]), preparedLyric(["bad", "bad", null, 8.0, []])
  ], [chord("C", null), chord("G", null), chord("F", 3.0)])));
  add("gaps-overlap-order", {
    lyrics: [lyric("first", 2, 4), lyric("overlap", 1, 3), lyric("last", 7, 8)],
    chords: [
      chord("G", 9), chord("C", 0), chord("F", 2.5), chord("Am", 5), chord("D", 7.5), chord("Em", 2.5),
      chord("B", null)
    ],
    expected: { common: "C\n\n F Em\nfirst\n\noverlap\n\nAm\n\n  D\nlast\n\nG B\n" }
  }, shared(request([
    preparedLyric(["first", "first", 2.0, 4.0, []]), preparedLyric(["overlap", "overlap", 1.0, 3.0, []]), preparedLyric(["last", "last", 7.0, 8.0, []])
  ], [
    chord("G", 9.0), chord("C", 0.0), chord("F", 2.5),
    chord("Am", 5.0), chord("D", 7.5), chord("Em", 2.5), chord("B", null)
  ])));
  add("collision", {
    lyrics: [lyric("abc", 0, 4)],
    chords: [chord("Cmaj7", 0), chord("G/B", 0), chord("N.C.", 0), chord("mystery", 3)],
    expected: { common: "Cmaj7 G/B N.C. mystery\nabc\n" }
  }, shared(request([preparedLyric(["abc", "abc", 0.0, 4.0, []])], [chord("Cmaj7", 0.0), chord("G/B", 0.0),
    chord("N.C.", 0.0), chord("mystery", 3.0)])));
  add("empty-label-and-malformed-chords", {
    lyrics: [lyric("words", 0, 4)],
    chords: [null, 4, {}, chord("", 0), { display_label: "  ", label: "   ", start_seconds: 1 }, chord(" G ", 2)],
    expected: { backend: "  G\nwords\n" }, expected_error: { native: true }
  }, {
    backend: request([preparedLyric(["words", "words", 0.0, 4.0, []])], [chord("", null), chord("", 0.0),
      chord("", 1.0), chord("G", 2.0)])
  });
  add("non-string-combined", {
    lyrics: [lyric(null, 0, 1), lyric(false, 1, 2), lyric({ x: [1] }, 2, 3)],
    chords: [chord("C", 0), chord("G", 1), chord("F", 2)],
    expected: { backend: "C\nNone\n\nG\nFalse\n\nF\n{'x': [1]}\n", native: "C\n\n\nG\n\n\nF\n" }
  }, {
    backend: request([
      preparedLyric(["None", "none", 0.0, 1.0, []]), preparedLyric(["False", "false", 1.0, 2.0, []]), preparedLyric(["{'x': [1]}", "{'x': [1]}", 2.0, 3.0, []])
    ], [chord("C", 0.0), chord("G", 1.0),
      chord("F", 2.0)]),
    native: request([
      preparedLyric(["", "", 0.0, 1.0, []]), preparedLyric(["", "", 1.0, 2.0, []]),
      preparedLyric(["", "", 2.0, 3.0, []])
    ], [chord("C", 0.0), chord("G", 1.0), chord("F", 2.0)])
  });
  add("combined-newline-whitespace", {
    lyrics: [lyric("\n\r\n", 0, 4), lyric("  \t  ", 5, 7)],
    chords: [chord("C", 0), chord("G", 6)],
    expected: { common: "C\n\n\n\n\n  G\n  \t  \n" }
  }, shared(request([preparedLyric(["\n\r\n", "\n\r\n", 0.0, 4.0, []]), preparedLyric(["  \t  ", "  \t  ", 5.0, 7.0, []])], [chord("C", 0.0), chord("G", 6.0)])));
  // Every display mode keeps its independently fixed labels and complete text.
  for (const [mode, labels, expected] of [
    ["sharps", ["C#m7b5/G#", "N.C.", "mystery", "mystery"], "C#m7b5/G# N.C. mystery mystery\none two\n"],
    ["flats", ["Dbm7b5/Ab", "N.C.", "mystery", "mystery"], "Dbm7b5/Ab N.C. mystery mystery\none two\n"],
    [
      "dual",
      ["C#m7b5/G# / Dbm7b5/Ab", "N.C.", "mystery", "mystery"],
      "C#m7b5/G# / Dbm7b5/Ab N.C. mystery mystery\none two\n"
    ],
    ["neutral", ["C#m7b5/Ab", "N.C.", "mystery", "mystery"], "C#m7b5/Ab N.C. mystery mystery\none two\n"],
    ["auto", ["C#m7b5/G#", "N.C.", "mystery", "mystery"], "C#m7b5/G# N.C. mystery mystery\none two\n"],
  ]) {
    const chords = [
      chord("C#m7b5/G#", 0), chord("N.C.", 1), chord("mystery", 2),
      { display_label: "  mystery  ",
        start_seconds: 3 }
    ];
    const prepared = request([preparedLyric(["one two", "one two", 0, 4, []])], labels.map(chord));
    add("spelling-" + mode, {
      lyrics: [lyric("one two", 0, 4)], chords,
      context: { transpose_semitones: 0, active_key: { pitch_class: 1, mode: "minor" }, display_mode: mode },
      expected: { common: expected }
    }, shared(prepared));
  }
  for (const [id, overrideKey, metadata, context, labels, expected] of [
    [
      "source-correction", "D major",
      {},
      { active_key: { mode: "major", pitch_class: 2 }, display_mode: "auto",
        transpose_semitones: 2 },
      ["D/A", "C#/G"],
      "D/A C#/G\none two\n"
    ],
    [
      "transpose", null,
      { transpose: { semitones: 3 } },
      { active_key: { mode: "major", pitch_class: 3 },
        display_mode: "auto", transpose_semitones: 3 },
      ["Eb/Bb", "D/Ab"],
      "Eb/Bb D/Ab\none two\n"
    ],
    [
      "correction-and-transpose", "D major",
      { transpose: { semitones: 3 } },
      { active_key: { mode: "major",
          pitch_class: 5 }, display_mode: "auto", transpose_semitones: 5 },
      ["F/C", "E/Bb"],
      "F/C E/Bb\none two\n"
    ],
    [
      "retune-only", null,
      { retune: { cents: 25 } },
      { active_key: { mode: "major", pitch_class: 0 },
        display_mode: "auto", transpose_semitones: 0 },
      ["C/G", "B/F"],
      "C/G B/F\none two\n"
    ],
  ]) {
    const chords = [chord("C/G", 0), { label: "B/F", pitch_class: 11, quality: "major", bass_pitch_class: 5,
        start_seconds: 2 }];
    const prepared = request([preparedLyric(["one two", "one two", 0, 4, []])], labels.map((label, index) => chord(label, index * 2)));
    add(id, {
      lyrics: [lyric("one two", 0, 4)], chords, context,
      context_input: {
        detected_key: "C major", override_key: overrideKey,
        audio_set: { type: "preview_mix", metadata }, display_mode: "auto"
      },
      expected: { common: expected }
    }, shared(prepared));
  }
  // Each sign/magnitude exercises segment-only, chord and word-timed documents.
  for (const [name, number] of [["positive", 1e-310], ["negative", -1e-310], ["minimum-positive", 5e-324], ["minimum-negative", -5e-324],]) {
    for (const withChords of [false, true]) {
      const chords = withChords ? [chord("C", 0.5)] : [];
      add("subnormal-" + name + (withChords ? "-chords" : "-lyrics"), { lyrics: [lyric("A", number, 1)], chords,
        expected: { common: withChords ? "C\nA\n" : "A\n" }, }, shared(request([preparedLyric(["A", "a", number, 1, []])], chords)));
    }
    const chords = [chord("C", 0.5)];
    add("subnormal-word-" + name, { lyrics: [lyric("A", 0, 1, [word("A", number, 1)])], chords,
      expected: { common: "C\nA\n" }, }, shared(request([preparedLyric(["A", "a", 0, 1, [["a", 1, number, 1]]])], chords)));
  }
  return {
    schemaVersion: 1,
    provenance: "Expected strings frozen from the pre-extraction Python and native renderers; synthetic inputs only.",
    cases, saved_json_cases: [
      { id: "truncated", raw: "[{\"text\":" },
      { id: "object",
        raw: "{\"text\":\"saved\"}" },
      { id: "null", raw: "null" }
    ]
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // serde_json distinguishes 4.0 from 4. Keep expected timestamp floats while
  // leaving raw input number kinds and all cursor advances untouched.
  const examples = documentExamples();
  const timestamps = new WeakSet();
  for (const example of examples.cases)
    for (const prepared of Object.values(example.prepared)) {
      for (const lyric of prepared.lyrics) {
        timestamps.add(lyric);
        for (const word of lyric.words ?? [])
          timestamps.add(word);
      }
      for (const chord of prepared.chords)
        timestamps.add(chord);
    }
  process.stdout.write(JSON.stringify(examples, function (key, value) {
    return timestamps.has(this) && ["start_seconds", "end_seconds"].includes(key) && Number.isInteger(value)
      ? JSON.rawJSON(Object.is(value, -0) ? "-0.0" : value + ".0") : value;
  }));
}
