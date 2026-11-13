//! Offline six-source separation through the app-owned Android runtime.
use super::storage_cleanup::{
    capture_owned_project_file, cleanup_owned_project_files, move_owned_project_file,
    prepare_owned_project_file, project_storage_mutation_guard,
};
use super::*;
use std::io::{Seek, SeekFrom};

const SOURCES: [&str; 6] = ["drums", "bass", "other", "vocals", "guitar", "piano"];
fn stem_artifact_type(source: &str) -> &'static str {
    match source {
        "drums" => "drums_stem",
        "bass" => "bass_stem",
        "other" => "other_stem",
        "vocals" => "vocal_stem",
        "guitar" => "guitar_stem",
        "piano" => "piano_stem",
        _ => unreachable!("only the six validated model sources reach publication"),
    }
}

const MODEL: &str = "htdemucs_6s";
const CANCELLED: &str = "STEMS_CANCELLED";

#[derive(Deserialize, Serialize, Clone, Debug)]
struct RuntimeMetrics {
    threads: u32,
    interop_threads: u32,
    blas_threads: u32,
    blas_parallel: u32,
    blas_implementation: String,
    openblas_sha256: String,
    openblas_config: String,
    inference_s: f64,
    elapsed_s: f64,
}

impl RuntimeMetrics {
    fn validate(&self) -> Result<(), String> {
        if self.threads != 4 || self.interop_threads != 1 || self.blas_threads != 1
            || self.blas_parallel != 1 || self.blas_implementation != "pthread"
            || self.openblas_sha256.len() != 64
            || !self.openblas_sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !self.openblas_config.starts_with("OpenBLAS 0.3.34 ")
            || !self.openblas_config.contains("ARMV8")
            || self.openblas_config.len() > 256
            || !self.openblas_config.bytes().all(|byte| byte.is_ascii_alphanumeric() || b" ._+=-".contains(&byte))
            || !self.inference_s.is_finite() || self.inference_s <= 0.0
            || !self.elapsed_s.is_finite() || self.elapsed_s < self.inference_s
        {
            return Err("Stem runtime differs from the fixed Android T4/B1 profile.".into());
        }
        Ok(())
    }
}


#[derive(Deserialize)]
struct RuntimeManifest {
    success: bool,
    frames: u64,
    sources: Vec<String>,
    outputs: Vec<RuntimeOutput>,
    threads: u32,
    interop_threads: u32,
    blas_threads: u32,
    blas_parallel: u32,
    blas_implementation: String,
    openblas_sha256: String,
    openblas_config: String,
    inference_s: f64,
    elapsed_s: f64,
}

impl RuntimeManifest {
    fn metrics(&self) -> RuntimeMetrics {
        RuntimeMetrics {
            threads: self.threads,
            interop_threads: self.interop_threads,
            blas_threads: self.blas_threads,
            blas_parallel: self.blas_parallel,
            blas_implementation: self.blas_implementation.clone(),
            openblas_sha256: self.openblas_sha256.clone(),
            openblas_config: self.openblas_config.clone(),
            inference_s: self.inference_s,
            elapsed_s: self.elapsed_s,
        }
    }
}

#[derive(Deserialize)]
struct RuntimeOutput {
    source: String,
    file: String,
    frames: u64,
    channels: u32,
    samplerate: u32,
    sha256: String,
}

// Inspect headers without decoding six full tracks into resident memory.
fn wav_pcm_data(file: &mut fs::File) -> Result<(u64, u64), String> {
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err("Stem runtime did not return a PCM WAV.".into());
    }
    let mut pcm = false;
    let mut data = None;
    let mut offset = 12_u64;
    while offset + 8 <= length {
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut chunk = [0_u8; 8];
        file.read_exact(&mut chunk)
            .map_err(|error| error.to_string())?;
        let size = u32::from_le_bytes(chunk[4..8].try_into().unwrap()) as u64;
        let end = offset + 8 + size;
        if end > length {
            return Err("Stem WAV contains a truncated chunk.".into());
        }
        if &chunk[..4] == b"fmt " {
            if size < 16 {
                return Err("Stem WAV format is incomplete.".into());
            }
            let mut fmt = [0_u8; 16];
            file.read_exact(&mut fmt)
                .map_err(|error| error.to_string())?;
            pcm = u16::from_le_bytes(fmt[..2].try_into().unwrap()) == 1
                && u16::from_le_bytes(fmt[2..4].try_into().unwrap()) == 2
                && u32::from_le_bytes(fmt[4..8].try_into().unwrap()) == 44_100
                && u16::from_le_bytes(fmt[12..14].try_into().unwrap()) == 4
                && u16::from_le_bytes(fmt[14..16].try_into().unwrap()) == 16;
        } else if &chunk[..4] == b"data" {
            if size == 0 || size % 4 != 0 || data.is_some() {
                return Err("Stem WAV has invalid frame data.".into());
            }
            data = Some((offset + 8, size / 4));
        }
        offset = end + size % 2;
    }
    if !pcm {
        return Err("Stem audio must be stereo 44.1 kHz PCM16.".into());
    }
    data.ok_or_else(|| "Stem WAV has no audio frames.".into())
}

fn wav_frames(path: &Path) -> Result<u64, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    Ok(wav_pcm_data(&mut file)?.1)
}

// Match the desktop signal and usability metadata computed from the working PCM before encoding.
const STEM_SAMPLE_RATE: u64 = 44_100;
const STEM_PEAK_THRESHOLD: f64 = 1e-3;
const STEM_RMS_THRESHOLD: f64 = 5e-5;
const STEM_ACTIVE_SECONDS: f64 = 0.20;
const STEM_WINDOW_SECONDS: f64 = 0.05;
const STEM_WINDOW_FRAMES: usize = (STEM_SAMPLE_RATE as f64 * STEM_WINDOW_SECONDS) as usize;
const STEM_MIN_RMS_RATIO: f64 = 0.10;
const STEM_MIN_ACTIVE_RATIO: f64 = 0.20;
const STEM_ABSENT_RMS_RATIO: f64 = 0.01;

#[derive(Clone, Copy, Default)]
struct StemSignal {
    peak: f64,
    rms: f64,
    active_seconds: f64,
    inspected_seconds: f64,
}

fn inspect_stem_signal(path: &Path, mut should_cancel: impl FnMut() -> bool) -> Result<StemSignal, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let (offset, frames) = wav_pcm_data(&mut file)?;
    file.seek(SeekFrom::Start(offset)).map_err(|error| error.to_string())?;
    let mut bytes = [0_u8; STEM_WINDOW_FRAMES * 4];
    let mut remaining = frames;
    let mut peak: f64 = 0.0;
    let mut square_sum = 0.0;
    let mut active_frames = 0;
    while remaining != 0 {
        if (frames - remaining) % STEM_SAMPLE_RATE == 0 && should_cancel() {
            return Err(CANCELLED.into());
        }
        let window_frames = remaining.min(STEM_WINDOW_FRAMES as u64);
        let window = &mut bytes[..window_frames as usize * 4];
        file.read_exact(window).map_err(|error| error.to_string())?;
        let mut window_peak: f64 = 0.0;
        let mut window_square_sum = 0.0;
        let mut window_active_frames = 0;
        for frame in window.chunks_exact(4) {
            let left = i16::from_le_bytes([frame[0], frame[1]]).unsigned_abs();
            let right = i16::from_le_bytes([frame[2], frame[3]]).unsigned_abs();
            let magnitude = f64::from(left.max(right)) / 32_768.0;
            window_peak = window_peak.max(magnitude);
            window_square_sum += magnitude * magnitude;
            window_active_frames += u64::from(magnitude >= STEM_RMS_THRESHOLD);
        }
        if window_peak >= STEM_PEAK_THRESHOLD
            && (window_square_sum / window_frames as f64).sqrt() >= STEM_RMS_THRESHOLD
        {
            active_frames += window_active_frames;
        }
        peak = peak.max(window_peak);
        square_sum += window_square_sum;
        remaining -= window_frames;
    }
    Ok(StemSignal {
        peak,
        rms: (square_sum / frames as f64).sqrt(),
        active_seconds: active_frames as f64 / STEM_SAMPLE_RATE as f64,
        inspected_seconds: frames as f64 / STEM_SAMPLE_RATE as f64,
    })
}

