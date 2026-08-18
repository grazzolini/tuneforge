use super::*;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    fs::{self, File},
    io::{self, Cursor, Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};

#[cfg(target_os = "android")]
use crate::file_dialog_scope::{
    pick_user_selected_export_save_path, validate_user_selected_write_selection,
};
#[cfg(target_os = "android")]
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

const COPY_BUFFER_BYTES: usize = 64 * 1024;
const EXPORT_INTERRUPTED_MESSAGE: &str =
    "Export was interrupted when TuneForge restarted. A partial provider file may remain; choose Export again to retry.";
const EXPORT_WORKER_FAILED_MESSAGE: &str =
    "Export could not continue after the picker opened. A provider may retain partial output.";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MobileExportRequest {
    #[serde(default)]
    artifact_ids: Vec<String>,
    #[serde(default)]
    generated_document_ids: Vec<String>,
    #[serde(default = "default_wav_format")]
    output_format: String,
    filename_base: Option<String>,
    document_audio_set_artifact_id: Option<String>,
    document_chord_display_mode: Option<String>,
}

fn default_wav_format() -> String {
    "wav".to_string()
}

enum ExportContent {
    File(PathBuf),
    Memory(Vec<u8>),
}

impl ExportContent {
    fn reader(&self) -> Result<Box<dyn Read + '_>, String> {
        match self {
            Self::File(path) => File::open(path)
                .map(|file| Box::new(file) as Box<dyn Read>)
                .map_err(|_| "Selected project audio is missing or unreadable.".to_string()),
            Self::Memory(bytes) => Ok(Box::new(Cursor::new(bytes.as_slice()))),
        }
    }
}

struct ExportSnapshot {
    source_artifact_id: Option<String>,
    generated_document_id: Option<String>,
    output_name: String,
    extension: &'static str,
    filter_name: &'static str,
    format: &'static str,
    content: ExportContent,
}

#[derive(Debug, PartialEq, Eq)]
enum Readback {
    Verified { size_bytes: u64, sha256: String },
    Unsupported { size_bytes: u64, sha256: String },
}

trait ExportProvider {
    type Target;

    fn create_document(
        &self,
        output_name: &str,
        filter_name: &str,
        extension: &str,
    ) -> Result<Option<Self::Target>, String>;

    fn write_and_readback(
        &self,
        target: &Self::Target,
        content: &ExportContent,
        should_cancel: &mut dyn FnMut() -> Result<bool, String>,
    ) -> Result<Readback, String>;

    fn receipt_reference(&self, target: &Self::Target) -> String;
}

#[cfg(target_os = "android")]
struct AndroidExportProvider<'a> {
    app: &'a AppHandle,
}

#[cfg(target_os = "android")]
impl ExportProvider for AndroidExportProvider<'_> {
    type Target = FilePath;

    fn create_document(
        &self,
        output_name: &str,
        filter_name: &str,
        extension: &str,
    ) -> Result<Option<Self::Target>, String> {
        let selection = pick_user_selected_export_save_path(
            self.app,
            "Export from TuneForge",
            output_name.to_string(),
            filter_name,
            extension,
        );
        if let Some(selection) = selection.as_ref() {
            validate_user_selected_write_selection(selection).map_err(|_| {
                "The system picker returned an unsupported export target.".to_string()
            })?;
        }
        Ok(selection)
    }

    fn write_and_readback(
        &self,
        target: &Self::Target,
        content: &ExportContent,
        should_cancel: &mut dyn FnMut() -> Result<bool, String>,
    ) -> Result<Readback, String> {
        let mut options = OpenOptions::new();
        options.write(true).truncate(true).create(true);
        let writer = self.app.fs().open(target.clone(), options).map_err(|_| {
            "The selected provider could not open the export file for writing.".to_string()
        })?;
        persist_export_content(writer, content, should_cancel, || {
            let mut read_options = OpenOptions::new();
            read_options.read(true);
            self.app.fs().open(target.clone(), read_options)
        })
    }

    fn receipt_reference(&self, target: &Self::Target) -> String {
        target.to_string()
    }
}

fn persist_export_content(
    mut writer: File,
    content: &ExportContent,
    should_cancel: &mut dyn FnMut() -> Result<bool, String>,
    open_readback: impl FnOnce() -> io::Result<File>,
) -> Result<Readback, String> {
    let mut source = content.reader()?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut expected_hash = Sha256::new();
    let mut expected_size = 0_u64;
    loop {
        if should_cancel()? {
            return Err("EXPORT_CANCELLED".to_string());
        }
        let count = source.read(&mut buffer).map_err(|_| {
            "The selected project file could not be read during export.".to_string()
        })?;
        if count == 0 {
            break;
        }
        writer.write_all(&buffer[..count]).map_err(|_| {
            "The selected provider failed while writing the export file.".to_string()
        })?;
        expected_hash.update(&buffer[..count]);
        expected_size += count as u64;
    }
    writer.flush().map_err(|_| {
        "The selected provider could not finish writing the export file.".to_string()
    })?;
    if let Err(error) = writer.sync_all() {
        if !provider_sync_is_unsupported(&error) {
            return Err("The selected provider could not finalize the export file.".to_string());
        }
    }
    drop(writer);
    if should_cancel()? {
        return Err("EXPORT_CANCELLED".to_string());
    }
    if expected_size == 0 {
        return Err("TuneForge refused to export an empty file.".to_string());
    }
    let expected_sha256 = digest_hex(expected_hash.finalize().as_slice());
    let mut reader = match open_readback() {
        Ok(reader) => reader,
        Err(error) if readback_is_unsupported(&error) => {
            return Ok(Readback::Unsupported {
                size_bytes: expected_size,
                sha256: expected_sha256,
            });
        }
        Err(_) => {
            return Err(
                "The selected provider could not reopen the export file for verification."
                    .to_string(),
            )
        }
    };
    let mut actual_hash = Sha256::new();
    let mut actual_size = 0_u64;
    loop {
        let count = reader.read(&mut buffer).map_err(|_| {
            "The selected provider failed while verifying the export file.".to_string()
        })?;
        if count == 0 {
            break;
        }
        actual_hash.update(&buffer[..count]);
        actual_size += count as u64;
    }
    let actual_sha256 = digest_hex(actual_hash.finalize().as_slice());
    if actual_size == 0 || actual_size != expected_size || actual_sha256 != expected_sha256 {
        return Err("The provider readback did not match the exported file.".to_string());
    }
    Ok(Readback::Verified {
        size_bytes: actual_size,
        sha256: actual_sha256,
    })
}

fn provider_sync_is_unsupported(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Unsupported | io::ErrorKind::InvalidInput
    )
}

fn readback_is_unsupported(error: &io::Error) -> bool {
    if matches!(
        error.kind(),
        io::ErrorKind::Unsupported | io::ErrorKind::PermissionDenied
    ) {
        return true;
    }
    let message = error.to_string().to_ascii_lowercase();
    message.contains("unsupported")
        || message.contains("not supported")
        || message.contains("permission")
        || message.contains("securityexception")
        || message.contains("read access")
}

fn digest_hex(bytes: &[u8]) -> String {
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    value
}

