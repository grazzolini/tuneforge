#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::{fs, path::Path};

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
use std::{fs::File, io::Read};
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
use symphonia::core::{
    codecs::audio::{
        well_known::{
            profiles::CODEC_PROFILE_AAC_LC, CODEC_ID_AAC, CODEC_ID_FLAC, CODEC_ID_MP3,
            CODEC_ID_PCM_S16LE,
        },
        AudioDecoderOptions,
    },
    errors::Error as SymphoniaError,
    formats::{probe::Hint, FormatOptions, TrackType},
    io::MediaSourceStream,
    meta::MetadataOptions,
};

use super::android_media;

#[derive(Clone)]
pub struct DecodedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u32,
}

#[derive(Clone)]
pub struct DecodedInterleavedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u32,
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
const DURABLE_PROBE_PACKET_LIMIT: usize = 32;
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
const DURABLE_PROBE_PACKET_BYTES: usize = 4 * 1024 * 1024;
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
const DURABLE_PROBE_HEADER_BYTES: usize = 64;

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn durable_container_matches(format: &str, header: &[u8]) -> bool {
    match format {
        "wav" => header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WAVE"),
        "flac" => header.starts_with(b"fLaC"),
        "mp3" => {
            header.starts_with(b"ID3")
                || header
                    .windows(2)
                    .take(16)
                    .any(|bytes| bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
        }
        "m4a" => header.get(4..8) == Some(b"ftyp"),
        _ => false,
    }
}

pub fn probe_mobile_durable_audio(path: &Path, expected_format: &str) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    {
        let expected_format = expected_format.trim().to_ascii_lowercase();
        let expected_suffix = format!(".{expected_format}");
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.to_ascii_lowercase().ends_with(&expected_suffix))
        {
            return Err(format!(
                "Durable audio format {expected_format} requires a matching {expected_suffix} path."
            ));
        }

        let mut header_file = File::open(path)
            .map_err(|error| format!("Could not open durable audio for validation: {error}"))?;
        let mut header = [0_u8; DURABLE_PROBE_HEADER_BYTES];
        let header_len = header_file
            .read(&mut header)
            .map_err(|error| format!("Could not read durable audio for validation: {error}"))?;
        if !durable_container_matches(&expected_format, &header[..header_len]) {
            return Err(format!(
                "Durable audio does not match the declared {expected_format} container."
            ));
        }

        let file = File::open(path)
            .map_err(|error| format!("Could not open durable audio for validation: {error}"))?;
        let media_source = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        hint.with_extension(&expected_format);
        let mut reader = symphonia::default::get_probe()
            .probe(
                &hint,
                media_source,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .map_err(|error| format!("Durable audio container could not be read: {error}"))?;
        let (track_id, codec_params) = {
            let track = reader.default_track(TrackType::Audio).ok_or_else(|| {
                "Durable audio container does not contain an audio track.".to_string()
            })?;
            let codec_params = track
                .codec_params
                .as_ref()
                .and_then(|params| params.audio())
                .cloned()
                .ok_or_else(|| "Durable audio track is not decodable.".to_string())?;
            (track.id, codec_params)
        };
        let codec_matches = match expected_format.as_str() {
            "wav" => {
                codec_params.codec == CODEC_ID_PCM_S16LE && codec_params.bits_per_sample == Some(16)
            }
            "flac" => codec_params.codec == CODEC_ID_FLAC,
            "mp3" => codec_params.codec == CODEC_ID_MP3,
            "m4a" => {
                codec_params.codec == CODEC_ID_AAC
                    && codec_params.profile == Some(CODEC_PROFILE_AAC_LC)
            }
            _ => false,
        };
        if !codec_matches {
            return Err(format!(
                "Durable audio codec does not match the declared {expected_format} format."
            ));
        }

        let mut decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
            .map_err(|error| format!("Durable audio codec is unavailable: {error}"))?;
        for _ in 0..DURABLE_PROBE_PACKET_LIMIT {
            let packet = match reader.next_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => break,
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(error) => {
                    return Err(format!("Durable audio packet could not be read: {error}"));
                }
            };
            if packet.track_id != track_id {
                continue;
            }
            if packet.data.len() > DURABLE_PROBE_PACKET_BYTES {
                return Err("Durable audio probe packet exceeds the validation bound.".to_string());
            }
            match decoder.decode(&packet) {
                Ok(decoded) if decoded.samples_interleaved() > 0 => return Ok(()),
                Ok(_) | Err(SymphoniaError::DecodeError(_)) => continue,
                Err(error) => {
                    return Err(format!(
                        "Durable audio packet could not be decoded: {error}"
                    ));
                }
            }
        }
        return Err(
            "Durable audio did not yield readable audio within the probe bound.".to_string(),
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "linux", target_os = "macos")))]
    {
        let _ = (path, expected_format);
        Err("Durable audio probing is unavailable on this platform.".to_string())
    }
}