impl StemSignal {
    fn reference(signals: &[Self]) -> Self {
        signals.iter().fold(Self::default(), |reference, signal| Self {
            peak: reference.peak.max(signal.peak),
            rms: reference.rms.max(signal.rms),
            active_seconds: reference.active_seconds.max(signal.active_seconds),
            ..Self::default()
        })
    }

    fn metadata(&self, reference: &Self) -> Value {
        fn ratio(value: f64, reference: f64) -> f64 {
            if reference > 0.0 { value / reference } else { 0.0 }
        }

        let has_signal = self.peak >= STEM_PEAK_THRESHOLD
            && self.rms >= STEM_RMS_THRESHOLD
            && self.active_seconds >= STEM_ACTIVE_SECONDS;
        let rms_ratio = ratio(self.rms, reference.rms);
        let active_ratio = ratio(self.active_seconds, reference.active_seconds);
        let (usable, reason) = if !has_signal {
            (false, "absolute_no_signal")
        } else if rms_ratio < STEM_ABSENT_RMS_RATIO {
            (false, "relative_absent")
        } else if rms_ratio < STEM_MIN_RMS_RATIO && active_ratio < STEM_MIN_ACTIVE_RATIO {
            (false, "relative_leakage")
        } else {
            (true, "usable")
        };
        json!({
            "version": 1, "has_signal": has_signal,
            "peak": self.peak, "rms": self.rms, "active_duration_seconds": self.active_seconds,
            "inspected_duration_seconds": self.inspected_seconds,
            "active_ratio": ratio(self.active_seconds, self.inspected_seconds),
            "sample_rate": STEM_SAMPLE_RATE, "channels": 2,
            "thresholds": {
                "peak": STEM_PEAK_THRESHOLD, "rms": STEM_RMS_THRESHOLD,
                "active_duration_seconds": STEM_ACTIVE_SECONDS, "window_seconds": STEM_WINDOW_SECONDS,
            },
            "analysis_usability": {
                "version": 1, "usable": usable, "reason": reason,
                "rms_ratio": rms_ratio,
                "rms_db_below_reference": (rms_ratio > 0.0).then(|| 20.0 * rms_ratio.log10()),
                "active_ratio": active_ratio, "peak_ratio": ratio(self.peak, reference.peak),
                "reference": {
                    "max_rms": reference.rms, "max_active_duration_seconds": reference.active_seconds,
                    "max_peak": reference.peak,
                },
                "thresholds": {
                    "min_rms_ratio": STEM_MIN_RMS_RATIO, "min_active_ratio": STEM_MIN_ACTIVE_RATIO,
                    "clear_absent_rms_ratio": STEM_ABSENT_RMS_RATIO,
                },
            },
        })
    }
}

fn validate_manifest(
    raw: &str,
    directory: &Path,
    expected_frames: u64,
) -> Result<(Vec<PathBuf>, RuntimeMetrics), String> {
    let manifest: RuntimeManifest = serde_json::from_str(raw)
        .map_err(|_| "Stem runtime returned an invalid result manifest.".to_string())?;
    let metrics = manifest.metrics();
    metrics.validate()?;
    let names: HashSet<&str> = manifest.sources.iter().map(String::as_str).collect();
    if !manifest.success
        || manifest.frames != expected_frames
        || expected_frames == 0
        || manifest.sources.len() != 6
        || manifest.outputs.len() != 6
        || names != SOURCES.into_iter().collect()
    {
        return Err("Stem runtime returned an incomplete six-source result.".into());
    }
    let mut paths = Vec::new();
    for source in SOURCES {
        let matching: Vec<_> = manifest
            .outputs
            .iter()
            .filter(|output| output.source == source)
            .collect();
        if matching.len() != 1 {
            return Err("Stem result contains duplicate or missing sources.".into());
        }
        let output = matching[0];
        if output.file != format!("{source}.wav")
            || output.frames != expected_frames
            || output.channels != 2
            || output.samplerate != 44_100
        {
            return Err("Stem result has inconsistent audio properties.".into());
        }
        let path = directory.join(&output.file);
        if fs::symlink_metadata(&path)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
            || wav_frames(&path)? != expected_frames
            || file_sha256(&path)? != output.sha256
        {
            return Err("Stem result failed length or content verification.".into());
        }
        paths.push(path);
    }
    Ok((paths, metrics))
}

