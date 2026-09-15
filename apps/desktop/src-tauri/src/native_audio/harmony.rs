#![cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PitchSpelling {
    Sharps,
    Flats,
    Neutral,
    Dual,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum KeyMode {
    Major,
    Minor,
}

impl KeyMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Major => "major",
            Self::Minor => "minor",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct KeySignature {
    pub(crate) pitch_class: i64,
    pub(crate) mode: KeyMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ParsedChord {
    pub(crate) root_pitch_class: i64,
    pub(crate) quality: &'static str,
    pub(crate) bass_pitch_class: Option<i64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct CremaChord<'a> {
    pub(crate) root_pitch_class: usize,
    pub(crate) quality: &'a str,
    pub(crate) suffix: &'a str,
    pub(crate) bass_degree: Option<&'a str>,
    pub(crate) bass_pitch_class: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CremaModelLabel<'a> {
    NoChord,
    Unknown,
    Chord(CremaChord<'a>),
}

pub(crate) const SHARP_PITCH_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

const FLAT_PITCH_NAMES: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
];
const NEUTRAL_PITCH_NAMES: [&str; 12] = [
    "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];
const DUAL_PITCH_NAMES: [&str; 12] = [
    "C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B",
];
const SCALE_DEGREES: [&str; 12] = [
    "1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7",
];

const MAJOR_INTERVALS: &[usize] = &[0, 4, 7];
const MINOR_INTERVALS: &[usize] = &[0, 3, 7];
const DOMINANT_SEVENTH_INTERVALS: &[usize] = &[0, 4, 7, 10];
const FLAT_FIVE_SEVENTH_INTERVALS: &[usize] = &[0, 4, 6, 10];
const MAJOR_SEVENTH_INTERVALS: &[usize] = &[0, 4, 7, 11];
const MINOR_SEVENTH_INTERVALS: &[usize] = &[0, 3, 7, 10];
const MAJOR_SIXTH_INTERVALS: &[usize] = &[0, 4, 7, 9];
const MINOR_SIXTH_INTERVALS: &[usize] = &[0, 3, 7, 9];
const MINOR_MAJOR_SEVENTH_INTERVALS: &[usize] = &[0, 3, 7, 11];
const SUSPENDED_SECOND_INTERVALS: &[usize] = &[0, 2, 7];
const SUSPENDED_FOURTH_INTERVALS: &[usize] = &[0, 5, 7];
const DIMINISHED_INTERVALS: &[usize] = &[0, 3, 6];
const DIMINISHED_SEVENTH_INTERVALS: &[usize] = &[0, 3, 6, 9];
const HALF_DIMINISHED_SEVENTH_INTERVALS: &[usize] = &[0, 3, 6, 10];
const AUGMENTED_INTERVALS: &[usize] = &[0, 4, 8];

pub(crate) fn pitch_class_name(pitch_class: i64, spelling: PitchSpelling) -> &'static str {
    let index = pitch_class.rem_euclid(12) as usize;
    match spelling {
        PitchSpelling::Sharps => SHARP_PITCH_NAMES[index],
        PitchSpelling::Flats => FLAT_PITCH_NAMES[index],
        PitchSpelling::Neutral => NEUTRAL_PITCH_NAMES[index],
        PitchSpelling::Dual => DUAL_PITCH_NAMES[index],
    }
}

pub(crate) fn sharp_pitch_class(note: &str) -> Option<usize> {
    SHARP_PITCH_NAMES.iter().position(|value| *value == note)
}

pub(crate) fn note_pitch_class(note: &str) -> Option<i64> {
    match note.to_ascii_uppercase().as_str() {
        "C" | "B#" => Some(0),
        "C#" | "DB" => Some(1),
        "D" => Some(2),
        "D#" | "EB" => Some(3),
        "E" | "FB" => Some(4),
        "F" | "E#" => Some(5),
        "F#" | "GB" => Some(6),
        "G" => Some(7),
        "G#" | "AB" => Some(8),
        "A" => Some(9),
        "A#" | "BB" => Some(10),
        "B" | "CB" => Some(11),
        _ => None,
    }
}

pub(crate) fn parse_key(value: &str) -> Option<KeySignature> {
    let normalized = value.trim();
    if let Some((pitch, mode)) = normalized.split_once(':') {
        let pitch_class = pitch.parse::<i64>().ok()?;
        let mode = match mode.to_ascii_lowercase().as_str() {
            "major" => KeyMode::Major,
            "minor" => KeyMode::Minor,
            _ => return None,
        };
        return (0..=11)
            .contains(&pitch_class)
            .then_some(KeySignature { pitch_class, mode });
    }
    let mut parts = normalized.split_whitespace();
    let pitch_class = note_pitch_class(parts.next()?)?;
    let mode = match parts
        .next()
        .unwrap_or("major")
        .to_ascii_lowercase()
        .as_str()
    {
        "minor" | "m" => KeyMode::Minor,
        _ => KeyMode::Major,
    };
    Some(KeySignature { pitch_class, mode })
}

pub(crate) fn format_key(pitch_class: i64, mode: KeyMode, spelling: PitchSpelling) -> String {
    format!(
        "{} {}",
        pitch_class_name(pitch_class, spelling),
        mode.as_str()
    )
}

pub(crate) fn shortest_semitone_delta(source: i64, target: i64) -> i64 {
    let upward = (target - source).rem_euclid(12);
    if upward <= 6 {
        upward
    } else {
        upward - 12
    }
}

pub(crate) fn automatic_pitch_spelling(key: Option<KeySignature>) -> PitchSpelling {
    const MAJOR: [PitchSpelling; 12] = [
        PitchSpelling::Neutral,
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
        PitchSpelling::Sharps,
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
    ];
    const MINOR: [PitchSpelling; 12] = [
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
        PitchSpelling::Flats,
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
        PitchSpelling::Neutral,
        PitchSpelling::Flats,
        PitchSpelling::Sharps,
    ];
    key.map_or(PitchSpelling::Neutral, |key| {
        if key.mode == KeyMode::Minor {
            MINOR[key.pitch_class.rem_euclid(12) as usize]
        } else {
            MAJOR[key.pitch_class.rem_euclid(12) as usize]
        }
    })
}

pub(crate) fn quality_suffix(quality: &str) -> Option<&'static str> {
    match quality {
        "major" => Some(""),
        "minor" => Some("m"),
        "7" => Some("7"),
        "7b5" => Some("7b5"),
        "maj7" => Some("maj7"),
        "m7" => Some("m7"),
        "sus2" => Some("sus2"),
        "sus4" => Some("sus4"),
        "dim" => Some("dim"),
        "aug" => Some("aug"),
        "dim7" => Some("dim7"),
        "hdim7" => Some("m7b5"),
        _ => None,
    }
}