pub fn read_mobile_audio(path: &Path) -> Result<DecodedAudio, String> {
    match read_wav_audio(path) {
        Ok(audio) => Ok(audio),
        Err(wav_error) => android_media::read_android_media_audio(path).map_err(|media_error| {
            format!(
                "Mobile audio decode supports PCM WAV files and formats Android MediaCodec can decode. WAV decode failed: {wav_error}. Android MediaCodec decode failed: {media_error}"
            )
        }),
    }
}

pub fn read_resampled_mono_audio(
    path: &Path,
    target_sample_rate: u32,
) -> Result<DecodedAudio, String> {
    let decoded = read_mobile_audio(path)?;
    Ok(DecodedAudio {
        samples: resample_mono(&decoded.samples, decoded.sample_rate, target_sample_rate),
        sample_rate: target_sample_rate,
        channels: 1,
    })
}

pub fn write_mono_pcm_wav(path: &Path, audio: &DecodedAudio) -> Result<(), String> {
    if audio.sample_rate == 0 {
        return Err("Decoded audio contained invalid stream metadata.".to_string());
    }
    let data_bytes = audio
        .samples
        .len()
        .checked_mul(2)
        .ok_or_else(|| "Decoded audio is too large for a playback proxy.".to_string())?;
    let riff_size = 36usize
        .checked_add(data_bytes)
        .ok_or_else(|| "Decoded audio is too large for a playback proxy.".to_string())?;
    let data_bytes = u32::try_from(data_bytes)
        .map_err(|_| "Decoded audio is too large for a playback proxy.".to_string())?;
    let riff_size = u32::try_from(riff_size)
        .map_err(|_| "Decoded audio is too large for a playback proxy.".to_string())?;
    let byte_rate = audio
        .sample_rate
        .checked_mul(2)
        .ok_or_else(|| "Decoded audio sample rate is invalid.".to_string())?;

    let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&riff_size.to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&audio.sample_rate.to_le_bytes());
    bytes.extend_from_slice(&byte_rate.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for sample in &audio.samples {
        let scaled = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        bytes.extend_from_slice(&scaled.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|error| error.to_string())
}

pub fn read_wav_audio(path: &Path) -> Result<DecodedAudio, String> {
    let decoded = read_wav_audio_interleaved(path)?;
    let channels =
        usize::try_from(decoded.channels).map_err(|_| "Invalid WAV channel count.".to_string())?;
    let mut samples = Vec::with_capacity(decoded.samples.len() / channels);
    for frame in decoded.samples.chunks_exact(channels) {
        let sum = frame.iter().map(|sample| f64::from(*sample)).sum::<f64>();
        samples.push((sum / decoded.channels as f64).clamp(-1.0, 1.0) as f32);
    }

    Ok(DecodedAudio {
        samples,
        sample_rate: decoded.sample_rate,
        channels: decoded.channels,
    })
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod durable_probe_tests {
    use super::*;
    use std::{path::PathBuf, process::Command};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(slug: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "tuneforge-durable-probe-{slug}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_synthetic_wav(path: &Path) {
        let audio = DecodedAudio {
            samples: (0..800)
                .map(|index| ((index as f32 * 0.15).sin() * 0.2).clamp(-1.0, 1.0))
                .collect(),
            sample_rate: 8_000,
            channels: 1,
        };
        write_mono_pcm_wav(path, &audio).unwrap();
    }

    fn encode_fixture(source: &Path, destination: &Path, format: &str) {
        let mut command = Command::new("ffmpeg");
        command.args(["-hide_banner", "-loglevel", "error", "-y", "-i"]);
        command.arg(source);
        match format {
            "flac" => command.args(["-c:a", "flac", "-compression_level", "5"]),
            "mp3" => command.args(["-c:a", "libmp3lame", "-b:a", "192k"]),
            "m4a" => command.args(["-c:a", "aac", "-profile:a", "aac_low", "-b:a", "192k"]),
            _ => panic!("unsupported test format"),
        };
        let status = command.arg(destination).status().unwrap();
        assert!(status.success());
    }

    #[test]
    fn bounded_probe_accepts_exact_four_format_contract() {
        let directory = TestDirectory::new("valid");
        let wav = directory.0.join("fixture.wav");
        write_synthetic_wav(&wav);
        probe_mobile_durable_audio(&wav, "wav").unwrap();

        for format in ["flac", "mp3", "m4a"] {
            let path = directory.0.join(format!("fixture.{format}"));
            encode_fixture(&wav, &path, format);
            probe_mobile_durable_audio(&path, format).unwrap();
        }
    }

    #[test]
    fn bounded_probe_rejects_mismatch_and_corrupt_media() {
        let directory = TestDirectory::new("invalid");
        let wav = directory.0.join("fixture.wav");
        write_synthetic_wav(&wav);
        let mp3 = directory.0.join("fixture.mp3");
        encode_fixture(&wav, &mp3, "mp3");
        let mismatched = directory.0.join("mismatch.flac");
        fs::copy(&mp3, &mismatched).unwrap();
        assert!(probe_mobile_durable_audio(&mismatched, "flac")
            .unwrap_err()
            .contains("container"));

        let corrupt = directory.0.join("corrupt.m4a");
        fs::write(&corrupt, b"\0\0\0\x18ftypM4A \0\0\0\0corrupt").unwrap();
        assert!(probe_mobile_durable_audio(&corrupt, "m4a").is_err());
    }
}

pub fn read_wav_audio_interleaved(path: &Path) -> Result<DecodedInterleavedAudio, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("Not a PCM WAV file.".to_string());
    }

    let mut audio_format = 0u16;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut block_align = 0u16;
    let mut bits_per_sample = 0u16;
    let mut data_range: Option<(usize, usize)> = None;
    let mut offset = 12usize;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = read_u32_le(&bytes, offset + 4)
            .ok_or_else(|| "Invalid WAV chunk header.".to_string())?
            as usize;
        let chunk_start = offset + 8;
        let chunk_end = chunk_start.saturating_add(chunk_size);
        if chunk_end > bytes.len() {
            return Err("Invalid WAV chunk size.".to_string());
        }
        if chunk_id == b"fmt " {
            if chunk_size < 16 {
                return Err("Invalid WAV fmt chunk.".to_string());
            }
            audio_format = read_u16_le(&bytes, chunk_start)
                .ok_or_else(|| "Invalid WAV audio format.".to_string())?;
            channels = read_u16_le(&bytes, chunk_start + 2)
                .ok_or_else(|| "Invalid WAV channel count.".to_string())?;
            sample_rate = read_u32_le(&bytes, chunk_start + 4)
                .ok_or_else(|| "Invalid WAV sample rate.".to_string())?;
            block_align = read_u16_le(&bytes, chunk_start + 12)
                .ok_or_else(|| "Invalid WAV block alignment.".to_string())?;
            bits_per_sample = read_u16_le(&bytes, chunk_start + 14)
                .ok_or_else(|| "Invalid WAV bit depth.".to_string())?;
        } else if chunk_id == b"data" {
            data_range = Some((chunk_start, chunk_end));
        }
        offset = chunk_end + (chunk_size % 2);
    }

    if audio_format != 1 && audio_format != 3 {
        return Err("WAV decode supports PCM and 32-bit float WAV files.".to_string());
    }
    if channels == 0 || sample_rate == 0 || block_align == 0 || bits_per_sample == 0 {
        return Err("Invalid WAV stream metadata.".to_string());
    }
    let (data_start, data_end) =
        data_range.ok_or_else(|| "WAV data chunk is missing.".to_string())?;
    let frame_count = (data_end - data_start) / block_align as usize;
    let bytes_per_sample = (bits_per_sample / 8) as usize;
    if bytes_per_sample == 0 {
        return Err("Invalid WAV bit depth.".to_string());
    }

    let channels_usize = channels as usize;
    let mut samples = Vec::with_capacity(frame_count * channels_usize);
    for frame_index in 0..frame_count {
        let frame_start = data_start + frame_index * block_align as usize;
        for channel_index in 0..channels_usize {
            let sample_offset = frame_start + channel_index * bytes_per_sample;
            samples.push(
                decode_wav_sample(&bytes, sample_offset, audio_format, bits_per_sample)?
                    .clamp(-1.0, 1.0) as f32,
            );
        }
    }

    Ok(DecodedInterleavedAudio {
        samples,
        sample_rate,
        channels: channels as u32,
    })
}