fn parse_request(payload: Value) -> Result<MobileExportRequest, String> {
    let request: MobileExportRequest = serde_json::from_value(payload).map_err(|_| {
        "Android export accepts only a single file selection and chord context.".to_string()
    })?;
    let item_count = request.artifact_ids.len() + request.generated_document_ids.len();
    if item_count != 1 {
        return Err(
            "Android export requires exactly one audio file or project document.".to_string(),
        );
    }
    if request.artifact_ids.len() > 1 || request.generated_document_ids.len() > 1 {
        return Err("Android export supports only one deliverable at a time.".to_string());
    }
    if request.output_format != "wav" {
        return Err(
            "Android audio export supports WAV only and does not re-encode files.".to_string(),
        );
    }
    if request
        .generated_document_ids
        .iter()
        .any(|id| id != "lyrics" && id != "lyrics_with_chords")
    {
        return Err("Android export received an unsupported project document.".to_string());
    }
    if !request.artifact_ids.is_empty()
        && (request.document_audio_set_artifact_id.is_some()
            || request.document_chord_display_mode.is_some())
    {
        return Err("Audio export must not include document chord context.".to_string());
    }
    if !request.generated_document_ids.is_empty() {
        if !request
            .document_audio_set_artifact_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
        {
            return Err("Document export requires an audio-set chord context.".to_string());
        }
        if !request
            .document_chord_display_mode
            .as_deref()
            .is_some_and(|mode| matches!(mode, "auto" | "sharps" | "flats" | "neutral" | "dual"))
        {
            return Err("Document export requires a valid enharmonic display mode.".to_string());
        }
    }
    Ok(request)
}

fn safe_filename_base(value: Option<&str>, fallback: &str) -> String {
    let raw = value.unwrap_or(fallback);
    let mut sanitized = String::with_capacity(raw.len());
    for character in raw.chars() {
        if character.is_control()
            || matches!(
                character,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
        {
            sanitized.push('-');
        } else {
            sanitized.push(character);
        }
    }
    let collapsed = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches([' ', '.']);
    let normalized = if trimmed.is_empty() {
        "TuneForge Export"
    } else {
        trimmed
    };
    normalized.chars().take(120).collect()
}

fn snapshot_export(
    connection: &Connection,
    root: &Path,
    project_id: &str,
    request: &MobileExportRequest,
) -> Result<ExportSnapshot, String> {
    let project = require_sync_editable_project(connection, project_id)?;
    let filename_base = safe_filename_base(request.filename_base.as_deref(), &project.display_name);
    if let Some(artifact_id) = request.artifact_ids.first() {
        let artifact = connection
            .query_row(
                &format!(
                    "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1 AND project_id = ?2"
                ),
                params![artifact_id, project_id],
                row_artifact,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Export audio does not belong to this project.".to_string())?;
        if !matches!(artifact.r#type.as_str(), "source_audio" | "preview_mix")
            && !artifact.r#type.ends_with("_stem")
        {
            return Err(
                "Only project tracks, practice mixes, and stems can be exported.".to_string(),
            );
        }
        if !artifact.format.eq_ignore_ascii_case("wav") {
            return Err("Android can export only a locally stored WAV file.".to_string());
        }
        let path = canonical_project_file(root, project_id, &artifact.path)?;
        if fs::metadata(&path)
            .map_err(|_| "Selected project audio is missing or unreadable.".to_string())?
            .len()
            == 0
        {
            return Err("TuneForge refused to export an empty WAV file.".to_string());
        }
        let context = if artifact.r#type == "source_audio" {
            "Source".to_string()
        } else if artifact.r#type == "preview_mix" {
            practice_mix_label(connection, project_id, &artifact.id)?
        } else {
            stem_export_context(connection, project_id, &artifact)?
        };
        return Ok(ExportSnapshot {
            source_artifact_id: Some(artifact.id),
            generated_document_id: None,
            output_name: format!("{filename_base} - {context}.wav"),
            extension: "wav",
            filter_name: "WAV Audio",
            format: "wav",
            content: ExportContent::File(path),
        });
    }

    let document_id = request.generated_document_ids[0].as_str();
    let lyrics = saved_lyrics(connection, project_id)?;
    let text = if document_id == "lyrics" {
        lyrics_text(&lyrics)
    } else {
        let chords = saved_chords(connection, project_id)?;
        let audio_set_id = request
            .document_audio_set_artifact_id
            .as_deref()
            .ok_or_else(|| {
                "Lyrics + chords export requires an audio-set chord context.".to_string()
            })?;
        let display_mode = request
            .document_chord_display_mode
            .as_deref()
            .filter(|mode| matches!(*mode, "auto" | "sharps" | "flats" | "neutral" | "dual"))
            .ok_or_else(|| {
                "Lyrics + chords export requires a valid enharmonic display mode.".to_string()
            })?;
        let context = document_chord_context(connection, project_id, audio_set_id, display_mode)?;
        lyrics_with_chords_text(&lyrics, &chords, &context)
    };
    if let Some(audio_set_id) = request.document_audio_set_artifact_id.as_deref() {
        validate_document_audio_set(connection, project_id, audio_set_id)?;
    }
    Ok(ExportSnapshot {
        source_artifact_id: None,
        generated_document_id: Some(document_id.to_string()),
        output_name: format!(
            "{filename_base} - {}.txt",
            if document_id == "lyrics" {
                "Lyrics"
            } else {
                "Lyrics and Chords"
            }
        ),
        extension: "txt",
        filter_name: "Plain Text",
        format: "txt",
        content: ExportContent::Memory(text.into_bytes()),
    })
}

fn stem_export_context(
    connection: &Connection,
    project_id: &str,
    stem: &ArtifactSchema,
) -> Result<String, String> {
    let primary_id = stem
        .metadata
        .get("source_artifact_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Selected stem is missing its audio-set context.".to_string())?;
    let primary = connection
        .query_row(
            &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1 AND project_id = ?2"),
            params![primary_id, project_id],
            row_artifact,
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Selected stem refers to an unavailable audio set.".to_string())?;
    let audio_set = match primary.r#type.as_str() {
        "source_audio" => "Source".to_string(),
        "preview_mix" => practice_mix_label(connection, project_id, &primary.id)?,
        _ => return Err("Selected stem has an invalid audio-set context.".to_string()),
    };
    let stem_label = match stem.r#type.as_str() {
        "bass_stem" => "Bass",
        "drums_stem" => "Drums",
        "guitar_stem" => "Guitar",
        "instrumental_stem" => "Instrumental",
        "other_stem" => "Other",
        "piano_stem" => "Piano",
        "vocal_stem" => "Vocals",
        _ => return Err("Selected stem type is not exportable.".to_string()),
    };
    Ok(format!("{audio_set} - {stem_label}"))
}

fn canonical_project_file(root: &Path, project_id: &str, value: &str) -> Result<PathBuf, String> {
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_project = project_root_path(root, project_id)?
        .canonicalize()
        .map_err(|_| "Project storage is unavailable.".to_string())?;
    let path = Path::new(value)
        .canonicalize()
        .map_err(|_| "Selected project audio is missing or unreadable.".to_string())?;
    if !canonical_project.starts_with(canonical_root.join("projects"))
        || !path.starts_with(&canonical_project)
    {
        return Err("Selected project audio is outside project storage.".to_string());
    }
    if !path.is_file() {
        return Err("Selected project audio is missing or unreadable.".to_string());
    }
    Ok(path)
}

fn practice_mix_label(
    connection: &Connection,
    project_id: &str,
    artifact_id: &str,
) -> Result<String, String> {
    let mut statement = connection
        .prepare("SELECT id FROM artifacts WHERE project_id = ?1 AND type = 'preview_mix' ORDER BY created_at, id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for (index, row) in rows.enumerate() {
        if row.map_err(|error| error.to_string())? == artifact_id {
            return Ok(format!("Practice Mix {}", index + 1));
        }
    }
    Ok("Practice Mix 1".to_string())
}

fn saved_lyrics(connection: &Connection, project_id: &str) -> Result<Vec<Value>, String> {
    let raw = connection
        .query_row(
            "SELECT segments_json FROM lyrics_transcripts WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Saved lyrics are required to export this document.".to_string())?;
    let segments: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
    if !segments.iter().any(|segment| {
        segment
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty())
    }) {
        return Err("Saved lyrics are required to export this document.".to_string());
    }
    Ok(segments)
}

