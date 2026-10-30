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

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, OnceLock};

pub(crate) fn call_core(mut request: Value) -> Result<Value, String> {
    let operation = request["operation"].clone();
    let object = request
        .as_object_mut()
        .ok_or("core request must be an object")?;
    object.insert("apiVersion".into(), 1.into());
    object.insert("schemaVersion".into(), 1.into());
    let text =
        tuneforge_music_core::call_json(&request.to_string()).map_err(|error| error.to_string())?;
    let response: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    if response["apiVersion"] != 1
        || response["schemaVersion"] != 1
        || response["operation"] != operation
    {
        return Err("incompatible music core response".into());
    }
    response
        .get("result")
        .cloned()
        .ok_or("missing music core result".into())
}
fn core(request: Value) -> Value {
    call_core(request).expect("bundled music core operation")
}
impl PitchSpelling {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sharps => "sharps",
            Self::Flats => "flats",
            Self::Neutral => "neutral",
            Self::Dual => "dual",
        }
    }
}
struct Constants {
    values: Value,
    intervals: HashMap<String, Vec<usize>>,
}
fn constants() -> &'static Constants {
    static CONSTANTS: OnceLock<Constants> = OnceLock::new();
    CONSTANTS.get_or_init(|| {
        let values = core(json!({"operation": "nativeConstants"}));
        let intervals = values["quality_intervals"]
            .as_object()
            .expect("core intervals")
            .iter()
            .map(|(quality, values)| {
                (
                    quality.clone(),
                    values
                        .as_array()
                        .expect("interval array")
                        .iter()
                        .map(|value| value.as_u64().expect("interval integer") as usize)
                        .collect(),
                )
            })
            .collect();
        Constants { values, intervals }
    })
}
fn static_text(value: &str) -> Option<&'static str> {
    let data = &constants().values;
    for field in [
        "sharp_pitch_names",
        "flat_pitch_names",
        "neutral_pitch_names",
        "dual_pitch_names",
        "scale_degrees",
    ] {
        if let Some(found) = data[field]
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .find(|text| *text == value)
        {
            return Some(found);
        }
    }
    for (quality, suffix) in data["quality_suffixes"].as_object()? {
        if quality == value {
            return Some(quality.as_str());
        }
        if suffix.as_str() == Some(value) {
            return suffix.as_str();
        }
    }
    None
}
pub(crate) static SHARP_PITCH_NAMES: LazyLock<[&'static str; 12]> = LazyLock::new(|| {
    std::array::from_fn(|index| {
        constants().values["sharp_pitch_names"][index]
            .as_str()
            .expect("core pitch name")
    })
});
pub(crate) fn pitch_class_name(pitch_class: i64, spelling: PitchSpelling) -> &'static str {
    let value = core(
        json!({"operation":"nativePitchClassName", "pitch_class":pitch_class, "spelling":spelling.as_str()}),
    );
    static_text(value.as_str().expect("core pitch name")).expect("immutable core pitch name")
}
pub(crate) fn sharp_pitch_class(note: &str) -> Option<usize> {
    core(json!({"operation":"nativeSharpPitchClass", "input":note}))
        .as_u64()
        .map(|value| value as usize)
}
pub(crate) fn note_pitch_class(note: &str) -> Option<i64> {
    core(json!({"operation":"nativeNotePitchClass", "input":note})).as_i64()
}
pub(crate) fn parse_key(value: &str) -> Option<KeySignature> {
    key_from_value(&core(json!({"operation":"nativeParseKey", "input":value})))
}
pub(crate) fn key_from_value(value: &Value) -> Option<KeySignature> {
    Some(KeySignature {
        pitch_class: value["pitch_class"].as_i64()?,
        mode: match value["mode"].as_str()? {
            "major" => KeyMode::Major,
            "minor" => KeyMode::Minor,
            _ => return None,
        },
    })
}
pub(crate) fn key_value(key: Option<KeySignature>) -> Value {
    key.map_or(
        Value::Null,
        |key| json!({"pitch_class": key.pitch_class, "mode": key.mode.as_str()}),
    )
}
pub(crate) fn format_key(pitch_class: i64, mode: KeyMode, spelling: PitchSpelling) -> String {
    core(json!({"operation":"nativeFormatKey", "pitch_class":pitch_class,"mode":mode.as_str(),"spelling":spelling.as_str()})).as_str().expect("core key label").to_owned()
}
pub(crate) fn shortest_semitone_delta(source: i64, target: i64) -> i64 {
    core(json!({"operation":"shortestSemitoneDelta", "source":source,"target":target}))
        .as_i64()
        .expect("core semitone delta")
}
pub(crate) fn automatic_pitch_spelling(key: Option<KeySignature>) -> PitchSpelling {
    match core(json!({"operation":"nativeAutomaticPitchSpelling", "input":key_value(key)}))
        .as_str()
        .expect("core spelling")
    {
        "sharps" => PitchSpelling::Sharps,
        "flats" => PitchSpelling::Flats,
        "neutral" => PitchSpelling::Neutral,
        _ => panic!("invalid core spelling"),
    }
}
pub(crate) fn quality_suffix(quality: &str) -> Option<&'static str> {
    constants().values["quality_suffixes"]
        .get(quality)?
        .as_str()
}
pub(crate) fn quality_from_display_suffix(suffix: &str) -> Option<&'static str> {
    let value = core(json!({"operation":"nativeQualityFromSuffix", "input":suffix}));
    static_text(value.as_str()?)
}
pub(crate) fn quality_intervals(quality: &str) -> Option<&'static [usize]> {
    constants().intervals.get(quality).map(Vec::as_slice)
}
pub(crate) fn degree_name(relative_pitch_class: usize) -> Option<&'static str> {
    constants().values["scale_degrees"]
        .get(relative_pitch_class)?
        .as_str()
}
pub(crate) fn degree_pitch_class(root_pitch_class: usize, degree: &str) -> Option<usize> {
    core(json!({"operation":"nativeDegreePitchClass", "root":root_pitch_class,"degree":degree}))
        .as_u64()
        .map(|value| value as usize)
}
pub(crate) fn crema_quality_contains(label: &str, relative_pitch_class: usize) -> bool {
    core(json!({"operation":"nativeCremaContains", "input":label,"relative":relative_pitch_class}))
        .as_bool()
        .expect("core chord membership")
}
fn source_slice<'a>(raw: &'a str, range: &Value) -> Option<&'a str> {
    if range.is_null() {
        return None;
    }
    let start = range[0].as_u64().expect("core UTF-8 start") as usize;
    let end = range[1].as_u64().expect("core UTF-8 end") as usize;
    Some(raw.get(start..end).expect("core UTF-8 source range"))
}
pub(crate) fn parse_crema_model_label(raw: &str) -> CremaModelLabel<'_> {
    let value = core(json!({"operation":"nativeParseCrema", "input":raw}));
    match value["kind"].as_str().expect("core label kind") {
        "no_chord" => CremaModelLabel::NoChord,
        "unknown" => CremaModelLabel::Unknown,
        "chord" => {
            let raw_quality = source_slice(raw, &value["raw_quality_range"]);
            let borrowed = |field| {
                let text = value[field].as_str().expect("core chord string");
                static_text(text)
                    .or_else(|| raw_quality.filter(|raw| *raw == text))
                    .expect("core borrowed quality range")
            };
            CremaModelLabel::Chord(CremaChord {
                root_pitch_class: value["root_pitch_class"].as_u64().expect("core root") as usize,
                quality: borrowed("quality"),
                suffix: borrowed("suffix"),
                bass_degree: source_slice(raw, &value["bass_degree_range"]),
                bass_pitch_class: value["bass_pitch_class"]
                    .as_u64()
                    .map(|value| value as usize),
            })
        }
        _ => panic!("invalid core label kind"),
    }
}
pub(crate) fn parse_display_chord(label: &str) -> Option<ParsedChord> {
    let value = core(json!({"operation":"nativeParseChord", "input":label}));
    Some(ParsedChord {
        root_pitch_class: value["root_pitch_class"].as_i64()?,
        quality: static_text(value["quality"].as_str()?)?,
        bass_pitch_class: value["bass_pitch_class"].as_i64(),
    })
}
pub(crate) fn format_chord_with_suffix(
    root_pitch_class: i64,
    suffix: &str,
    bass_pitch_class: Option<i64>,
    spelling: PitchSpelling,
) -> String {
    core(json!({"operation":"nativeFormatChordSuffix", "root":root_pitch_class,"suffix":suffix,"bass":bass_pitch_class,"spelling":spelling.as_str()})).as_str().expect("core chord label").to_owned()
}
pub(crate) fn format_chord(
    root_pitch_class: i64,
    quality: &str,
    bass_pitch_class: Option<i64>,
    spelling: PitchSpelling,
) -> Option<String> {
    core(json!({"operation":"nativeFormatChord", "root":root_pitch_class,"quality":quality,"bass":bass_pitch_class,"spelling":spelling.as_str()})).as_str().map(str::to_owned)
}
pub(crate) fn round3(value: f64) -> f64 {
    core(json!({"operation":"nativeRound3", "input":value}))
        .as_f64()
        .expect("core rounded number")
}
#[cfg(test)]
mod transport_tests {
    use super::*;
    #[test]
    fn unsupported_crema_labels_remain_unknown() {
        for index in 0..1000 {
            let source = format!("C:unknown-{index}-é/bass-{index}");
            assert!(matches!(parse_crema_model_label(&source), CremaModelLabel::Unknown));
        }
    }
    #[test]
    fn crema_aliases_keep_semantic_sixths_and_borrow_the_bass_degree() {
        let source = String::from("C:min6/b3");
        let CremaModelLabel::Chord(chord) = parse_crema_model_label(&source) else {
            panic!("chord")
        };
        assert_eq!(chord.quality, "min6");
        assert_eq!(chord.suffix, "m6");
        assert_eq!(chord.bass_pitch_class, Some(3));
        assert!(std::ptr::eq(chord.bass_degree.unwrap().as_ptr(), source[7..].as_ptr()));
    }
}