pub fn resample_mono(
    samples: &[f32],
    source_sample_rate: u32,
    target_sample_rate: u32,
) -> Vec<f32> {
    if samples.is_empty() || source_sample_rate == 0 || source_sample_rate == target_sample_rate {
        return samples.to_vec();
    }

    let output_len = ((samples.len() as f64) * target_sample_rate as f64
        / source_sample_rate as f64)
        .ceil()
        .max(1.0) as usize;
    let ratio = source_sample_rate as f64 / target_sample_rate as f64;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let source_position = index as f64 * ratio;
        let left_index = source_position.floor() as usize;
        let right_index = (left_index + 1).min(samples.len().saturating_sub(1));
        let fraction = (source_position - left_index as f64) as f32;
        let left = samples[left_index];
        let right = samples[right_index];
        output.push(left + (right - left) * fraction);
    }
    output
}

pub fn resample_interleaved(
    samples: &[f32],
    channels: u32,
    source_sample_rate: u32,
    target_sample_rate: u32,
) -> Vec<f32> {
    let channel_count = channels as usize;
    if samples.is_empty()
        || channel_count == 0
        || source_sample_rate == 0
        || source_sample_rate == target_sample_rate
    {
        return samples.to_vec();
    }

    let input_frames = samples.len() / channel_count;
    if input_frames == 0 {
        return Vec::new();
    }

    let output_frames = ((input_frames as f64) * target_sample_rate as f64
        / source_sample_rate as f64)
        .ceil()
        .max(1.0) as usize;
    let ratio = source_sample_rate as f64 / target_sample_rate as f64;
    let mut output = Vec::with_capacity(output_frames * channel_count);
    for output_frame in 0..output_frames {
        let source_position = output_frame as f64 * ratio;
        let left_frame = source_position.floor() as usize;
        let right_frame = (left_frame + 1).min(input_frames.saturating_sub(1));
        let fraction = (source_position - left_frame as f64) as f32;
        for channel in 0..channel_count {
            let left = samples[left_frame * channel_count + channel];
            let right = samples[right_frame * channel_count + channel];
            output.push(left + (right - left) * fraction);
        }
    }
    output
}

