#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::{fs, path::Path};

use super::android_media;

#[derive(Clone)]
pub struct DecodedAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u32,
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

    let mut samples = Vec::with_capacity(frame_count);
    for frame_index in 0..frame_count {
        let frame_start = data_start + frame_index * block_align as usize;
        let mut sum = 0.0;
        for channel_index in 0..channels as usize {
            let sample_offset = frame_start + channel_index * bytes_per_sample;
            sum += decode_wav_sample(&bytes, sample_offset, audio_format, bits_per_sample)?;
        }
        samples.push((sum / channels as f64).clamp(-1.0, 1.0) as f32);
    }

    Ok(DecodedAudio {
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

fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn decode_wav_sample(
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
}