pub(crate) fn quality_from_display_suffix(suffix: &str) -> Option<&'static str> {
    match suffix {
        "" => Some("major"),
        "m" => Some("minor"),
        "7" => Some("7"),
        "7b5" => Some("7b5"),
        "maj7" => Some("maj7"),
        "m7" => Some("m7"),
        "sus2" => Some("sus2"),
        "sus4" => Some("sus4"),
        "dim" => Some("dim"),
        "aug" => Some("aug"),
        "dim7" => Some("dim7"),
        "m7b5" => Some("hdim7"),
        _ => None,
    }
}

pub(crate) fn quality_intervals(quality: &str) -> Option<&'static [usize]> {
    match quality {
        "major" | "maj" => Some(MAJOR_INTERVALS),
        "minor" | "min" => Some(MINOR_INTERVALS),
        "7" => Some(DOMINANT_SEVENTH_INTERVALS),
        "7b5" => Some(FLAT_FIVE_SEVENTH_INTERVALS),
        "maj7" => Some(MAJOR_SEVENTH_INTERVALS),
        "m7" | "min7" => Some(MINOR_SEVENTH_INTERVALS),
        "maj6" => Some(MAJOR_SIXTH_INTERVALS),
        "min6" => Some(MINOR_SIXTH_INTERVALS),
        "minmaj7" => Some(MINOR_MAJOR_SEVENTH_INTERVALS),
        "sus2" => Some(SUSPENDED_SECOND_INTERVALS),
        "sus4" => Some(SUSPENDED_FOURTH_INTERVALS),
        "dim" => Some(DIMINISHED_INTERVALS),
        "dim7" => Some(DIMINISHED_SEVENTH_INTERVALS),
        "hdim7" => Some(HALF_DIMINISHED_SEVENTH_INTERVALS),
        "aug" => Some(AUGMENTED_INTERVALS),
        _ => None,
    }
}