fn stem_snapshot(
    connection: &Connection,
    project_id: &str,
    source: &ArtifactSchema,
) -> Result<String, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE project_id = ?1 AND type IN ('drums_stem','bass_stem','other_stem','vocal_stem','guitar_stem','piano_stem','instrumental_stem','kick_drum_substem','snare_drum_substem','cymbals_drum_substem','toms_drum_substem','lead_vocal_substem','backing_vocal_substem') ORDER BY id"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok((row_artifact(row)?, row.get::<_, String>(10)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let rows = rows
        .into_iter()
        .map(|(mut artifact, raw)| {
            let metadata: Value = serde_json::from_str(&raw).map_err(|_| {
                "Saved stem metadata is unreadable. Existing stems were preserved.".to_string()
            })?;
            if !metadata.is_object() {
                return Err(
                    "Saved stem metadata must be an object. Existing stems were preserved."
                        .to_string(),
                );
            }
            artifact.metadata = metadata;
            Ok(artifact)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let coarse = |artifact: &ArtifactSchema| {
        SOURCES
            .iter()
            .any(|name| artifact.r#type == stem_artifact_type(name))
            || artifact.r#type == "instrumental_stem"
    };
    let matching = |artifact: &ArtifactSchema| {
        artifact
            .metadata
            .get("source_artifact_id")
            .and_then(Value::as_str)
            == Some(source.id.as_str())
            || (artifact.metadata.get("source_artifact_id").is_none()
                && source.r#type == "source_audio")
    };
    let parents: HashSet<&str> = rows
        .iter()
        .filter(|artifact| coarse(artifact) && matching(artifact))
        .map(|artifact| artifact.id.as_str())
        .collect();
    let drums: HashSet<&str> = rows
        .iter()
        .filter(|artifact| {
            artifact.r#type == "drums_stem" && parents.contains(artifact.id.as_str())
        })
        .map(|artifact| artifact.id.as_str())
        .collect();
    let vocals: HashSet<&str> = rows.iter().filter(|artifact| {
        artifact.r#type == "vocal_stem" && parents.contains(artifact.id.as_str())
    }).map(|artifact| artifact.id.as_str()).collect();
    let selected = rows
        .iter()
        .filter(|artifact| {
            parents.contains(artifact.id.as_str())
                || (matches!(
                    artifact.r#type.as_str(),
                    "kick_drum_substem"
                        | "snare_drum_substem"
                        | "cymbals_drum_substem"
                        | "toms_drum_substem"
                ) && artifact
                    .metadata
                    .get("parent_artifact_id")
                    .and_then(Value::as_str)
                    .is_some_and(|parent| drums.contains(parent)))
                || (super::storage::vocal_part(&artifact.r#type).is_some()
                    && artifact.metadata.get("parent_artifact_id").and_then(Value::as_str)
                        .is_some_and(|parent| vocals.contains(parent)))
        })
        .map(|artifact| {
            (
                &artifact.id,
                &artifact.r#type,
                &artifact.path,
                &artifact.content_sha256,
                artifact.metadata.to_string(),
                &artifact.created_at,
                &artifact.format,
                &artifact.generated_by,
                artifact.can_delete,
                artifact.can_regenerate,
                &artifact.cache_key,
                &artifact.updated_at,
            )
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&selected).map_err(|error| error.to_string())
}

fn same_model_artifact(prior: &Value, artifact_type: &str) -> Option<(String, Value)> {
    prior.as_array()?.iter().rev().find_map(|row| {
        if row.get(1)?.as_str()? != artifact_type {
            return None;
        }
        let metadata: Value = serde_json::from_str(row.get(4)?.as_str()?).ok()?;
        let model = metadata.get("stem_model").and_then(Value::as_str);
        let id = row.get(0)?.as_str()?;
        (model == Some(MODEL) || model.is_none()).then(|| (id.to_owned(), metadata))
    })
}

fn tombstone_and_remove(connection: &Connection, project_id: &str, id: &str) -> Result<(), String> {
    let artifact = connection
        .query_row(
            &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id=?1 AND project_id=?2"),
            params![id, project_id],
            row_artifact,
        )
        .map_err(|error| error.to_string())?;
    super::manifests::record_local_delete_tombstone(
        connection,
        project_id,
        "artifact",
        id,
        json!({"project_id":project_id,"type":artifact.r#type,"content_sha256":artifact.content_sha256,"size_bytes":artifact.size_bytes}),
    )?;
    connection
        .execute(
            "DELETE FROM artifacts WHERE id=?1 AND project_id=?2",
            params![id, project_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn stopped(connection: &Connection, job_id: &str) -> bool {
    connection
        .query_row(
            "SELECT cancel_requested != 0 OR status != 'running' FROM jobs WHERE id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .unwrap_or(true)
}

struct StagingFiles {
    root: PathBuf,
    project_root: PathBuf,
    paths: Vec<PathBuf>,
}

impl Drop for StagingFiles {
    fn drop(&mut self) {
        let owned = self
            .paths
            .iter()
            .filter_map(|path| {
                capture_owned_project_file(&self.root, &self.project_root, path).ok()
            })
            .collect::<Vec<_>>();
        cleanup_owned_project_files(&owned);
    }
}

struct Publication<'a> {
    root: &'a Path,
    project_id: &'a str,
    job_id: &'a str,
    source: &'a ArtifactSchema,
    source_sha256: &'a str,
    prior_stems: &'a str,
    format: &'a str,
    frames: u64,
    runtime: &'a RuntimeMetrics,
    started: Instant,
}

fn publish_stems(
    connection: &Connection,
    plan: &Publication<'_>,
    staged: &[PathBuf],
    signals: &[StemSignal],
) -> Result<(), String> {
    if staged.len() != SOURCES.len() || signals.len() != SOURCES.len() {
        return Err("Six staged stem files are required.".into());
    }
    let reference = StemSignal::reference(signals);
    let project_root = project_root_path(plan.root, plan.project_id)?;
    let _guard = project_storage_mutation_guard();
    let transaction =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
    let mut published = Vec::new();
    let result = (|| {
        if stopped(&transaction, plan.job_id) {
            return Err(CANCELLED.into());
        }
        require_sync_editable_project(&transaction, plan.project_id)?;
        let current: (String, String) = transaction
            .query_row(
                "SELECT path, type FROM artifacts WHERE id = ?1 AND project_id = ?2",
                params![plan.source.id, plan.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "Stem source is no longer owned by this project.".to_string())?;
        if current.0 != plan.source.path
            || current.1 != plan.source.r#type
            || file_sha256(Path::new(&current.0))? != plan.source_sha256
        {
            return Err("Stem source changed before publication.".into());
        }
        if stem_snapshot(&transaction, plan.project_id, plan.source)? != plan.prior_stems {
            return Err("Saved stems changed while processing. Newer stems were preserved.".into());
        }
        let prior: Value =
            serde_json::from_str(plan.prior_stems).map_err(|error| error.to_string())?;
        let mut ids = Vec::new();
        for ((source, path), signal) in SOURCES.into_iter().zip(staged).zip(signals) {
            let temporary = capture_owned_project_file(plan.root, &project_root, path)?;
            let output = project_root
                .join("stems")
                .join(plan.job_id)
                .join(format!("{source}.{}", plan.format));
            if output.exists() {
                return Err("Stem output already exists; existing files were preserved.".into());
            }
            published.push(move_owned_project_file(&temporary, &output)?);
            let artifact_type = stem_artifact_type(source);
            let (id, prior_metadata) = match same_model_artifact(&prior, artifact_type) {
                Some(artifact) => artifact,
                None => (new_artifact_id()?, json!({})),
            };
            let mut metadata = prior_metadata.as_object().cloned().unwrap_or_default();
            metadata.remove("drum_substems");
            metadata.remove("vocal_substems");
            let generated_metadata = json!({
                "mode":"six_stems", "stem_model":MODEL, "stem_model_label":"Default (6 stems model)",
                "stem_source":source, "source_artifact_id":plan.source.id,
                "source_artifact_type":plan.source.r#type, "source_sha256":plan.source_sha256,
                "engine":"demucs-infer", "model":MODEL, "device":"cpu", "threads":plan.runtime.threads,
                "interop_threads":plan.runtime.interop_threads, "blas_threads":plan.runtime.blas_threads,
                "blas_parallel":plan.runtime.blas_parallel, "blas_implementation":plan.runtime.blas_implementation,
                "openblas_sha256":plan.runtime.openblas_sha256, "openblas_config":plan.runtime.openblas_config,
                "inference_s":plan.runtime.inference_s, "worker_elapsed_s":plan.runtime.elapsed_s,
                "runtime_variant":"cpu-t4-b1-openblas-pthread",
                "output_sample_rate":44_100, "output_channels":2, "output_frames":plan.frames,
                "runtime":"cpython-3.14.10-torch-2.15.0-cpu-t4-b1",
                "model_sha256":"d2a1745f0744721f6b8ca5bf469b67c651ea5ed1b52998cab033b2158609d411",
                "demucs_revision":"4b79d5c756ce298503d90b0cca2abbc76c565416", "duration_seconds":plan.frames as f64 / 44_100.0,
                "stem_signal":signal.metadata(&reference),
            });
            metadata.extend(generated_metadata.as_object().unwrap().clone());
            transaction.execute(
                "INSERT INTO artifacts (id, project_id, type, format, path, content_sha256, size_bytes, generated_by, can_delete, can_regenerate, metadata_json, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'demucs',1,1,?8,?9) ON CONFLICT(id) DO UPDATE SET format=excluded.format, path=excluded.path, content_sha256=excluded.content_sha256, size_bytes=excluded.size_bytes, generated_by=excluded.generated_by, can_delete=1, can_regenerate=1, metadata_json=excluded.metadata_json, cache_key=NULL, created_at=excluded.created_at, updated_at=excluded.created_at",
                params![id, plan.project_id, artifact_type, plan.format, output.to_string_lossy(), file_sha256(&output)?, fs::metadata(&output).map_err(|error| error.to_string())?.len() as i64, Value::Object(metadata).to_string(), now_iso()],
            ).map_err(|error| error.to_string())?;
            ids.push(id);
        }
        // Remove obsolete model rows and derived drum children only for this source.
        for row in prior.as_array().into_iter().flatten() {
            if let Some(id) = row.get(0).and_then(Value::as_str) {
                if !ids.iter().any(|kept| kept == id) {
                    tombstone_and_remove(&transaction, plan.project_id, id)?;
                }
            }
        }
        let updated = transaction.execute(
            "UPDATE jobs SET status='completed', progress=100, payload_json=json_set(payload_json,'$.stage','complete','$.stage_label','Six stems ready','$.runtime_detail','CPU (Torch 4, OpenBLAS 1)','$.openblas_sha256',?5), runtime_device='cpu', result_artifact_ids_json=?1, completed_at=?2, updated_at=?2, duration_seconds=?3 WHERE id=?4 AND status='running' AND cancel_requested=0",
            params![json!(ids).to_string(), now_iso(), plan.started.elapsed().as_secs_f64(), plan.job_id, plan.runtime.openblas_sha256],
        ).map_err(|error| error.to_string())?;
        if updated != 1 {
            return Err(CANCELLED.into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        drop(transaction);
        cleanup_owned_project_files(&published);
        return Err(error);
    }
    if let Err(error) = transaction.commit() {
        cleanup_owned_project_files(&published);
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(target_os = "android")]
pub fn mobile_submit_stems(
    app: AppHandle,
    project_id: String,
    mut payload: Value,
) -> Result<JobResponse, String> {
    let _admission = super::audio::PROCESSING_ADMISSION
        .lock()
        .map_err(|_| "Processing admission lock was poisoned.".to_string())?;
    let connection = db(&app)?;
    let root = app_data_root(&app)?;
    let _ = require_sync_editable_project(&connection, &project_id)?;
    if !payload.is_object() {
        return Err("Stem request must be an object.".into());
    }
    if payload
        .get("stem_model")
        .and_then(Value::as_str)
        .unwrap_or(MODEL)
        != MODEL
        || payload
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("stems")
            != "stems"
    {
        return Err("Android supports the bundled six-source stem model only.".into());
    }
    let format = requested_output_format(&payload)?.to_string();
    crate::mobile_ffmpeg::AudioOutputFormat::parse(&format)?;
    if !runtime_available() {
        return Err("Bundled Android stem runtime or model is unavailable.".into());
    }
    if let Some(job) = connection.query_row(
        &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE project_id=?1 AND type='stems' AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1"),
        params![project_id], row_job,
    ).optional().map_err(|error| error.to_string())? { return Ok(JobResponse { job }); }
    let source = if let Some(id) = payload.get("source_artifact_id").and_then(Value::as_str) {
        connection.query_row(&format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id=?1 AND project_id=?2 AND type IN ('source_audio','preview_mix')"), params![id, project_id], row_artifact)
            .map_err(|_| "Select source audio or a saved practice mix for separation.".to_string())?
    } else {
        get_source_artifact(&connection, &project_id)?
    };
    let project_root = project_root_path(&root, &project_id)?;
    {
        let _guard = project_storage_mutation_guard();
        capture_owned_project_file(&root, &project_root, Path::new(&source.path))?;
    }
    let source_hash = file_sha256(Path::new(&source.path))?;
    let prior = stem_snapshot(&connection, &project_id, &source)?;
    if prior != "[]"
        && !payload
            .get("force")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Err("Stems already exist. Choose regenerate to replace the saved set.".into());
    }

    payload["stem_model"] = json!(MODEL);
    payload["device"] = json!("cpu");
    payload["threads"] = json!(4);
    payload["interop_threads"] = json!(1);
    payload["blas_threads"] = json!(1);
    payload["blas_parallel"] = json!(1);
    payload["runtime_variant"] = json!("cpu-t4-b1-openblas-pthread");
    payload.as_object_mut().unwrap().remove("openblas_sha256");
    payload["source_sha256"] = json!(source_hash);
    payload["prior_stems"] = json!(prior);
    let (job, directory) = register_stem_job(&connection, &root, &project_id, &source.id, payload, &format)?;
    let id = job.id.clone();
    super::audio::enqueue_processing(root.clone(), id.clone(), move || {
        run_stem_job(
            root,
            project_id,
            id,
            source,
            source_hash,
            prior,
            format,
            directory,
        );
    })?;
    Ok(JobResponse { job })
}

pub(super) fn register_stem_job(
    connection: &Connection,
    root: &Path,
    project_id: &str,
    source_id: &str,
    mut payload: Value,
    format: &str,
) -> Result<(JobSchema, PathBuf), String> {
    let project_root = project_root_path(root, project_id)?;
    let _guard = project_storage_mutation_guard();
    let transaction =
        rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
    require_sync_editable_project(&transaction, project_id)?;
    let job = create_pending_processing_job(&transaction, project_id, "stems", Some(source_id.to_owned()))?;
    let directory = project_root.join("stems").join(format!(".{}", job.id));
    let paths = staging_paths(&directory, format);
    for path in &paths {
        prepare_owned_project_file(root, &project_root, path)?;
    }
    payload["staging_paths"] = json!(paths);
    transaction
        .execute(
            "UPDATE jobs SET payload_json=?1 WHERE id=?2",
            params![payload.to_string(), job.id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok((job, directory))
}

fn requested_output_format(payload: &Value) -> Result<&str, String> {
    match payload.get("output_format") {
        None => Ok("wav"),
        Some(Value::String(format))
            if matches!(format.as_str(), "wav" | "flac" | "mp3" | "m4a") =>
        {
            Ok(format)
        }
        _ => Err("Android stem output requires WAV, FLAC, MP3, or M4A.".into()),
    }
}

fn native_output_directory(directory: &Path) -> PathBuf {
    directory.join("native")
}

fn staging_paths(directory: &Path, format: &str) -> Vec<PathBuf> {
    std::iter::once(directory.join("input.wav"))
        .chain(
            SOURCES.map(|source| native_output_directory(directory).join(format!("{source}.wav"))),
        )
        .chain(
            [".result.json.tmp", "result.json"]
                .map(|name| native_output_directory(directory).join(name)),
        )
        .chain(SOURCES.map(|source| directory.join(format!("encoded-{source}.{format}"))))
        .collect()
}

#[cfg(target_os = "android")]
#[allow(clippy::too_many_arguments)]
fn run_stem_job(
    root: PathBuf,
    project_id: String,
    job_id: String,
    source: ArtifactSchema,
    source_hash: String,
    prior: String,
    format: String,
    directory: PathBuf,
) {
    let started = Instant::now();
    let Ok(connection) = db_at_root(&root) else {
        return;
    };
    let Ok(project_root) = project_root_path(&root, &project_id) else {
        return;
    };
    let cleanup = StagingFiles {
        root: root.clone(),
        project_root,
        paths: staging_paths(&directory, &format),
    };
    let result = (|| {
        if stopped(&connection, &job_id) {
            return Err(CANCELLED.to_string());
        }
        update_job_stage(
            &connection,
            &job_id,
            1,
            "prepare",
            "Preparing stereo stem audio",
        )?;
        let input = directory.join("input.wav");
        crate::mobile_ffmpeg::render_stem_audio(
            Path::new(&source.path),
            &input,
            &mut || stopped(&connection, &job_id),
            &mut |progress| {
                let _ = update_job_stage(
                    &connection,
                    &job_id,
                    i64::from(progress.clamp(0, 100)) / 10,
                    "prepare",
                    "Preparing stereo stem audio",
                );
            },
        )?;
        let frames = wav_frames(&input)?;
        if stopped(&connection, &job_id) {
            return Err(CANCELLED.into());
        }
        update_job_stage(
            &connection,
            &job_id,
            10,
            "separate",
            "Separating six stems on CPU",
        )?;
        let (sender, receiver) = std::sync::mpsc::channel();
        let runtime_id = job_id.clone();
        let runtime_directory = native_output_directory(&directory);
        std::thread::spawn(move || {
            let _ = sender.send(run_runtime(&input, &runtime_directory, &runtime_id));
        });
        let manifest = loop {
            match receiver.recv_timeout(std::time::Duration::from_millis(250)) {
                Ok(result) => break result?,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("Android stem worker stopped unexpectedly.".into())
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if stopped(&connection, &job_id) {
                        cancel_runtime(&job_id);
                    } else {
                        let _ = update_job_stage(
                            &connection,
                            &job_id,
                            10 + i64::from(runtime_progress(&job_id).clamp(0, 100)) * 65 / 100,
                            "separate",
                            "Separating six stems on CPU",
                        );
                    }
                }
            }
        };
        if stopped(&connection, &job_id) {
            return Err(CANCELLED.into());
        }
        let (outputs, runtime) = validate_manifest(&manifest, &native_output_directory(&directory), frames)?;
        let mut encoded = Vec::new();
        let mut signals = Vec::new();
        for (index, (source, wav)) in SOURCES.into_iter().zip(outputs).enumerate() {
            if stopped(&connection, &job_id) {
                return Err(CANCELLED.into());
            }
            let destination = directory.join(format!("encoded-{source}.{format}"));
            update_job_stage(
                &connection,
                &job_id,
                76 + index as i64 * 3,
                "encode",
                "Saving durable stem audio",
            )?;
            signals.push(inspect_stem_signal(&wav, || stopped(&connection, &job_id))?);
            let rendered = crate::mobile_ffmpeg::render_audio(
                &wav,
                &destination,
                crate::mobile_ffmpeg::AudioOutputFormat::parse(&format)?,
                0.0,
                &mut || stopped(&connection, &job_id),
                &mut |_| {},
            )?;
            if rendered.sample_rate != 44_100 || rendered.channels != 2 {
                return Err("Encoded stem properties changed unexpectedly.".into());
            }
            crate::native_audio::decode::probe_mobile_durable_audio(&destination, &format)?;
            encoded.push(destination);
        }
        publish_stems(
            &connection,
            &Publication {
                root: &root,
                project_id: &project_id,
                job_id: &job_id,
                source: &source,
                source_sha256: &source_hash,
                prior_stems: &prior,
                format: &format,
                frames,
                runtime: &runtime,
                started,
            },
            &encoded,
            &signals,
        )
    })();
    if let Err(message) = result {
        if stopped(&connection, &job_id) || message == CANCELLED {
            let _ = connection.execute("UPDATE jobs SET status='cancelled', completed_at=?1, updated_at=?1, duration_seconds=?2 WHERE id=?3 AND status IN ('pending','running','cancelled')", params![now_iso(), started.elapsed().as_secs_f64(), job_id]);
        } else {
            let _ = fail_running_job(
                &connection,
                &job_id,
                &message,
                started.elapsed().as_secs_f64(),
            );
        }
    }
    drop(cleanup);
    reconcile_project_storage_after_commit(&connection, &root, &project_id);
}

#[cfg(target_os = "android")]
fn with_activity<T>(
    operation: impl FnOnce(&mut jni::Env<'_>, &jni::objects::JObject<'_>) -> jni::errors::Result<T>
        + Send,
) -> Result<T, String>
where
    T: Send,
{
    use jni::{
        objects::{Global, JObject},
        JavaVM,
    };
    use tauri::tao::platform::android::prelude::main_android_context;
    let context = main_android_context().ok_or("Android stem runtime is unavailable.")?;
    if context.java_vm.is_null() || context.context_jobject.is_null() {
        return Err("Android stem runtime is unavailable.".into());
    }
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    vm.attach_current_thread(|env| {
        let raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&raw)? };
        let result = operation(env, activity.as_ref());
        if result.is_err() {
            env.exception_clear();
        }
        result
    })
    .map_err(|_| "Android stem runtime failed or stopped unexpectedly.".into())
}

#[cfg(target_os = "android")]
pub(super) fn runtime_available() -> bool {
    matches!(runtime_status().as_str(), "ready" | "download-required")
}

#[cfg(target_os = "android")]
fn runtime_status() -> String {
    use jni::{jni_sig, jni_str, objects::JString};
    with_activity(|env, activity| {
        let value = env
            .call_method(
                activity,
                jni_str!("getTuneForgeDemucsStatus"),
                jni_sig!(() -> JString),
                &[],
            )?
            .into_object()?;
        JString::cast_local(env, value)?.try_to_string(env)
    })
    .unwrap_or_else(|_| "unavailable".into())
}

fn sanitized_runtime_error(code: &str) -> String {
    if code.starts_with("DEMUCS_")
        && code.len() <= 80
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
    {
        format!("Android stem separation failed: {code}.")
    } else {
        "Android stem separation failed: DEMUCS_RUNTIME_FAILED.".into()
    }
}

#[cfg(target_os = "android")]
fn run_runtime(input: &Path, directory: &Path, id: &str) -> Result<String, String> {
    use jni::{
        jni_sig, jni_str,
        objects::{JString, JValue},
    };
    with_activity(|env, activity| {
        let input = env.new_string(input.to_string_lossy())?;
        let directory = env.new_string(directory.to_string_lossy())?;
        let id = env.new_string(id)?;
        let value = env
            .call_method(
                activity,
                jni_str!("runTuneForgeDemucs"),
                jni_sig!((JString, JString, JString) -> JString),
                &[
                    JValue::Object(input.as_ref()),
                    JValue::Object(directory.as_ref()),
                    JValue::Object(id.as_ref()),
                ],
            )?
            .into_object()?;
        JString::cast_local(env, value)?.try_to_string(env)
    })
    .map_err(|_| {
        let code = with_activity(|env, activity| {
            let id = env.new_string(id)?;
            let value = env
                .call_method(
                    activity,
                    jni_str!("takeTuneForgeDemucsError"),
                    jni_sig!((JString) -> JString),
                    &[JValue::Object(id.as_ref())],
                )?
                .into_object()?;
            JString::cast_local(env, value)?.try_to_string(env)
        })
        .unwrap_or_else(|_| "DEMUCS_RUNTIME_FAILED".into());
        sanitized_runtime_error(&code)
    })
}

#[cfg(target_os = "android")]
pub(super) fn cancel_runtime(id: &str) {
    use jni::{jni_sig, jni_str, objects::JValue};
    let _ = with_activity(|env, activity| {
        let id = env.new_string(id)?;
        env.call_method(
            activity,
            jni_str!("cancelTuneForgeDemucs"),
            jni_sig!((JString) -> ()),
            &[JValue::Object(id.as_ref())],
        )?;
        Ok(())
    });
}

#[cfg(target_os = "android")]
fn runtime_progress(id: &str) -> i32 {
    use jni::{jni_sig, jni_str, objects::JValue};
    with_activity(|env, activity| {
        let id = env.new_string(id)?;
        env.call_method(
            activity,
            jni_str!("getTuneForgeDemucsProgress"),
            jni_sig!((JString) -> i32),
            &[JValue::Object(id.as_ref())],
        )?
        .i()
    })
    .unwrap_or(0)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    fn stereo_wav(path: &Path, frames: u32) {
        stereo_wav_with(path, frames, |_| (1234, -2345));
    }

    fn stereo_wav_with(path: &Path, frames: u32, sample: impl Fn(u32) -> (i16, i16)) {
        let size = frames * 4;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&44_100_u32.to_le_bytes());
        bytes.extend_from_slice(&176_400_u32.to_le_bytes());
        bytes.extend_from_slice(&4_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&size.to_le_bytes());
        for frame in 0..frames {
            let (left, right) = sample(frame);
            bytes.extend_from_slice(&left.to_le_bytes());
            bytes.extend_from_slice(&right.to_le_bytes());
        }
        fs::write(path, bytes).unwrap();
    }

    struct Fixture {
        root: PathBuf,
        project: String,
        source: ArtifactSchema,
        connection: Connection,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("tuneforge-stems-{}", new_artifact_id().unwrap()));
            let project = format!("proj_sha256_{}", "3".repeat(64));
            let directory = root.join("projects").join(&project);
            fs::create_dir_all(directory.join("stems")).unwrap();
            let path = directory.join("source.wav");
            stereo_wav(&path, 64);
            let connection = db_at_root(&root).unwrap();
            connection.execute("INSERT INTO projects (id,display_name,source_path,imported_path,sync_status,created_at,updated_at) VALUES (?1,'Synthetic',?2,?2,'local',?3,?3)", params![project,path.to_string_lossy(),now_iso()]).unwrap();
            connection.execute("INSERT INTO artifacts (id,project_id,type,format,path,size_bytes,generated_by,can_delete,can_regenerate,metadata_json,created_at) VALUES ('source',?1,'source_audio','wav',?2,300,'import',0,0,'{}',?3)",params![project,path.to_string_lossy(),now_iso()]).unwrap();
            let source = get_source_artifact(&connection, &project).unwrap();
            Self {
                root,
                project,
                source,
                connection,
            }
        }
        fn stage(&self) -> Vec<PathBuf> {
            SOURCES
                .into_iter()
                .map(|source| {
                    let path = self
                        .root
                        .join("projects")
                        .join(&self.project)
                        .join("stems")
                        .join(format!("stage-{source}.wav"));
                    stereo_wav(&path, 64);
                    path
                })
                .collect()
        }
        fn job(&self) -> JobSchema {
            create_running_job(
                &self.connection,
                &self.project,
                "stems",
                Some("source".into()),
            )
            .unwrap()
        }
        fn publish(
            &self,
            job: &JobSchema,
            staged: &[PathBuf],
            snapshot: &str,
            hash: &str,
        ) -> Result<(), String> {
            let frames = wav_frames(&staged[0])?;
            let signal = inspect_stem_signal(&staged[0], || false)?;
            publish_stems(
                &self.connection,
                &Publication {
                    root: &self.root,
                    project_id: &self.project,
                    job_id: &job.id,
                    source: &self.source,
                    source_sha256: hash,
                    prior_stems: snapshot,
                    format: "wav",
                    frames,
                    runtime: &runtime_metrics_fixture(),
                    started: Instant::now(),
                },
                staged,
                &[signal; SOURCES.len()],
            )
        }
        fn artifact_count(&self) -> i64 {
            self.connection
                .query_row(
                    "SELECT count(*) FROM artifacts WHERE project_id=?1 AND type LIKE '%_stem'",
                    params![self.project],
                    |row| row.get(0),
                )
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    pub(in crate::mobile_backend) fn publish_synthetic_stems_for_sync(
        connection: &Connection,
        root: &Path,
        project_id: &str,
    ) {
        let source = get_source_artifact(connection, project_id).unwrap();
        let snapshot = stem_snapshot(connection, project_id, &source).unwrap();
        let job = create_running_job(connection, project_id, "stems", Some(source.id.clone())).unwrap();
        let directory = project_root_path(root, project_id).unwrap().join("stems").join(format!(".{}", job.id));
        fs::create_dir_all(&directory).unwrap();
        let frames = 22_100;
        let mut staged = Vec::new();
        let mut signals = Vec::new();
        for (index, stem_source) in SOURCES.into_iter().enumerate() {
            let path = directory.join(format!("{stem_source}.wav"));
            let amplitude = match stem_source {
                "piano" => 0.0,
                "guitar" => 40.0,
                _ => 8000.0,
            };
            let hz = 200.0 + index as f64 * 35.0;
            stereo_wav_with(&path, frames, |frame| {
                let phase = std::f64::consts::TAU * hz * frame as f64 / STEM_SAMPLE_RATE as f64;
                ((amplitude * phase.sin()) as i16, (amplitude * phase.cos()) as i16)
            });
            signals.push(inspect_stem_signal(&path, || false).unwrap());
            staged.push(path);
        }
        publish_stems(
            connection,
            &Publication {
                root, project_id, job_id: &job.id, source: &source,
                source_sha256: &file_sha256(Path::new(&source.path)).unwrap(),
                prior_stems: &snapshot, format: "wav", frames: u64::from(frames),
                runtime: &runtime_metrics_fixture(), started: Instant::now(),
            },
            &staged,
            &signals,
        ).unwrap();
    }

    #[test]
    fn native_command_paths_keep_the_output_directory_pristine() {
        let fixture = Fixture::new();
        let project_root = fixture.root.join("projects").join(&fixture.project);
        let directory = project_root.join("stems/.pending");
        let paths = staging_paths(&directory, "flac");
        for path in &paths {
            prepare_owned_project_file(&fixture.root, &project_root, path).unwrap();
        }
        stereo_wav(&directory.join("input.wav"), 64);
        assert_eq!(
            fs::read_dir(native_output_directory(&directory))
                .unwrap()
                .count(),
            0
        );
        assert!(!directory
            .join("input.wav")
            .starts_with(native_output_directory(&directory)));
        for source in SOURCES {
            assert!(
                paths.contains(&native_output_directory(&directory).join(format!("{source}.wav")))
            );
        }
        let job = fixture.job();
        fixture
            .connection
            .execute(
                "UPDATE jobs SET payload_json=?1 WHERE id=?2",
                params![json!({"staging_paths":paths}).to_string(), job.id],
            )
            .unwrap();
        let receipts = [".result.json.tmp", "result.json"]
            .map(|name| native_output_directory(&directory).join(name));
        for path in &receipts {
            assert!(paths.contains(path));
            fs::write(path, b"synthetic receipt").unwrap();
        }
        reconcile_project_storage_after_commit(
            &fixture.connection,
            &fixture.root,
            &fixture.project,
        );
        assert!(receipts.iter().all(|path| path.exists()));
        drop(StagingFiles {
            root: fixture.root.clone(),
            project_root,
            paths,
        });
        assert!(receipts.iter().all(|path| !path.exists()));
    }

    #[test]
    fn stem_output_format_matches_the_normal_request_default_and_explicit_selection() {
        assert_eq!(requested_output_format(&json!({})).unwrap(), "wav");
        assert_eq!(
            requested_output_format(&json!({"output_format":"flac"})).unwrap(),
            "flac"
        );
        assert!(requested_output_format(&json!({"output_format":null})).is_err());
        assert!(requested_output_format(&json!({"output_format":"opus"})).is_err());
    }

    #[test]
    fn native_error_reporting_retains_codes_without_worker_details() {
        assert!(sanitized_runtime_error("DEMUCS_TIMEOUT").contains("DEMUCS_TIMEOUT"));
        assert_eq!(
            sanitized_runtime_error("worker failed /private/source.wav"),
            "Android stem separation failed: DEMUCS_RUNTIME_FAILED."
        );
    }

    const TEST_OPENBLAS_SHA256: &str = "65eead9a82b4b870937bdac28eb2ab7470f34438f1ffff27d32d308d891bcfce";

    fn runtime_metrics_fixture() -> RuntimeMetrics {
        RuntimeMetrics { threads: 4, interop_threads: 1, blas_threads: 1, blas_parallel: 1,
            blas_implementation: "pthread".into(), openblas_sha256: TEST_OPENBLAS_SHA256.into(),
            openblas_config: "OpenBLAS 0.3.34 NO_AFFINITY ARMV8".into(),
            inference_s: 1.0, elapsed_s: 2.0 }
    }

    #[test]
    fn runtime_metrics_reject_wrong_effective_threads_blas_implementation_and_timing() {
        assert!(runtime_metrics_fixture().validate().is_ok());
        let mut wrong = runtime_metrics_fixture(); wrong.threads = 1;
        assert!(wrong.validate().is_err());
        let mut wrong = runtime_metrics_fixture(); wrong.blas_threads = 2;
        assert!(wrong.validate().is_err());
        let mut wrong = runtime_metrics_fixture(); wrong.blas_parallel = 0;
        assert!(wrong.validate().is_err());
        let mut wrong = runtime_metrics_fixture(); wrong.openblas_sha256 = "Z".repeat(64);
        assert!(wrong.validate().is_err());
        let mut wrong = runtime_metrics_fixture(); wrong.inference_s = f64::NAN;
        assert!(wrong.validate().is_err());
        let mut wrong = runtime_metrics_fixture(); wrong.elapsed_s = 0.5;
        assert!(wrong.validate().is_err());
        let mut wrong = runtime_metrics_fixture(); wrong.openblas_config = "/private/path".into();
        assert!(wrong.validate().is_err());
    }

    #[test]
    fn manifest_requires_exact_six_mapped_stereo_outputs_and_content() {
        let fixture = Fixture::new();
        let directory = fixture.root.join("native");
        fs::create_dir_all(&directory).unwrap();
        let outputs = SOURCES.map(|source| {
            let path = directory.join(format!("{source}.wav")); stereo_wav(&path,64);
            json!({"source":source,"file":format!("{source}.wav"),"frames":64,"channels":2,"samplerate":44100,"sha256":file_sha256(&path).unwrap()})
        });
        let mut manifest = json!({"success":true,"frames":64,"sources":SOURCES,"outputs":outputs});
        manifest.as_object_mut().unwrap().extend(serde_json::to_value(runtime_metrics_fixture()).unwrap().as_object().unwrap().clone());
        if let Err(error) = serde_json::from_str::<RuntimeManifest>(&manifest.to_string()) {
            panic!("Synthetic runtime receipt decoding failed: {error}");
        }
        assert_eq!(
            validate_manifest(&manifest.to_string(), &directory, 64)
                .unwrap()
                .0.len(),
            6
        );
        let mut wrong = manifest.clone();
        wrong["outputs"][0]["file"] = json!("../drums.wav");
        assert!(validate_manifest(&wrong.to_string(), &directory, 64).is_err());
        let mut wrong = manifest.clone();
        wrong["outputs"][1]["source"] = json!("drums");
        assert!(validate_manifest(&wrong.to_string(), &directory, 64).is_err());
        let mut wrong = manifest.clone();
        wrong["outputs"][2]["sha256"] = json!("0".repeat(64));
        assert!(validate_manifest(&wrong.to_string(), &directory, 64).is_err());
        assert!(validate_manifest(&manifest.to_string(), &directory, 63).is_err());
        stereo_wav(&directory.join("guitar.wav"), 63);
        assert!(validate_manifest(&manifest.to_string(), &directory, 64).is_err());
    }

    #[test]
    fn publication_commits_six_playable_rows_together_and_persists_source_identity() {
        let fixture = Fixture::new();
        let job = fixture.job();
        let hash = file_sha256(Path::new(&fixture.source.path)).unwrap();
        let staged = fixture.stage();
        for path in &staged {
            stereo_wav(path, 8_820);
        }
        fixture.publish(&job, &staged, "[]", &hash).unwrap();
        assert_eq!(fixture.artifact_count(), 6);
        let types: Vec<String> = fixture
            .connection
            .prepare("SELECT type FROM artifacts WHERE type LIKE '%_stem' ORDER BY type")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            types,
            vec![
                "bass_stem",
                "drums_stem",
                "guitar_stem",
                "other_stem",
                "piano_stem",
                "vocal_stem"
            ]
        );
        let raw: String = fixture
            .connection
            .query_row(
                "SELECT result_artifact_ids_json FROM jobs WHERE id=?1 AND status='completed'",
                params![job.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Vec<String>>(&raw).unwrap().len(), 6);
        let mut statement=fixture.connection.prepare("SELECT path, metadata_json, content_sha256 FROM artifacts WHERE type LIKE '%_stem'").unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .unwrap();
        for row in rows {
            let (path, metadata, content) = row.unwrap();
            assert_eq!(wav_frames(Path::new(&path)).unwrap(), 8_820);
            assert_eq!(file_sha256(Path::new(&path)).unwrap(), content);
            let metadata: Value = serde_json::from_str(&metadata).unwrap();
            // Synced desktop drum refinement requires this persisted model/mode contract.
            assert_eq!(metadata["stem_model"], "htdemucs_6s");
            assert_eq!(metadata["mode"], "six_stems");
            assert_eq!(metadata["source_artifact_id"], "source");
            assert_eq!(metadata["source_sha256"], hash);
            assert_eq!(metadata["device"], "cpu");
            assert_eq!(metadata["threads"], 4);
            assert_eq!(metadata["interop_threads"], 1);
            assert_eq!(metadata["blas_threads"], 1);
            assert_eq!(metadata["blas_parallel"], 1);
            assert_eq!(metadata["openblas_sha256"], TEST_OPENBLAS_SHA256);
            assert_eq!(metadata["stem_signal"]["has_signal"], true);
            assert_eq!(metadata["stem_signal"]["active_duration_seconds"], 0.20);
            assert_eq!(metadata["stem_signal"]["analysis_usability"]["usable"], true);
        }
    }

    #[test]
    fn cancellation_and_replaced_source_preserve_previous_stems() {
        let fixture = Fixture::new();
        let first = fixture.job();
        let hash = file_sha256(Path::new(&fixture.source.path)).unwrap();
        fixture
            .publish(&first, &fixture.stage(), "[]", &hash)
            .unwrap();
        let previous =
            stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap();
        let job = fixture.job();
        fixture
            .connection
            .execute(
                "UPDATE jobs SET cancel_requested=1 WHERE id=?1",
                params![job.id],
            )
            .unwrap();
        assert_eq!(
            fixture
                .publish(&job, &fixture.stage(), &previous, &hash)
                .unwrap_err(),
            CANCELLED
        );
        assert_eq!(
            stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap(),
            previous
        );
        let job = fixture.job();
        stereo_wav(Path::new(&fixture.source.path), 65);
        assert!(fixture
            .publish(&job, &fixture.stage(), &previous, &hash)
            .unwrap_err()
            .contains("source changed"));
        assert_eq!(
            stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap(),
            previous
        );
    }

    #[test]
    fn partial_publication_rolls_back_rows_and_files_and_preserves_previous_set() {
        let fixture = Fixture::new();
        let first = fixture.job();
        let hash = file_sha256(Path::new(&fixture.source.path)).unwrap();
        fixture
            .publish(&first, &fixture.stage(), "[]", &hash)
            .unwrap();
        let previous =
            stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap();
        let job = fixture.job();
        let paths = fixture.stage();
        fs::remove_file(&paths[3]).unwrap();
        assert!(fixture.publish(&job, &paths, &previous, &hash).is_err());
        assert_eq!(fixture.artifact_count(), 6);
        assert_eq!(
            stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap(),
            previous
        );
        let output = fixture
            .root
            .join("projects")
            .join(&fixture.project)
            .join("stems")
            .join(&job.id);
        assert!(!output.join("drums.wav").exists());
        assert!(!output.join("bass.wav").exists());
    }

    #[test]
    fn regeneration_preserves_other_sources_reuses_ids_and_tombstones_only_removed_rows() {
        let fixture = Fixture::new();
        let hash = file_sha256(Path::new(&fixture.source.path)).unwrap();
        fixture
            .publish(&fixture.job(), &fixture.stage(), "[]", &hash)
            .unwrap();
        let initial =
            stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap();
        let initial_rows: Value = serde_json::from_str(&initial).unwrap();
        let initial_ids: HashSet<String> = initial_rows
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row[0].as_str().unwrap().into())
            .collect();
        let drums = initial_rows
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row[1] == "drums_stem")
            .unwrap()[0]
            .as_str()
            .unwrap();
        let vocals = initial_rows.as_array().unwrap().iter().find(|row| row[1] == "vocal_stem")
            .unwrap()[0].as_str().unwrap();
        let insert = |id: &str, kind: &str, metadata: Value| {
            let path = fixture
                .root
                .join("projects")
                .join(&fixture.project)
                .join(format!("{id}.wav"));
            stereo_wav(&path, 64);
            fixture.connection.execute("INSERT INTO artifacts (id,project_id,type,format,path,size_bytes,generated_by,can_delete,can_regenerate,metadata_json,created_at) VALUES (?1,?2,?3,'wav',?4,300,'demucs',1,1,?5,?6)",params![id,fixture.project,kind,path.to_string_lossy(),metadata.to_string(),now_iso()]).unwrap();
        };
        insert("practice", "preview_mix", json!({}));
        insert(
            "unrelated-parent",
            "preview_mix",
            json!({"parent_artifact_id":drums}),
        );
        insert(
            "wrong-parent-child",
            "kick_drum_substem",
            json!({"parent_artifact_id":"source"}),
        );
        insert(
            "other-source-stem",
            "vocal_stem",
            json!({"source_artifact_id":"practice","stem_model":MODEL,"parent_artifact_id":drums}),
        );
        insert(
            "obsolete-model",
            "instrumental_stem",
            json!({"source_artifact_id":"source","stem_model":"htdemucs_ft"}),
        );
        insert(
            "drum-child",
            "kick_drum_substem",
            json!({"parent_artifact_id":drums}),
        );
        fixture.connection.execute("UPDATE artifacts SET metadata_json=json_set(metadata_json,'$.drum_substems',1,'$.user_label','Dry drums') WHERE id=?1",params![drums]).unwrap();
        insert("vocal-child", "lead_vocal_substem", json!({"parent_artifact_id":vocals}));
        insert("other-vocal-child", "backing_vocal_substem", json!({"parent_artifact_id":"other-source-stem"}));
        fixture.connection.execute("UPDATE artifacts SET metadata_json=json_set(metadata_json,'$.vocal_substems',1) WHERE id=?1",params![vocals]).unwrap();
        let practice = fixture
            .connection
            .query_row(
                &format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id='practice'"),
                [],
                row_artifact,
            )
            .unwrap();
        let practice_snapshot =
            stem_snapshot(&fixture.connection, &fixture.project, &practice).unwrap();
        assert!(!practice_snapshot.contains("obsolete-model"));
        let prior = stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap();
        fixture
            .publish(&fixture.job(), &fixture.stage(), &prior, &hash)
            .unwrap();
        let current: Value = serde_json::from_str(
            &stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap(),
        )
        .unwrap();
        let current_ids: HashSet<String> = current
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row[0].as_str().unwrap().into())
            .collect();
        assert_eq!(initial_ids, current_ids);
        assert_eq!(
            stem_snapshot(&fixture.connection, &fixture.project, &practice).unwrap(),
            practice_snapshot
        );
        let tombstones: Vec<String> = fixture
            .connection
            .prepare("SELECT target_id FROM sync_delete_tombstones ORDER BY target_id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(tombstones, vec!["drum-child", "obsolete-model", "vocal-child"]);
        assert!(current.as_array().unwrap().iter().find(|row| row[1] == "vocal_stem").unwrap()[4]
            .as_str().is_some_and(|metadata| !metadata.contains("vocal_substems")));
        let drums_metadata: String = fixture
            .connection
            .query_row(
                "SELECT metadata_json FROM artifacts WHERE id=?1",
                params![drums],
                |row| row.get(0),
            )
            .unwrap();
        let drums_metadata: Value = serde_json::from_str(&drums_metadata).unwrap();
        assert!(drums_metadata.get("drum_substems").is_none());
        assert_eq!(drums_metadata["user_label"], "Dry drums");
        for id in ["unrelated-parent", "wrong-parent-child"] {
            let exists: i64 = fixture
                .connection
                .query_row(
                    "SELECT count(*) FROM artifacts WHERE id=?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1);
        }
    }

    #[test]
    fn malformed_existing_stem_metadata_fails_closed_without_removing_rows() {
        let fixture = Fixture::new();
        let hash = file_sha256(Path::new(&fixture.source.path)).unwrap();
        fixture
            .publish(&fixture.job(), &fixture.stage(), "[]", &hash)
            .unwrap();
        let previous =
            stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap();
        fixture
            .connection
            .execute(
                "UPDATE artifacts SET metadata_json='broken' WHERE type='drums_stem'",
                [],
            )
            .unwrap();
        assert!(
            stem_snapshot(&fixture.connection, &fixture.project, &fixture.source)
                .unwrap_err()
                .contains("preserved")
        );
        assert!(fixture
            .publish(&fixture.job(), &fixture.stage(), &previous, &hash)
            .unwrap_err()
            .contains("preserved"));
        assert_eq!(fixture.artifact_count(), 6);
    }

    #[test]
    fn first_database_open_interrupts_stems_cleans_staging_and_allows_retry() {
        let root = std::env::temp_dir().join(format!(
            "tuneforge-stem-restart-{}",
            new_artifact_id().unwrap()
        ));
        let project = format!("proj_sha256_{}", "4".repeat(64));
        let project_root = root.join("projects").join(&project);
        fs::create_dir_all(&project_root).unwrap();
        let source_path = project_root.join("source.wav");
        stereo_wav(&source_path, 64);
        let connection = Connection::open(root.join("mobile.sqlite3")).unwrap();
        migrate_mobile_db(&connection).unwrap();
        connection.execute("INSERT INTO projects (id,display_name,source_path,imported_path,sync_status,created_at,updated_at) VALUES (?1,'Synthetic',?2,?2,'local',?3,?3)",params![project,source_path.to_string_lossy(),now_iso()]).unwrap();
        connection.execute("INSERT INTO artifacts (id,project_id,type,format,path,size_bytes,generated_by,can_delete,can_regenerate,metadata_json,created_at) VALUES ('source',?1,'source_audio','wav',?2,300,'import',0,0,'{}',?3)",params![project,source_path.to_string_lossy(),now_iso()]).unwrap();
        let job =
            create_pending_processing_job(&connection, &project, "stems", Some("source".into()))
                .unwrap();
        let directory = project_root.join("stems/.interrupted");
        let paths = staging_paths(&directory, "flac");
        for path in &paths {
            prepare_owned_project_file(&root, &project_root, path).unwrap();
            fs::write(path, b"interrupted").unwrap();
        }
        connection
            .execute(
                "UPDATE jobs SET payload_json=?1 WHERE id=?2",
                params![json!({"staging_paths":paths}).to_string(), job.id],
            )
            .unwrap();
        drop(connection);
        let reopened = db_at_root(&root).unwrap();
        let status: String = reopened
            .query_row(
                "SELECT status FROM jobs WHERE id=?1",
                params![job.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert!(paths.iter().all(|path| !path.exists()));
        assert!(source_path.exists());
        let retry =
            create_pending_processing_job(&reopened, &project, "stems", Some("source".into()))
                .unwrap();
        assert_eq!(retry.status, "pending");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn saved_stem_edit_during_job_is_preserved() {
        let fixture = Fixture::new();
        let first = fixture.job();
        let hash = file_sha256(Path::new(&fixture.source.path)).unwrap();
        fixture
            .publish(&first, &fixture.stage(), "[]", &hash)
            .unwrap();
        let previous =
            stem_snapshot(&fixture.connection, &fixture.project, &fixture.source).unwrap();
        let job = fixture.job();
        fixture
            .connection
            .execute(
                "UPDATE artifacts SET metadata_json='{\"user_edit\":true}' WHERE type='drums_stem'",
                [],
            )
            .unwrap();
        assert!(fixture
            .publish(&job, &fixture.stage(), &previous, &hash)
            .unwrap_err()
            .contains("Newer stems were preserved"));
        assert_eq!(fixture.artifact_count(), 6);
    }
}
