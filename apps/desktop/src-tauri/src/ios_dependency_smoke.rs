use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, Sample, SampleFormat, SizedSample,
};
use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::native_audio::decode::{probe_mobile_durable_audio, write_mono_pcm_wav, DecodedAudio};

pub fn run(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    smoke_sqlite()?;
    smoke_decode(app)?;
    smoke_signalsmith();
    smoke_output()?;
    eprintln!("TuneForge iOS dependency smoke passed.");
    Ok(())
}

fn smoke_sqlite() -> Result<(), String> {
    let connection = Connection::open_in_memory().map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "CREATE TABLE dependency_gate (value INTEGER NOT NULL);\
             INSERT INTO dependency_gate (value) VALUES (1);",
        )
        .map_err(|error| error.to_string())?;
    let value: i64 = connection
        .query_row("SELECT value FROM dependency_gate", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    (value == 1)
        .then_some(())
        .ok_or_else(|| "SQLite dependency smoke returned unexpected data.".to_string())
}

fn smoke_decode(app: &AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = root.join("ios-dependency-smoke.wav");
    let audio = DecodedAudio {
        samples: vec![0.0; 512],
        sample_rate: 48_000,
        channels: 1,
    };
    write_mono_pcm_wav(&path, &audio)?;
    let result = probe_mobile_durable_audio(&path, "wav");
    let _ = fs::remove_file(path);
    result
}

fn smoke_signalsmith() {
    let mut stretch = signalsmith_stretch::Stretch::preset_default(1, 48_000);
    let input = [0.0_f32; 512];
    let mut output = [0.0_f32; 512];
    stretch.process(input, &mut output);
}

fn smoke_output() -> Result<(), String> {
    let _audio_session = crate::native_audio::ios_session::PlaybackAudioSession::activate()?;
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "iOS dependency smoke found no output device.".to_string())?;
    let supported = device
        .default_output_config()
        .map_err(|error| format!("iOS dependency smoke could not read output config: {error}"))?;
    let sample_format = supported.sample_format();
    let config = supported.into();
    let callback_seen = Arc::new(AtomicBool::new(false));
    let stream_error = Arc::new(Mutex::new(None));
    let stream = match sample_format {
        SampleFormat::F32 => build_silent_stream::<f32>(
            &device,
            &config,
            callback_seen.clone(),
            stream_error.clone(),
        ),
        SampleFormat::I16 => build_silent_stream::<i16>(
            &device,
            &config,
            callback_seen.clone(),
            stream_error.clone(),
        ),
        SampleFormat::U16 => build_silent_stream::<u16>(
            &device,
            &config,
            callback_seen.clone(),
            stream_error.clone(),
        ),
        other => Err(format!(
            "iOS dependency smoke found unsupported output format {other:?}."
        )),
    }?;
    stream
        .play()
        .map_err(|error| format!("iOS dependency smoke could not start output: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    while !callback_seen.load(Ordering::Acquire) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    if let Some(error) = stream_error
        .lock()
        .map_err(|_| "iOS dependency smoke output error lock failed.".to_string())?
        .take()
    {
        return Err(error);
    }
    callback_seen
        .load(Ordering::Acquire)
        .then_some(())
        .ok_or_else(|| "iOS dependency smoke output callback timed out.".to_string())
}

fn build_silent_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    callback_seen: Arc<AtomicBool>,
    stream_error: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String>
where
    T: Sample + SizedSample + FromSample<f32>,
{
    device
        .build_output_stream(
            *config,
            move |output: &mut [T], _| {
                let silent = T::from_sample(0.0);
                output.fill(silent);
                callback_seen.store(true, Ordering::Release);
            },
            move |error| {
                if let Ok(mut slot) = stream_error.lock() {
                    *slot = Some(format!("iOS dependency smoke output failed: {error}"));
                }
            },
            None,
        )
        .map_err(|error| format!("iOS dependency smoke could not build output: {error}"))
}