pub(crate) fn degree_name(relative_pitch_class: usize) -> Option<&'static str> {
    SCALE_DEGREES.get(relative_pitch_class).copied()
}

pub(crate) fn degree_pitch_class(root_pitch_class: usize, degree: &str) -> Option<usize> {
    SCALE_DEGREES
        .iter()
        .position(|value| *value == degree)
        .map(|relative| (root_pitch_class + relative) % 12)
}

pub(crate) fn crema_quality_contains(label: &str, relative_pitch_class: usize) -> bool {
    quality_intervals(label.split(':').nth(1).unwrap_or("maj"))
        .is_some_and(|intervals| intervals.contains(&relative_pitch_class))
}

fn normalize_crema_quality(raw_quality: &str) -> (&str, &str) {
    let quality = match raw_quality {
        "maj" | "maj6" => "major",
        "min" | "min6" | "minmaj7" => "minor",
        "min7" => "m7",
        "hdim7" => "hdim7",
        other => other,
    };
    (quality, quality_suffix(quality).unwrap_or(quality))
}

pub(crate) fn parse_crema_model_label(raw: &str) -> CremaModelLabel<'_> {
    if raw == "N" {
        return CremaModelLabel::NoChord;
    }
    if raw == "X" {
        return CremaModelLabel::Unknown;
    }
    let (body, bass_degree) = raw
        .split_once('/')
        .map_or((raw, None), |(body, bass)| (body, Some(bass)));
    let (root, raw_quality) = body.split_once(':').unwrap_or((body, "maj"));
    let root_pitch_class = sharp_pitch_class(root).unwrap_or(0);
    let (quality, suffix) = normalize_crema_quality(raw_quality);
    CremaModelLabel::Chord(CremaChord {
        root_pitch_class,
        quality,
        suffix,
        bass_degree,
        bass_pitch_class: bass_degree
            .and_then(|degree| degree_pitch_class(root_pitch_class, degree)),
    })
}

pub(crate) fn parse_display_chord(label: &str) -> Option<ParsedChord> {
    let trimmed = label.trim();
    if trimmed.eq_ignore_ascii_case("N.C.") || trimmed.eq_ignore_ascii_case("N.C") {
        return None;
    }
    let (main, bass) = trimmed
        .split_once('/')
        .map_or((trimmed, None), |(main, bass)| (main, Some(bass)));
    let mut chars = main.char_indices();
    let (_, root) = chars.next()?;
    if !(('A'..='G').contains(&root.to_ascii_uppercase())) {
        return None;
    }
    let mut root_end = root.len_utf8();
    if let Some((index, accidental)) = chars.next() {
        if accidental == '#' || accidental == 'b' {
            root_end = index + accidental.len_utf8();
        }
    }
    let root_pitch_class = note_pitch_class(&main[..root_end])?;
    let quality = quality_from_display_suffix(&main[root_end..])?;
    let bass_pitch_class = bass.and_then(note_pitch_class);
    if bass.is_some() && bass_pitch_class.is_none() {
        return None;
    }
    Some(ParsedChord {
        root_pitch_class,
        quality,
        bass_pitch_class,
    })
}

pub(crate) fn format_chord_with_suffix(
    root_pitch_class: i64,
    suffix: &str,
    bass_pitch_class: Option<i64>,
    spelling: PitchSpelling,
) -> String {
    let root = root_pitch_class.rem_euclid(12);
    let bass = bass_pitch_class.map(|pitch| pitch.rem_euclid(12));
    let bass_label = bass
        .filter(|pitch| *pitch != root)
        .map(|pitch| format!("/{}", pitch_class_name(pitch, spelling)))
        .unwrap_or_default();
    format!(
        "{}{}{}",
        pitch_class_name(root, spelling),
        suffix,
        bass_label
    )
}

pub(crate) fn format_chord(
    root_pitch_class: i64,
    quality: &str,
    bass_pitch_class: Option<i64>,
    spelling: PitchSpelling,
) -> Option<String> {
    Some(format_chord_with_suffix(
        root_pitch_class,
        quality_suffix(quality)?,
        bass_pitch_class,
        spelling,
    ))
}

pub(crate) fn round3(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}