fn saved_chords(connection: &Connection, project_id: &str) -> Result<Vec<Value>, String> {
    let raw = connection
        .query_row(
            "SELECT segments_json FROM chord_timelines WHERE project_id = ?1",
            params![project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Saved chords are required to export lyrics with chords.".to_string())?;
    let segments: Vec<Value> = serde_json::from_str(&raw).unwrap_or_default();
    if segments.is_empty() {
        return Err("Saved chords are required to export lyrics with chords.".to_string());
    }
    Ok(segments)
}

fn validate_document_audio_set(
    connection: &Connection,
    project_id: &str,
    artifact_id: &str,
) -> Result<Value, String> {
    let (artifact_type, metadata_raw): (String, String) = connection
        .query_row(
            "SELECT type, metadata_json FROM artifacts WHERE id = ?1 AND project_id = ?2",
            params![artifact_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Document audio set does not belong to this project.".to_string())?;
    if !matches!(artifact_type.as_str(), "source_audio" | "preview_mix") {
        return Err("Document chord context must be a source track or practice mix.".to_string());
    }
    Ok(serde_json::from_str(&metadata_raw).unwrap_or_else(|_| json!({})))
}

#[derive(Clone)]
struct KeyContext {
    pitch_class: i64,
    mode: String,
}

struct ChordContext {
    transpose_semitones: i64,
    active_key: Option<KeyContext>,
    display_mode: String,
}

fn document_chord_context(
    connection: &Connection,
    project_id: &str,
    audio_set_id: &str,
    display_mode: &str,
) -> Result<ChordContext, String> {
    let metadata = validate_document_audio_set(connection, project_id, audio_set_id)?;
    let (source_key_override, detected_key): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT p.source_key_override, a.estimated_key FROM projects p LEFT JOIN analysis_results a ON a.project_id = p.id WHERE p.id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let detected = detected_key.as_deref().and_then(parse_key);
    let overridden = source_key_override.as_deref().and_then(parse_key);
    let source_correction = match (&detected, &overridden) {
        (Some(source), Some(target)) => semitone_delta(source.pitch_class, target.pitch_class),
        _ => 0,
    };
    let mix_transpose = metadata
        .get("transpose")
        .and_then(Value::as_object)
        .and_then(|transpose| transpose.get("semitones"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let spelling_key = overridden.or(detected);
    let active_key = spelling_key.map(|key| KeyContext {
        pitch_class: (key.pitch_class + mix_transpose).rem_euclid(12),
        mode: key.mode,
    });
    Ok(ChordContext {
        transpose_semitones: source_correction + mix_transpose,
        active_key,
        display_mode: display_mode.to_string(),
    })
}

fn parse_key(value: &str) -> Option<KeyContext> {
    let normalized = value.trim();
    if let Some((pitch, mode)) = normalized.split_once(':') {
        let pitch_class = pitch.parse::<i64>().ok()?;
        if (0..=11).contains(&pitch_class)
            && matches!(mode.to_ascii_lowercase().as_str(), "major" | "minor")
        {
            return Some(KeyContext {
                pitch_class,
                mode: mode.to_ascii_lowercase(),
            });
        }
        return None;
    }
    let mut parts = normalized.split_whitespace();
    let note = parts.next()?;
    let mode = parts.next().unwrap_or("major").to_ascii_lowercase();
    let pitch_class = note_pitch_class(note)?;
    Some(KeyContext {
        pitch_class,
        mode: if mode == "minor" || mode == "m" {
            "minor"
        } else {
            "major"
        }
        .to_string(),
    })
}

fn note_pitch_class(note: &str) -> Option<i64> {
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

fn semitone_delta(source: i64, target: i64) -> i64 {
    let upward = (target - source).rem_euclid(12);
    if upward <= 6 {
        upward
    } else {
        upward - 12
    }
}

fn normalized_text(value: &str) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    format!("{}\n", normalized.trim_end_matches('\n'))
}

fn lyrics_text(segments: &[Value]) -> String {
    normalized_text(
        &segments
            .iter()
            .map(|segment| {
                segment
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    let number = value.and_then(Value::as_f64)?;
    number.is_finite().then_some(number)
}

fn chord_label(segment: &Value) -> String {
    segment
        .get("display_label")
        .and_then(Value::as_str)
        .filter(|label| !label.trim().is_empty())
        .or_else(|| segment.get("label").and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn pitch_class_label(pitch_class: i64, context: &ChordContext, mode: &str) -> &'static str {
    const SHARPS: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    const FLATS: [&str; 12] = [
        "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
    ];
    const NEUTRAL: [&str; 12] = [
        "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
    ];
    let index = pitch_class.rem_euclid(12) as usize;
    match mode {
        "sharps" => SHARPS[index],
        "flats" => FLATS[index],
        "auto" => {
            let family = context.active_key.as_ref().map(|key| {
                let major = [
                    "neutral", "flat", "sharp", "flat", "sharp", "flat", "sharp", "sharp", "flat",
                    "sharp", "flat", "sharp",
                ];
                let minor = [
                    "flat", "sharp", "flat", "flat", "sharp", "flat", "sharp", "flat", "sharp",
                    "neutral", "flat", "sharp",
                ];
                if key.mode == "minor" {
                    minor[key.pitch_class as usize]
                } else {
                    major[key.pitch_class as usize]
                }
            });
            match family {
                Some("sharp") => SHARPS[index],
                Some("flat") => FLATS[index],
                _ => NEUTRAL[index],
            }
        }
        _ => NEUTRAL[index],
    }
}

fn quality_suffix(quality: &str) -> Option<&'static str> {
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

fn parsed_chord(label: &str) -> Option<(i64, String, Option<i64>)> {
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
    let root_pitch = note_pitch_class(&main[..root_end])?;
    let suffix = &main[root_end..];
    let quality = match suffix {
        "" => "major",
        "m" => "minor",
        "7" | "7b5" | "maj7" | "m7" | "sus2" | "sus4" | "dim" | "aug" | "dim7" => suffix,
        "m7b5" => "hdim7",
        _ => return None,
    };
    let bass_pitch = bass.and_then(note_pitch_class);
    if bass.is_some() && bass_pitch.is_none() {
        return None;
    }
    Some((root_pitch, quality.to_string(), bass_pitch))
}

fn format_transposed_chord(
    root: i64,
    quality: &str,
    bass: Option<i64>,
    context: &ChordContext,
) -> Option<String> {
    let suffix = quality_suffix(quality)?;
    let root = (root + context.transpose_semitones).rem_euclid(12);
    let bass = bass.map(|bass| (bass + context.transpose_semitones).rem_euclid(12));
    if context.display_mode == "dual" {
        let sharp_context = ChordContext {
            display_mode: "sharps".to_string(),
            ..context.clone_for_display()
        };
        let flat_context = ChordContext {
            display_mode: "flats".to_string(),
            ..context.clone_for_display()
        };
        let primary = formatted_chord_labels(root, suffix, bass, &sharp_context);
        let secondary = formatted_chord_labels(root, suffix, bass, &flat_context);
        return Some(if primary == secondary {
            primary
        } else {
            format!("{primary} / {secondary}")
        });
    }
    Some(formatted_chord_labels(root, suffix, bass, context))
}

impl ChordContext {
    fn clone_for_display(&self) -> Self {
        Self {
            transpose_semitones: self.transpose_semitones,
            active_key: self.active_key.clone(),
            display_mode: self.display_mode.clone(),
        }
    }
}

fn formatted_chord_labels(
    root: i64,
    suffix: &str,
    bass: Option<i64>,
    context: &ChordContext,
) -> String {
    let root_label = pitch_class_label(root, context, &context.display_mode);
    let bass_label = bass
        .filter(|bass| *bass != root)
        .map(|bass| {
            format!(
                "/{}",
                pitch_class_label(bass, context, &context.display_mode)
            )
        })
        .unwrap_or_default();
    format!("{root_label}{suffix}{bass_label}")
}

fn display_chord_label(segment: &Value, context: &ChordContext) -> String {
    let structured = segment
        .get("pitch_class")
        .and_then(Value::as_i64)
        .zip(segment.get("quality").and_then(Value::as_str))
        .map(|(root, quality)| {
            (
                root,
                quality.to_string(),
                segment.get("bass_pitch_class").and_then(Value::as_i64),
            )
        });
    let parsed = structured.or_else(|| parsed_chord(&chord_label(segment)));
    parsed
        .and_then(|(root, quality, bass)| format_transposed_chord(root, &quality, bass, context))
        .unwrap_or_else(|| chord_label(segment))
}

fn word_positions(text: &str, words: &[Value]) -> Vec<Option<usize>> {
    let folded = text.to_lowercase().chars().collect::<Vec<_>>();
    let mut cursor = 0;
    words
        .iter()
        .map(|word| {
            let token = word
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            if token.is_empty() {
                return None;
            }
            let token = token.chars().collect::<Vec<_>>();
            let position = folded[cursor..]
                .windows(token.len())
                .position(|candidate| candidate == token)
                .map(|position| cursor + position)?;
            cursor = position + token.len();
            Some(position)
        })
        .collect()
}

fn chord_anchor(chord: &Value, lyric: &Value, text: &str) -> usize {
    let chord_start = finite_number(chord.get("start_seconds"));
    if let (Some(chord_start), Some(words)) =
        (chord_start, lyric.get("words").and_then(Value::as_array))
    {
        let positions = word_positions(text, words);
        let timed = words
            .iter()
            .enumerate()
            .filter_map(|(index, word)| {
                let start = finite_number(word.get("start_seconds"))?;
                let end = finite_number(word.get("end_seconds"))?;
                (end >= start).then_some((index, start, end))
            })
            .collect::<Vec<_>>();
        if timed
            .iter()
            .any(|(index, _, _)| positions.get(*index).copied().flatten().is_some())
        {
            let chosen = timed
                .iter()
                .find(|(_, start, end)| {
                    chord_start < *start || (*start <= chord_start && chord_start < *end)
                })
                .map(|(index, _, _)| *index)
                .or_else(|| timed.last().map(|(index, _, _)| *index));
            if let Some(position) = chosen.and_then(|index| positions.get(index).copied().flatten())
            {
                return position;
            }
        }
    }
    let lyric_start = finite_number(lyric.get("start_seconds"));
    let lyric_end = finite_number(lyric.get("end_seconds"));
    if let (Some(chord_start), Some(start), Some(end)) = (chord_start, lyric_start, lyric_end) {
        if end > start {
            let ratio = ((chord_start - start) / (end - start)).clamp(0.0, 1.0);
            let text_length = text.chars().count();
            return ((ratio * text_length as f64) as usize).min(text_length.saturating_sub(1));
        }
    }
    0
}

fn anchored_chord_line(
    chords: &[&Value],
    lyric: &Value,
    text: &str,
    context: &ChordContext,
) -> String {
    let mut line = String::new();
    let mut next_column = 0;
    for chord in chords {
        let label = display_chord_label(chord, context);
        if label.is_empty() {
            continue;
        }
        let column = chord_anchor(chord, lyric, text).max(next_column);
        let line_width = line.chars().count();
        if line_width < column {
            line.push_str(&" ".repeat(column - line_width));
        }
        line.push_str(&label);
        next_column = line.chars().count() + 1;
    }
    line
}

fn lyrics_with_chords_text(lyrics: &[Value], chords: &[Value], context: &ChordContext) -> String {
    let mut ordered = chords.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        match (
            finite_number(left.get("start_seconds")),
            finite_number(right.get("start_seconds")),
        ) {
            (Some(left), Some(right)) => left.partial_cmp(&right).unwrap_or(Ordering::Equal),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        }
    });
    let mut lyric_chords = vec![Vec::<&Value>::new(); lyrics.len()];
    let mut gap_chords = vec![Vec::<&Value>::new(); lyrics.len() + 1];
    for chord in ordered {
        let start = finite_number(chord.get("start_seconds"));
        let lyric_index = lyrics.iter().position(|lyric| {
            match (
                start,
                finite_number(lyric.get("start_seconds")),
                finite_number(lyric.get("end_seconds")),
            ) {
                (Some(chord_start), Some(lyric_start), Some(lyric_end)) => {
                    lyric_start <= chord_start && chord_start < lyric_end
                }
                _ => false,
            }
        });
        if let Some(index) = lyric_index {
            lyric_chords[index].push(chord);
        } else {
            let insertion = lyrics
                .iter()
                .position(
                    |lyric| match (start, finite_number(lyric.get("start_seconds"))) {
                        (Some(chord_start), Some(lyric_start)) => chord_start < lyric_start,
                        _ => false,
                    },
                )
                .unwrap_or(lyrics.len());
            gap_chords[insertion].push(chord);
        }
    }
    let mut blocks = Vec::new();
    for index in 0..=lyrics.len() {
        let gap = gap_chords[index]
            .iter()
            .map(|chord| display_chord_label(chord, context))
            .filter(|label| !label.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !gap.is_empty() {
            blocks.push(gap);
        }
        if let Some(lyric) = lyrics.get(index) {
            let text = lyric
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .replace("\r\n", "\n")
                .replace('\r', "\n");
            let chord_line = anchored_chord_line(&lyric_chords[index], lyric, &text, context);
            blocks.push(if chord_line.is_empty() {
                text
            } else {
                format!("{chord_line}\n{text}")
            });
        }
    }
    normalized_text(&blocks.join("\n\n"))
}

fn export_item(
    snapshot: &ExportSnapshot,
    status: &str,
    progress: i64,
    result_id: Option<&str>,
    error: Option<&str>,
) -> Value {
    json!({
        "artifact_id": snapshot.source_artifact_id,
        "generated_document_id": snapshot.generated_document_id,
        "output_name": snapshot.output_name,
        "status": status,
        "progress": progress,
        "result_artifact_id": result_id,
        "error": error,
    })
}

fn export_result(
    snapshot: &ExportSnapshot,
    outcome: &str,
    item_status: &str,
    progress: i64,
    result_id: Option<&str>,
    error: Option<&str>,
) -> Value {
    json!({
        "outcome": outcome,
        "total_count": 1,
        "completed_count": if item_status == "completed" { 1 } else { 0 },
        "failed_count": if item_status == "failed" { 1 } else { 0 },
        "items": [export_item(snapshot, item_status, progress, result_id, error)],
    })
}

fn update_export_job(
    connection: &Connection,
    job_id: &str,
    status: &str,
    progress: i64,
    stage: &str,
    stage_label: &str,
    runtime_detail: Option<&str>,
    result: Value,
    error_message: Option<&str>,
    completed: bool,
) -> Result<(), String> {
    let timestamp = now_iso();
    let payload = json!({
        "stage": stage,
        "stage_label": stage_label,
        "runtime_detail": runtime_detail,
        "export_result": result,
    });
    connection
        .execute(
            "UPDATE jobs SET status = ?1, progress = ?2, payload_json = ?3, error_message = ?4, completed_at = CASE WHEN ?5 THEN ?6 ELSE completed_at END, updated_at = ?6 WHERE id = ?7 AND status IN ('pending', 'running') AND cancel_requested = 0",
            params![status, progress, payload.to_string(), error_message, completed, timestamp, job_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn export_cancel_requested(connection: &Connection, job_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT cancel_requested != 0 OR status = 'cancelled' FROM jobs WHERE id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn cancel_export_job(
    connection: &Connection,
    job_id: &str,
    snapshot: &ExportSnapshot,
) -> Result<JobSchema, String> {
    let timestamp = now_iso();
    let payload = json!({
        "stage": "finalizing",
        "stage_label": "Export cancelled",
        "runtime_detail": "The picker was closed or export cancellation was requested. No verified receipt was saved.",
        "export_result": export_result(snapshot, "cancelled", "cancelled", 0, None, None),
    });
    connection
        .execute(
            "UPDATE jobs SET status = 'cancelled', progress = 0, payload_json = ?1, error_message = NULL, completed_at = ?2, updated_at = ?2 WHERE id = ?3 AND (status IN ('pending', 'running') OR (status = 'cancelled' AND cancel_requested != 0))",
            params![payload.to_string(), timestamp, job_id],
        )
        .map_err(|error| error.to_string())?;
    get_export_job(connection, job_id)
}

fn finish_export_job_if_active(
    connection: &Connection,
    job_id: &str,
    status: &str,
    progress: i64,
    stage_label: &str,
    runtime_detail: &str,
    result: Value,
    error_message: Option<&str>,
    duration_seconds: Option<f64>,
) -> Result<bool, String> {
    let timestamp = now_iso();
    let payload = json!({
        "stage": "finalizing",
        "stage_label": stage_label,
        "runtime_detail": runtime_detail,
        "export_result": result,
    });
    connection
        .execute(
            "UPDATE jobs SET status = ?1, progress = ?2, payload_json = ?3, error_message = ?4, completed_at = ?5, duration_seconds = COALESCE(?6, duration_seconds), updated_at = ?5 WHERE id = ?7 AND status IN ('pending', 'running') AND cancel_requested = 0",
            params![status, progress, payload.to_string(), error_message, timestamp, duration_seconds, job_id],
        )
        .map(|updated| updated == 1)
        .map_err(|error| error.to_string())
}

fn fail_export_job(
    connection: &Connection,
    job_id: &str,
    snapshot: &ExportSnapshot,
    message: &str,
) -> Result<JobSchema, String> {
    let updated = finish_export_job_if_active(
        connection,
        job_id,
        "failed",
        0,
        "Export failed",
        "The provider may retain a partial file. TuneForge did not save an export receipt.",
        export_result(snapshot, "failed", "failed", 0, None, Some(message)),
        Some(message),
        None,
    )?;
    if updated {
        get_export_job(connection, job_id)
    } else {
        cancel_export_job(connection, job_id, snapshot)
    }
}

fn get_export_job(connection: &Connection, job_id: &str) -> Result<JobSchema, String> {
    connection
        .query_row(
            &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE id = ?1"),
            params![job_id],
            row_job,
        )
        .map_err(|error| error.to_string())
}

fn complete_verified_export<T>(
    connection: &Connection,
    job_id: &str,
    project_id: &str,
    snapshot: &ExportSnapshot,
    target: &T,
    provider: &impl ExportProvider<Target = T>,
    size_bytes: u64,
    sha256: &str,
    started: Instant,
) -> Result<JobSchema, String> {
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let result = (|| -> Result<JobSchema, String> {
        if export_cancel_requested(connection, job_id)? {
            return Err("EXPORT_CANCELLED".to_string());
        }
        let receipt_id = new_artifact_id()?;
        let timestamp = now_iso();
        connection
            .execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, cache_key, created_at)
                 VALUES (?1, ?2, 'export_mix', ?3, ?4, ?5, ?6, 'mobile-provider-export', 0, 0, ?7, NULL, ?8)",
                params![
                    receipt_id,
                    project_id,
                    snapshot.format,
                    provider.receipt_reference(target),
                    sha256,
                    size_bytes as i64,
                    json!({
                        "job_id": job_id,
                        "output_name": snapshot.output_name,
                        "provider_owned": true,
                        "verified": true,
                    }).to_string(),
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        let payload = json!({
            "stage": "finalizing",
            "stage_label": "Export complete",
            "runtime_detail": "Provider readback matched the exported size and SHA-256.",
            "export_result": export_result(snapshot, "completed", "completed", 100, Some(&receipt_id), None),
        });
        let updated = connection
            .execute(
                "UPDATE jobs SET status = 'completed', progress = 100, result_artifact_ids_json = ?1, payload_json = ?2, error_message = NULL, completed_at = ?3, duration_seconds = ?4, updated_at = ?3 WHERE id = ?5 AND status IN ('pending', 'running') AND cancel_requested = 0",
                params![json!([receipt_id]).to_string(), payload.to_string(), timestamp, started.elapsed().as_secs_f64(), job_id],
            )
            .map_err(|error| error.to_string())?;
        if updated != 1 {
            return Err("EXPORT_CANCELLED".to_string());
        }
        get_export_job(connection, job_id)
    })();
    match result {
        Ok(job) => {
            if let Err(commit_error) = connection.execute_batch("COMMIT") {
                connection
                    .execute_batch("ROLLBACK")
                    .map_err(|rollback_error| rollback_error.to_string())?;
                Err(commit_error.to_string())
            } else {
                Ok(job)
            }
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn complete_unverified_export(
    connection: &Connection,
    job_id: &str,
    snapshot: &ExportSnapshot,
    started: Instant,
) -> Result<JobSchema, String> {
    let updated = finish_export_job_if_active(
        connection,
        job_id,
        "completed",
        100,
        "Export complete",
        "The provider does not support readback. The file was written, but TuneForge could not verify it and saved no receipt.",
        export_result(snapshot, "completed", "completed", 100, None, None),
        None,
        Some(started.elapsed().as_secs_f64()),
    )?;
    if updated {
        get_export_job(connection, job_id)
    } else {
        cancel_export_job(connection, job_id, snapshot)
    }
}

fn prepare_export(
    connection: &Connection,
    root: &Path,
    project_id: &str,
    payload: Value,
) -> Result<(ExportSnapshot, JobSchema), String> {
    let request = parse_request(payload)?;
    let snapshot = snapshot_export(connection, root, project_id, &request)?;
    let job = create_running_job(
        connection,
        project_id,
        "export",
        snapshot.source_artifact_id.clone(),
    )?;
    update_export_job(
        connection,
        &job.id,
        "running",
        5,
        "preparing",
        "Opening Android picker",
        Some("Choose a provider, file name, and location."),
        export_result(&snapshot, "failed", "running", 5, None, None),
        None,
        false,
    )?;
    let job = get_export_job(connection, &job.id)?;
    Ok((snapshot, job))
}

fn run_prepared_export(
    connection: &Connection,
    project_id: &str,
    snapshot: &ExportSnapshot,
    job_id: &str,
    provider: &impl ExportProvider,
) -> Result<JobSchema, String> {
    let started = Instant::now();
    let target = match provider.create_document(
        &snapshot.output_name,
        snapshot.filter_name,
        snapshot.extension,
    ) {
        Ok(Some(target)) => target,
        Ok(None) => return cancel_export_job(connection, job_id, snapshot),
        Err(message) => return fail_export_job(connection, job_id, snapshot, &message),
    };
    if export_cancel_requested(connection, job_id)? {
        return cancel_export_job(connection, job_id, snapshot);
    }
    update_export_job(
        connection,
        job_id,
        "running",
        35,
        "writing",
        "Writing export",
        Some("TuneForge is streaming the selected file to the provider."),
        export_result(snapshot, "failed", "running", 35, None, None),
        None,
        false,
    )?;
    let write_result = provider.write_and_readback(&target, &snapshot.content, &mut || {
        export_cancel_requested(connection, job_id)
    });
    match write_result {
        Err(message) if message == "EXPORT_CANCELLED" => {
            cancel_export_job(connection, job_id, snapshot)
        }
        Err(message) => fail_export_job(connection, job_id, snapshot, &message),
        Ok(Readback::Unsupported {
            size_bytes: _,
            sha256: _,
        }) => {
            update_export_job(
                connection,
                job_id,
                "running",
                90,
                "finalizing",
                "Finalizing export",
                Some("TuneForge is checking provider readback support."),
                export_result(snapshot, "failed", "running", 90, None, None),
                None,
                false,
            )?;
            complete_unverified_export(connection, job_id, snapshot, started)
        }
        Ok(Readback::Verified { size_bytes, sha256 }) => {
            update_export_job(
                connection,
                job_id,
                "running",
                90,
                "finalizing",
                "Finalizing export",
                Some("TuneForge is verifying provider size and SHA-256."),
                export_result(snapshot, "failed", "running", 90, None, None),
                None,
                false,
            )?;
            match complete_verified_export(
                connection, job_id, project_id, snapshot, &target, provider, size_bytes, &sha256,
                started,
            ) {
                Err(message) if message == "EXPORT_CANCELLED" => {
                    cancel_export_job(connection, job_id, snapshot)
                }
                result => result,
            }
        }
    }
}

fn run_export_worker(
    connection: &Connection,
    project_id: &str,
    snapshot: &ExportSnapshot,
    job_id: &str,
    provider: &impl ExportProvider,
) -> Result<JobSchema, String> {
    match run_prepared_export(connection, project_id, snapshot, job_id, provider) {
        Ok(job) => Ok(job),
        Err(_) => fail_export_job(connection, job_id, snapshot, EXPORT_WORKER_FAILED_MESSAGE),
    }
}

fn submit_export_with_provider(
    connection: &Connection,
    root: &Path,
    project_id: &str,
    payload: Value,
    provider: &impl ExportProvider,
) -> Result<JobSchema, String> {
    let (snapshot, job) = prepare_export(connection, root, project_id, payload)?;
    run_export_worker(connection, project_id, &snapshot, &job.id, provider)
}

#[cfg(target_os = "android")]
pub fn mobile_submit_export(
    app: AppHandle,
    project_id: String,
    payload: Value,
) -> Result<JobResponse, String> {
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let (snapshot, job) = prepare_export(&connection, &root, &project_id, payload)?;
    let job_id = job.id.clone();
    thread::spawn(move || {
        let provider = AndroidExportProvider { app: &app };
        let _ = run_export_worker(&connection, &project_id, &snapshot, &job_id, &provider);
    });
    Ok(JobResponse { job })
}

pub(super) fn fail_interrupted_exports(connection: &Connection) -> Result<(), String> {
    let timestamp = now_iso();
    let interrupted = {
        let mut statement = connection
            .prepare("SELECT id, payload_json FROM jobs WHERE type = 'export' AND status IN ('pending', 'running')")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut interrupted = Vec::new();
        for row in rows {
            interrupted.push(row.map_err(|error| error.to_string())?);
        }
        interrupted
    };
    for (job_id, payload_raw) in interrupted {
        let mut payload = serde_json::from_str::<Value>(&payload_raw).unwrap_or_else(|_| json!({}));
        payload["stage"] = json!("finalizing");
        payload["stage_label"] = json!("Export interrupted");
        payload["runtime_detail"] = json!(EXPORT_INTERRUPTED_MESSAGE);
        if let Some(result) = payload.get_mut("export_result") {
            result["outcome"] = json!("failed");
            result["completed_count"] = json!(0);
            result["failed_count"] = json!(1);
            if let Some(items) = result.get_mut("items").and_then(Value::as_array_mut) {
                for item in items {
                    item["status"] = json!("failed");
                    item["progress"] = json!(0);
                    item["error"] = json!(EXPORT_INTERRUPTED_MESSAGE);
                    item["result_artifact_id"] = Value::Null;
                }
            }
        }
        connection
            .execute(
                "UPDATE jobs SET status = 'failed', progress = 0, error_message = ?1, payload_json = ?2, completed_at = ?3, updated_at = ?3 WHERE id = ?4",
                params![EXPORT_INTERRUPTED_MESSAGE, payload.to_string(), timestamp, job_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, fs};

    struct TestProvider {
        target: Option<PathBuf>,
        readback: &'static str,
        selected_names: RefCell<Vec<String>>,
    }

    impl ExportProvider for TestProvider {
        type Target = PathBuf;

        fn create_document(
            &self,
            output_name: &str,
            _: &str,
            _: &str,
        ) -> Result<Option<Self::Target>, String> {
            self.selected_names
                .borrow_mut()
                .push(output_name.to_string());
            Ok(self.target.clone())
        }

        fn write_and_readback(
            &self,
            target: &Self::Target,
            content: &ExportContent,
            should_cancel: &mut dyn FnMut() -> Result<bool, String>,
        ) -> Result<Readback, String> {
            let writer = File::create(target).map_err(|error| error.to_string())?;
            match self.readback {
                "cancel" => Err("EXPORT_CANCELLED".to_string()),
                "unsupported" => {
                    let mut source = content.reader()?;
                    let mut bytes = Vec::new();
                    source
                        .read_to_end(&mut bytes)
                        .map_err(|error| error.to_string())?;
                    fs::write(target, &bytes).map_err(|error| error.to_string())?;
                    Ok(Readback::Unsupported {
                        size_bytes: bytes.len() as u64,
                        sha256: digest_hex(Sha256::digest(&bytes).as_slice()),
                    })
                }
                "mismatch" => persist_export_content(writer, content, should_cancel, || {
                    fs::write(target, b"wrong")?;
                    File::open(target)
                }),
                _ => persist_export_content(writer, content, should_cancel, || File::open(target)),
            }
        }

        fn receipt_reference(&self, target: &Self::Target) -> String {
            format!(
                "content://test/{}",
                target.file_name().unwrap().to_string_lossy()
            )
        }
    }

    fn context(transpose: i64, display_mode: &str) -> ChordContext {
        ChordContext {
            transpose_semitones: transpose,
            active_key: Some(KeyContext {
                pitch_class: 1,
                mode: "major".to_string(),
            }),
            display_mode: display_mode.to_string(),
        }
    }

    struct ExportFixture {
        root: PathBuf,
        connection: Connection,
        project_id: String,
        artifact_id: String,
        source_bytes: Vec<u8>,
    }

    impl ExportFixture {
        fn new(name: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("tuneforge-export-{name}-{}", new_id("test")));
            fs::create_dir_all(&root).unwrap();
            let connection = db_at_root(&root).unwrap();
            let project_id = format!("proj_sha256_{}", "a".repeat(64));
            let artifact_id = "art_source_export_fixture".to_string();
            let project_root = root.join("projects").join(&project_id);
            fs::create_dir_all(project_root.join("source")).unwrap();
            let source_path = project_root.join("source").join("source.wav");
            let source_bytes = b"RIFF\0synthetic-provider-export".to_vec();
            fs::write(&source_path, &source_bytes).unwrap();
            let timestamp = now_iso();
            connection.execute(
                "INSERT INTO projects (id, display_name, source_sha256, source_path, imported_path, sync_status, created_at, updated_at) VALUES (?1, 'Synthetic Song', ?2, ?3, ?3, 'local', ?4, ?4)",
                params![project_id, "a".repeat(64), source_path.to_string_lossy(), timestamp],
            ).unwrap();
            connection.execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at) VALUES (?1, ?2, 'source_audio', 'wav', ?3, ?4, ?5, 'import', 0, 0, '{}', ?6)",
                params![artifact_id, project_id, source_path.to_string_lossy(), digest_hex(Sha256::digest(&source_bytes).as_slice()), source_bytes.len() as i64, timestamp],
            ).unwrap();
            Self {
                root,
                connection,
                project_id,
                artifact_id,
                source_bytes,
            }
        }

        fn payload(&self) -> Value {
            json!({
                "artifact_ids": [self.artifact_id],
                "output_format": "wav",
                "filename_base": "Synthetic Song"
            })
        }

        fn receipt_count(&self) -> i64 {
            self.connection
                .query_row(
                    "SELECT COUNT(*) FROM artifacts WHERE type = 'export_mix'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        }
    }

    impl Drop for ExportFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn request_rejects_destinations_multiple_items_and_non_wav_audio() {
        assert!(parse_request(json!({
            "artifact_ids": ["art"],
            "output_format": "wav",
            "destination": {"type": "single_file", "target": "content://caller"}
        }))
        .is_err());
        assert!(parse_request(json!({
            "artifact_ids": ["art"],
            "output_format": "wav",
            "document_audio_set_artifact_id": "wrong-context",
            "document_chord_display_mode": "auto"
        }))
        .is_err());
        assert!(parse_request(json!({
            "generated_document_ids": ["lyrics"],
            "output_format": "wav"
        }))
        .is_err());
        assert!(parse_request(json!({
            "artifact_ids": ["one", "two"],
            "output_format": "wav"
        }))
        .is_err());
        assert!(parse_request(json!({
            "artifact_ids": ["art"],
            "output_format": "m4a"
        }))
        .is_err());
    }

    #[test]
    fn renderer_preserves_timing_instrumental_lines_and_spelling_modes() {
        let lyrics = vec![json!({
            "start_seconds": 1.0,
            "end_seconds": 3.0,
            "text": "Hello world",
            "words": [
                {"text": "Hello", "start_seconds": 1.0, "end_seconds": 2.0},
                {"text": "world", "start_seconds": 2.0, "end_seconds": 3.0}
            ]
        })];
        let chords = vec![
            json!({"start_seconds": 0.0, "label": "C/G"}),
            json!({"start_seconds": 1.2, "label": "C/G"}),
            json!({"start_seconds": 2.2, "label": "B/F", "pitch_class": 11, "quality": "major", "bass_pitch_class": 5}),
            json!({"start_seconds": 4.0, "label": "N.C."}),
            json!({"start_seconds": 5.0, "label": "mystery"}),
        ];
        assert_eq!(
            lyrics_with_chords_text(&lyrics, &chords, &context(1, "flats")),
            "Db/Ab\n\nDb/Ab C/Gb\nHello world\n\nN.C. mystery\n"
        );
        assert_eq!(
            lyrics_text(&[json!({"text": "Line\r\nTwo\n"})]),
            "Line\nTwo\n"
        );
        assert_eq!(
            lyrics_with_chords_text(
                &[json!({
                    "start_seconds": 1.0,
                    "end_seconds": 3.0,
                    "text": "Olá café",
                    "words": [
                        {"text": "Olá", "start_seconds": 1.0, "end_seconds": 2.0},
                        {"text": "café", "start_seconds": 2.0, "end_seconds": 3.0}
                    ]
                })],
                &[
                    json!({"start_seconds": 1.2, "label": "C"}),
                    json!({"start_seconds": 2.2, "label": "G"})
                ],
                &context(0, "sharps"),
            ),
            "C   G\nOlá café\n"
        );
    }

    #[test]
    fn source_shifted_and_retune_only_contexts_are_distinct() {
        assert_eq!(
            display_chord_label(&json!({"label": "C"}), &context(0, "sharps")),
            "C"
        );
        assert_eq!(
            display_chord_label(&json!({"label": "C"}), &context(2, "sharps")),
            "D"
        );
        assert_eq!(
            display_chord_label(&json!({"label": "N.C."}), &context(7, "sharps")),
            "N.C."
        );
        assert_eq!(
            display_chord_label(&json!({"label": "mystery"}), &context(7, "sharps")),
            "mystery"
        );
    }

    #[test]
    fn byte_stream_is_exact_and_detects_mismatch_or_unsupported_readback() {
        let root = std::env::temp_dir().join(format!("tuneforge-export-bytes-{}", new_id("test")));
        fs::create_dir_all(&root).unwrap();
        let bytes = b"RIFF\0synthetic-wave".to_vec();
        let content = ExportContent::Memory(bytes.clone());
        let target = root.join("exact.wav");
        let verified = persist_export_content(
            File::create(&target).unwrap(),
            &content,
            &mut || Ok(false),
            || File::open(&target),
        )
        .unwrap();
        assert_eq!(
            verified,
            Readback::Verified {
                size_bytes: bytes.len() as u64,
                sha256: digest_hex(Sha256::digest(&bytes).as_slice()),
            }
        );
        assert_eq!(fs::read(&target).unwrap(), bytes);
        let mismatch = root.join("mismatch.wav");
        assert!(persist_export_content(
            File::create(&mismatch).unwrap(),
            &content,
            &mut || Ok(false),
            || {
                fs::write(&mismatch, b"wrong")?;
                File::open(&mismatch)
            }
        )
        .is_err());
        assert!(readback_is_unsupported(&io::Error::new(
            io::ErrorKind::PermissionDenied,
            "provider read access denied"
        )));
        assert!(provider_sync_is_unsupported(&io::Error::new(
            io::ErrorKind::Unsupported,
            "provider descriptor has no fsync"
        )));
        assert!(provider_sync_is_unsupported(&io::Error::new(
            io::ErrorKind::InvalidInput,
            "provider descriptor rejected fsync"
        )));
        assert!(!provider_sync_is_unsupported(&io::Error::new(
            io::ErrorKind::Other,
            "real finalization failure"
        )));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prepare_exposes_running_job_before_provider_and_stem_names_match_preview() {
        let fixture = ExportFixture::new("lifecycle-stem-name");
        let project_root = fixture.root.join("projects").join(&fixture.project_id);
        let mix_path = project_root.join("mix.wav");
        let stem_path = project_root.join("vocals.wav");
        fs::write(&mix_path, &fixture.source_bytes).unwrap();
        fs::write(&stem_path, &fixture.source_bytes).unwrap();
        let timestamp = now_iso();
        fixture.connection.execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at) VALUES ('art_mix_export_fixture', ?1, 'preview_mix', 'wav', ?2, ?3, ?4, 'preview', 1, 1, '{}', ?5)",
            params![fixture.project_id, mix_path.to_string_lossy(), digest_hex(Sha256::digest(&fixture.source_bytes).as_slice()), fixture.source_bytes.len() as i64, timestamp],
        ).unwrap();
        fixture.connection.execute(
            "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at) VALUES ('art_vocals_export_fixture', ?1, 'vocal_stem', 'wav', ?2, ?3, ?4, 'stems', 1, 1, ?5, ?6)",
            params![fixture.project_id, stem_path.to_string_lossy(), digest_hex(Sha256::digest(&fixture.source_bytes).as_slice()), fixture.source_bytes.len() as i64, json!({"source_artifact_id": "art_mix_export_fixture"}).to_string(), timestamp],
        ).unwrap();
        let (snapshot, job) = prepare_export(
            &fixture.connection,
            &fixture.root,
            &fixture.project_id,
            json!({
                "artifact_ids": ["art_vocals_export_fixture"],
                "output_format": "wav",
                "filename_base": "Synthetic Song"
            }),
        )
        .unwrap();
        assert_eq!(
            snapshot.output_name,
            "Synthetic Song - Practice Mix 1 - Vocals.wav"
        );
        assert_eq!(job.status, "running");
        assert_eq!(job.stage.as_deref(), Some("preparing"));
        assert_eq!(job.stage_label.as_deref(), Some("Opening Android picker"));

        let target = fixture.root.join("stem-provider.wav");
        let provider = TestProvider {
            target: Some(target),
            readback: "verified",
            selected_names: RefCell::new(Vec::new()),
        };
        let completed = run_prepared_export(
            &fixture.connection,
            &fixture.project_id,
            &snapshot,
            &job.id,
            &provider,
        )
        .unwrap();
        assert_eq!(completed.status, "completed");
        assert_eq!(
            provider.selected_names.borrow().as_slice(),
            ["Synthetic Song - Practice Mix 1 - Vocals.wav"]
        );
    }

    #[test]
    fn worker_uses_sendable_connection_and_terminalizes_unexpected_runner_error() {
        fn assert_send<T: Send>() {}
        assert_send::<Connection>();

        let fixture = ExportFixture::new("worker-runner-error");
        let (snapshot, job) = prepare_export(
            &fixture.connection,
            &fixture.root,
            &fixture.project_id,
            fixture.payload(),
        )
        .unwrap();
        fixture
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_export_writing_progress
             BEFORE UPDATE OF progress ON jobs
             WHEN NEW.type = 'export' AND NEW.progress = 35
             BEGIN
               SELECT RAISE(ABORT, 'synthetic runner failure');
             END;",
            )
            .unwrap();
        let provider = TestProvider {
            target: Some(fixture.root.join("unexpected-error.wav")),
            readback: "verified",
            selected_names: RefCell::new(Vec::new()),
        };

        let failed = run_export_worker(
            &fixture.connection,
            &fixture.project_id,
            &snapshot,
            &job.id,
            &provider,
        )
        .unwrap();

        assert_eq!(failed.status, "failed");
        assert_eq!(
            failed.error_message.as_deref(),
            Some(EXPORT_WORKER_FAILED_MESSAGE)
        );
        assert_eq!(fixture.receipt_count(), 0);
    }

    #[test]
    fn concurrent_cancel_wins_over_failure_and_unverified_completion() {
        for terminal in ["failed", "completed"] {
            let fixture = ExportFixture::new(&format!("cancel-race-{terminal}"));
            let (snapshot, job) = prepare_export(
                &fixture.connection,
                &fixture.root,
                &fixture.project_id,
                fixture.payload(),
            )
            .unwrap();
            fixture
                .connection
                .execute(
                    "UPDATE jobs SET status = 'cancelled', cancel_requested = 1 WHERE id = ?1",
                    params![job.id],
                )
                .unwrap();
            let result = if terminal == "failed" {
                fail_export_job(&fixture.connection, &job.id, &snapshot, "provider failed")
            } else {
                complete_unverified_export(&fixture.connection, &job.id, &snapshot, Instant::now())
            }
            .unwrap();
            assert_eq!(result.status, "cancelled");
            assert_eq!(
                result
                    .export_result
                    .as_ref()
                    .and_then(|value| value.get("outcome"))
                    .and_then(Value::as_str),
                Some("cancelled")
            );
            assert_eq!(fixture.receipt_count(), 0);
        }
    }

    #[test]
    fn verified_provider_export_is_atomic_and_keeps_provider_output_external() {
        let fixture = ExportFixture::new("verified");
        let target = fixture.root.join("provider-owned.wav");
        let provider = TestProvider {
            target: Some(target.clone()),
            readback: "verified",
            selected_names: RefCell::new(Vec::new()),
        };
        let job = submit_export_with_provider(
            &fixture.connection,
            &fixture.root,
            &fixture.project_id,
            fixture.payload(),
            &provider,
        )
        .unwrap();

        assert_eq!(job.status, "completed");
        assert_eq!(job.stage.as_deref(), Some("finalizing"));
        assert_eq!(
            job.export_result
                .as_ref()
                .and_then(|result| result.get("outcome"))
                .and_then(Value::as_str),
            Some("completed")
        );
        assert_eq!(fs::read(&target).unwrap(), fixture.source_bytes);
        assert_eq!(fixture.receipt_count(), 1);
        let (path, can_delete): (String, i64) = fixture
            .connection
            .query_row(
                "SELECT path, can_delete FROM artifacts WHERE type = 'export_mix'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(path.starts_with("content://test/"));
        assert_eq!(can_delete, 0);
        reconcile_project_storage_after_commit(
            &fixture.connection,
            &fixture.root,
            &fixture.project_id,
        );
        assert_eq!(fs::read(target).unwrap(), fixture.source_bytes);
    }

    #[test]
    fn verified_commit_failure_rolls_back_before_worker_terminalizes_job() {
        let fixture = ExportFixture::new("verified-commit-failure");
        fixture
            .connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE export_commit_parent (id INTEGER PRIMARY KEY);
                 CREATE TABLE export_commit_child (
                   parent_id INTEGER,
                   FOREIGN KEY (parent_id) REFERENCES export_commit_parent(id)
                     DEFERRABLE INITIALLY DEFERRED
                 );
                 CREATE TRIGGER reject_verified_export_commit
                 AFTER INSERT ON artifacts
                 WHEN NEW.type = 'export_mix'
                 BEGIN
                   INSERT INTO export_commit_child (parent_id) VALUES (1);
                 END;",
            )
            .unwrap();
        let provider = TestProvider {
            target: Some(fixture.root.join("commit-failure.wav")),
            readback: "verified",
            selected_names: RefCell::new(Vec::new()),
        };

        let failed = submit_export_with_provider(
            &fixture.connection,
            &fixture.root,
            &fixture.project_id,
            fixture.payload(),
            &provider,
        )
        .unwrap();

        assert_eq!(failed.status, "failed");
        assert_eq!(
            failed.error_message.as_deref(),
            Some(EXPORT_WORKER_FAILED_MESSAGE)
        );
        assert_eq!(fixture.receipt_count(), 0);
        let deferred_rows: i64 = fixture
            .connection
            .query_row("SELECT COUNT(*) FROM export_commit_child", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(deferred_rows, 0);
    }

    #[test]
    fn unverified_failed_cancelled_and_restarted_exports_never_create_receipts() {
        for (mode, expected_status) in [
            ("unsupported", "completed"),
            ("mismatch", "failed"),
            ("cancel", "cancelled"),
        ] {
            let fixture = ExportFixture::new(mode);
            let provider = TestProvider {
                target: Some(fixture.root.join(format!("{mode}.wav"))),
                readback: mode,
                selected_names: RefCell::new(Vec::new()),
            };
            let job = submit_export_with_provider(
                &fixture.connection,
                &fixture.root,
                &fixture.project_id,
                fixture.payload(),
                &provider,
            )
            .unwrap();
            assert_eq!(job.status, expected_status);
            assert_eq!(fixture.receipt_count(), 0);
            if mode == "unsupported" {
                assert!(job
                    .runtime_detail
                    .as_deref()
                    .unwrap()
                    .contains("could not verify"));
            }
        }

        let dismissed = ExportFixture::new("dismissed");
        let provider = TestProvider {
            target: None,
            readback: "verified",
            selected_names: RefCell::new(Vec::new()),
        };
        let job = submit_export_with_provider(
            &dismissed.connection,
            &dismissed.root,
            &dismissed.project_id,
            dismissed.payload(),
            &provider,
        )
        .unwrap();
        assert_eq!(job.status, "cancelled");
        assert_eq!(dismissed.receipt_count(), 0);

        let restarted = ExportFixture::new("restarted");
        let job = create_running_job(
            &restarted.connection,
            &restarted.project_id,
            "export",
            Some(restarted.artifact_id.clone()),
        )
        .unwrap();
        restarted
            .connection
            .execute(
                "UPDATE jobs SET payload_json = ?1 WHERE id = ?2",
                params![
                    json!({
                        "stage": "writing",
                        "export_result": {
                            "outcome": "failed",
                            "total_count": 1,
                            "completed_count": 0,
                            "failed_count": 0,
                            "items": [{
                                "artifact_id": restarted.artifact_id,
                                "generated_document_id": null,
                                "output_name": "Synthetic Song - Source.wav",
                                "status": "running",
                                "progress": 35
                            }]
                        }
                    })
                    .to_string(),
                    job.id
                ],
            )
            .unwrap();
        fail_interrupted_exports(&restarted.connection).unwrap();
        let failed = get_export_job(&restarted.connection, &job.id).unwrap();
        assert_eq!(failed.status, "failed");
        assert!(failed
            .runtime_detail
            .as_deref()
            .unwrap()
            .contains("partial provider file"));
        assert_eq!(restarted.receipt_count(), 0);
    }
}