pub fn convert_interleaved_channels(
    samples: &[f32],
    source_channels: u32,
    target_channels: u32,
) -> Vec<f32> {
    let source_count = source_channels as usize;
    let target_count = target_channels as usize;
    if samples.is_empty() || source_count == 0 || target_count == 0 {
        return Vec::new();
    }
    if source_count == target_count {
        return samples.to_vec();
    }

    let frames = samples.len() / source_count;
    let mut output = Vec::with_capacity(frames * target_count);
    for frame in samples.chunks_exact(source_count) {
        if target_count == 1 {
            let sum = frame.iter().map(|sample| f64::from(*sample)).sum::<f64>();
            output.push((sum / source_count as f64).clamp(-1.0, 1.0) as f32);
            continue;
        }

        for channel in 0..target_count {
            let source_channel = if source_count == 1 {
                0
            } else {
                channel.min(source_count - 1)
            };
            output.push(frame[source_channel]);
        }
    }
    output
}

pub(crate) fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

pub(crate) fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

pub(crate) fn decode_wav_sample(
    bytes: &[u8],
    offset: usize,
    audio_format: u16,
    bits_per_sample: u16,
) -> Result<f64, String> {
    match (audio_format, bits_per_sample) {
        (1, 8) => Ok((bytes
            .get(offset)
            .copied()
            .ok_or_else(|| "Invalid WAV sample data.".to_string())? as f64
            - 128.0)
            / 128.0),
        (1, 16) => {
            let raw = i16::from_le_bytes(
                bytes
                    .get(offset..offset + 2)
                    .ok_or_else(|| "Invalid WAV sample data.".to_string())?
                    .try_into()
                    .map_err(|_| "Invalid WAV sample data.".to_string())?,
            );
            Ok(raw as f64 / i16::MAX as f64)
        }
        (1, 24) => {
            let sample = bytes
                .get(offset..offset + 3)
                .ok_or_else(|| "Invalid WAV sample data.".to_string())?;
            let raw = (sample[0] as i32) | ((sample[1] as i32) << 8) | ((sample[2] as i32) << 16);
            let signed = if raw & 0x800000 != 0 {
                raw | !0x00ff_ffff
            } else {
                raw
            };
            Ok(signed as f64 / 8_388_608.0)
        }
        (1, 32) => {
            let raw = i32::from_le_bytes(
                bytes
                    .get(offset..offset + 4)
                    .ok_or_else(|| "Invalid WAV sample data.".to_string())?
                    .try_into()
                    .map_err(|_| "Invalid WAV sample data.".to_string())?,
            );
            Ok(raw as f64 / i32::MAX as f64)
        }
        (3, 32) => {
            let raw = f32::from_le_bytes(
                bytes
                    .get(offset..offset + 4)
                    .ok_or_else(|| "Invalid WAV sample data.".to_string())?
                    .try_into()
                    .map_err(|_| "Invalid WAV sample data.".to_string())?,
            );
            Ok(raw as f64)
        }
        _ => Err("WAV decode supports 8/16/24/32-bit PCM WAV files.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_returns_original_when_sample_rates_match() {
        let samples = vec![0.0, 0.5, -0.5];

        assert_eq!(resample_mono(&samples, 44_100, 44_100), samples);
    }

    #[test]
    fn write_and_read_mono_pcm_wav_round_trips_metadata() {
        let path = std::env::temp_dir().join(format!(
            "tuneforge-audio-decode-test-{}.wav",
            std::process::id()
        ));
        let audio = DecodedAudio {
            samples: vec![0.0, 0.25, -0.25],
            sample_rate: 48_000,
            channels: 1,
        };

        write_mono_pcm_wav(&path, &audio).expect("write wav");
        let decoded = read_wav_audio(&path).expect("read wav");
        let _ = fs::remove_file(&path);

        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.channels, 1);
        assert_eq!(decoded.samples.len(), 3);
    }

    #[test]
    fn read_wav_audio_interleaved_preserves_stereo_channels() {
        let path = std::env::temp_dir().join(format!(
            "tuneforge-audio-stereo-decode-test-{}.wav",
            std::process::id()
        ));
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&44u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&48_000u32.to_le_bytes());
        bytes.extend_from_slice(&192_000u32.to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&8u32.to_le_bytes());
        for sample in [i16::MAX, i16::MIN, 0, i16::MAX / 2] {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(&path, bytes).expect("write wav");

        let decoded = read_wav_audio_interleaved(&path).expect("read wav");
        let _ = fs::remove_file(&path);

        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.samples.len(), 4);
        assert!(decoded.samples[0] > 0.99);
        assert!(decoded.samples[1] < -0.99);
    }

    #[test]
    fn convert_interleaved_channels_duplicates_mono_to_stereo() {
        let converted = convert_interleaved_channels(&[0.25, -0.5], 1, 2);

        assert_eq!(converted, vec![0.25, 0.25, -0.5, -0.5]);
    }
}
