use std::path::Path;

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use crate::native_audio::decode::read_mobile_audio_interleaved;
    use std::{
        ffi::CStr,
        fs::{self, File},
        mem,
        os::fd::AsRawFd,
        ptr, slice,
    };

    const AAC_MIME: &[u8] = b"audio/mp4a-latm\0";
    const AAC_LC_PROFILE: i32 = 2;
    const BIT_RATE: i32 = 192_000;
    const TIMEOUT_US: i64 = 10_000;
    const MAX_IDLE_ITERATIONS: usize = 2_000;

    struct Format(*mut ndk_sys::AMediaFormat);

    impl Format {
        fn aac(sample_rate: i32, channels: i32) -> Result<Self, String> {
            let ptr = unsafe { ndk_sys::AMediaFormat_new() };
            if ptr.is_null() {
                return Err("Android MediaFormat could not be created.".to_string());
            }
            unsafe {
                ndk_sys::AMediaFormat_setString(
                    ptr,
                    ndk_sys::AMEDIAFORMAT_KEY_MIME,
                    AAC_MIME.as_ptr().cast(),
                );
                ndk_sys::AMediaFormat_setInt32(
                    ptr,
                    ndk_sys::AMEDIAFORMAT_KEY_SAMPLE_RATE,
                    sample_rate,
                );
                ndk_sys::AMediaFormat_setInt32(
                    ptr,
                    ndk_sys::AMEDIAFORMAT_KEY_CHANNEL_COUNT,
                    channels,
                );
                ndk_sys::AMediaFormat_setInt32(ptr, ndk_sys::AMEDIAFORMAT_KEY_BIT_RATE, BIT_RATE);
                ndk_sys::AMediaFormat_setInt32(
                    ptr,
                    ndk_sys::AMEDIAFORMAT_KEY_AAC_PROFILE,
                    AAC_LC_PROFILE,
                );
                ndk_sys::AMediaFormat_setInt32(
                    ptr,
                    ndk_sys::AMEDIAFORMAT_KEY_MAX_INPUT_SIZE,
                    16_384,
                );
            }
            Ok(Self(ptr))
        }
    }

    impl Drop for Format {
        fn drop(&mut self) {
            unsafe {
                let _ = ndk_sys::AMediaFormat_delete(self.0);
            }
        }
    }

    struct Encoder {
        ptr: *mut ndk_sys::AMediaCodec,
        started: bool,
    }

    impl Encoder {
        fn new(format: &Format) -> Result<Self, String> {
            let ptr = unsafe { ndk_sys::AMediaCodec_createEncoderByType(AAC_MIME.as_ptr().cast()) };
            if ptr.is_null() {
                return Err("This Android device has no AAC encoder.".to_string());
            }
            let status = unsafe {
                ndk_sys::AMediaCodec_configure(
                    ptr,
                    format.0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ndk_sys::AMEDIACODEC_CONFIGURE_FLAG_ENCODE as u32,
                )
            };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                unsafe {
                    let _ = ndk_sys::AMediaCodec_delete(ptr);
                }
                return Err("Android AAC encoder configuration failed.".to_string());
            }
            let status = unsafe { ndk_sys::AMediaCodec_start(ptr) };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                unsafe {
                    let _ = ndk_sys::AMediaCodec_delete(ptr);
                }
                return Err("Android AAC encoder could not start.".to_string());
            }
            Ok(Self { ptr, started: true })
        }
    }

    impl Drop for Encoder {
        fn drop(&mut self) {
            unsafe {
                if self.started {
                    let _ = ndk_sys::AMediaCodec_stop(self.ptr);
                }
                let _ = ndk_sys::AMediaCodec_delete(self.ptr);
            }
        }
    }

    struct Muxer {
        ptr: *mut ndk_sys::AMediaMuxer,
        started: bool,
    }

    impl Muxer {
        fn new(file: &File) -> Result<Self, String> {
            let ptr = unsafe {
                ndk_sys::AMediaMuxer_new(
                    file.as_raw_fd(),
                    ndk_sys::OutputFormat::AMEDIAMUXER_OUTPUT_FORMAT_MPEG_4,
                )
            };
            if ptr.is_null() {
                return Err("Android M4A muxer could not be created.".to_string());
            }
            Ok(Self {
                ptr,
                started: false,
            })
        }

        fn add_track_and_start(
            &mut self,
            format: *mut ndk_sys::AMediaFormat,
        ) -> Result<usize, String> {
            let track = unsafe { ndk_sys::AMediaMuxer_addTrack(self.ptr, format) };
            if track < 0 {
                return Err("Android M4A muxer rejected the AAC track.".to_string());
            }
            let status = unsafe { ndk_sys::AMediaMuxer_start(self.ptr) };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                return Err("Android M4A muxer could not start.".to_string());
            }
            self.started = true;
            Ok(track as usize)
        }
    }

    impl Drop for Muxer {
        fn drop(&mut self) {
            unsafe {
                if self.started {
                    let _ = ndk_sys::AMediaMuxer_stop(self.ptr);
                }
                let _ = ndk_sys::AMediaMuxer_delete(self.ptr);
            }
        }
    }

    struct Extractor(*mut ndk_sys::AMediaExtractor);

    impl Extractor {
        fn open(path: &Path) -> Result<Self, String> {
            let file = File::open(path)
                .map_err(|_| "Could not read Android export staging.".to_string())?;
            let length = i64::try_from(
                file.metadata()
                    .map_err(|_| "Could not inspect Android export staging.".to_string())?
                    .len(),
            )
            .map_err(|_| "Android export staging is too large to validate.".to_string())?;
            let ptr = unsafe { ndk_sys::AMediaExtractor_new() };
            if ptr.is_null() {
                return Err("Android media validator could not be created.".to_string());
            }
            let extractor = Self(ptr);
            let status = unsafe {
                ndk_sys::AMediaExtractor_setDataSourceFd(extractor.0, file.as_raw_fd(), 0, length)
            };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                return Err("Android export did not produce a readable M4A file.".to_string());
            }
            Ok(extractor)
        }

        fn contains_aac_track(&self) -> bool {
            let track_count = unsafe { ndk_sys::AMediaExtractor_getTrackCount(self.0) };
            (0..track_count).any(|index| {
                let format = unsafe { ndk_sys::AMediaExtractor_getTrackFormat(self.0, index) };
                if format.is_null() {
                    return false;
                }
                let mut mime = ptr::null();
                let found = unsafe {
                    ndk_sys::AMediaFormat_getString(
                        format,
                        ndk_sys::AMEDIAFORMAT_KEY_MIME,
                        &mut mime,
                    )
                };
                let is_aac = found
                    && !mime.is_null()
                    && unsafe { CStr::from_ptr(mime) }.to_bytes()
                        == &AAC_MIME[..AAC_MIME.len() - 1];
                unsafe {
                    let _ = ndk_sys::AMediaFormat_delete(format);
                }
                is_aac
            })
        }
    }

    impl Drop for Extractor {
        fn drop(&mut self) {
            unsafe {
                let _ = ndk_sys::AMediaExtractor_delete(self.0);
            }
        }
    }

    pub(super) fn encode(
        source: &Path,
        destination: &Path,
        should_cancel: &dyn Fn() -> bool,
        on_progress: &dyn Fn(i64),
    ) -> Result<(), String> {
        if should_cancel() {
            return Err("Export cancelled.".to_string());
        }
        let audio = read_mobile_audio_interleaved(source)?;
        if audio.samples.is_empty() || audio.sample_rate == 0 {
            return Err("Selected audio contains no encodable samples.".to_string());
        }
        if !matches!(audio.channels, 1 | 2) {
            return Err("Android M4A export supports mono or stereo audio.".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| "Could not prepare Android export staging.".to_string())?;
        }
        let output = File::create(destination)
            .map_err(|_| "Could not create Android export staging file.".to_string())?;
        let sample_rate = i32::try_from(audio.sample_rate)
            .map_err(|_| "Selected audio sample rate is unsupported.".to_string())?;
        let channel_count = i32::try_from(audio.channels)
            .map_err(|_| "Selected audio channel count is unsupported.".to_string())?;
        let format = Format::aac(sample_rate, channel_count)?;
        let encoder = Encoder::new(&format)?;
        let mut muxer = Muxer::new(&output)?;
        let mut input_sample = 0usize;
        let mut input_eos = false;
        let mut output_eos = false;
        let mut track_index = None;
        let mut idle_iterations = 0usize;

        while !output_eos {
            if should_cancel() {
                return Err("Export cancelled.".to_string());
            }
            let mut progressed = false;
            if !input_eos {
                let index =
                    unsafe { ndk_sys::AMediaCodec_dequeueInputBuffer(encoder.ptr, TIMEOUT_US) };
                if index >= 0 {
                    let mut capacity = 0usize;
                    let buffer = unsafe {
                        ndk_sys::AMediaCodec_getInputBuffer(
                            encoder.ptr,
                            index as usize,
                            &mut capacity,
                        )
                    };
                    if buffer.is_null() {
                        return Err(
                            "Android AAC encoder returned an invalid input buffer.".to_string()
                        );
                    }
                    let remaining = audio.samples.len().saturating_sub(input_sample);
                    let channel_count = audio.channels as usize;
                    let buffer_sample_capacity = (capacity / 2 / channel_count) * channel_count;
                    let sample_count = remaining.min(buffer_sample_capacity);
                    if sample_count == 0 && remaining > 0 {
                        return Err(
                            "Android AAC encoder returned an undersized input buffer.".to_string()
                        );
                    }
                    let input_frame = input_sample / audio.channels as usize;
                    let presentation_time = (input_frame as u64).saturating_mul(1_000_000)
                        / u64::from(audio.sample_rate);
                    if sample_count == 0 {
                        let status = unsafe {
                            ndk_sys::AMediaCodec_queueInputBuffer(
                                encoder.ptr,
                                index as usize,
                                0,
                                0,
                                presentation_time,
                                ndk_sys::AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM,
                            )
                        };
                        if status != ndk_sys::media_status_t::AMEDIA_OK {
                            return Err("Android AAC encoder rejected end-of-stream.".to_string());
                        }
                        input_eos = true;
                    } else {
                        let bytes = unsafe { slice::from_raw_parts_mut(buffer, sample_count * 2) };
                        for (offset, sample) in audio.samples
                            [input_sample..input_sample + sample_count]
                            .iter()
                            .enumerate()
                        {
                            let raw = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                            bytes[offset * 2..offset * 2 + 2].copy_from_slice(&raw.to_le_bytes());
                        }
                        let status = unsafe {
                            ndk_sys::AMediaCodec_queueInputBuffer(
                                encoder.ptr,
                                index as usize,
                                0,
                                sample_count * 2,
                                presentation_time,
                                0,
                            )
                        };
                        if status != ndk_sys::media_status_t::AMEDIA_OK {
                            return Err("Android AAC encoder rejected PCM audio.".to_string());
                        }
                        input_sample += sample_count;
                        let progress = 10 + ((input_sample * 70) / audio.samples.len()) as i64;
                        on_progress(progress.min(80));
                    }
                    progressed = true;
                }
            }

            let mut info: ndk_sys::AMediaCodecBufferInfo = unsafe { mem::zeroed() };
            let index = unsafe {
                ndk_sys::AMediaCodec_dequeueOutputBuffer(encoder.ptr, &mut info, TIMEOUT_US)
            };
            if index >= 0 {
                let mut capacity = 0usize;
                let buffer = unsafe {
                    ndk_sys::AMediaCodec_getOutputBuffer(encoder.ptr, index as usize, &mut capacity)
                };
                let size = info.size.max(0) as usize;
                if size > 0 && info.flags & ndk_sys::AMEDIACODEC_BUFFER_FLAG_CODEC_CONFIG == 0 {
                    if buffer.is_null() || info.offset.max(0) as usize + size > capacity {
                        return Err("Android AAC encoder returned invalid output.".to_string());
                    }
                    let track = track_index.ok_or_else(|| {
                        "Android AAC output arrived before its format.".to_string()
                    })?;
                    let status = unsafe {
                        ndk_sys::AMediaMuxer_writeSampleData(muxer.ptr, track, buffer, &info)
                    };
                    if status != ndk_sys::media_status_t::AMEDIA_OK {
                        return Err("Android M4A muxer could not write AAC audio.".to_string());
                    }
                }
                output_eos = info.flags & ndk_sys::AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM != 0;
                unsafe {
                    ndk_sys::AMediaCodec_releaseOutputBuffer(encoder.ptr, index as usize, false);
                }
                progressed = true;
            } else if index == ndk_sys::AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED as isize {
                if track_index.is_some() {
                    return Err("Android AAC encoder changed format more than once.".to_string());
                }
                let output_format = unsafe { ndk_sys::AMediaCodec_getOutputFormat(encoder.ptr) };
                if output_format.is_null() {
                    return Err("Android AAC encoder returned no output format.".to_string());
                }
                let result = muxer.add_track_and_start(output_format);
                unsafe {
                    let _ = ndk_sys::AMediaFormat_delete(output_format);
                }
                track_index = Some(result?);
                progressed = true;
            } else if index != ndk_sys::AMEDIACODEC_INFO_TRY_AGAIN_LATER as isize {
                return Err("Android AAC encoder failed.".to_string());
            }

            if progressed {
                idle_iterations = 0;
            } else {
                idle_iterations += 1;
            }
            if idle_iterations > MAX_IDLE_ITERATIONS {
                return Err("Android AAC encoder timed out.".to_string());
            }
        }
        drop(muxer);
        output
            .sync_all()
            .map_err(|_| "Could not finish Android export staging.".to_string())?;
        validate(destination)
    }

    pub(super) fn validate(path: &Path) -> Result<(), String> {
        let bytes =
            fs::read(path).map_err(|_| "Could not read Android export staging.".to_string())?;
        if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
            return Err("Android export did not produce a valid M4A container.".to_string());
        }
        if !Extractor::open(path)?.contains_aac_track() {
            return Err("Android export did not contain a valid AAC audio track.".to_string());
        }
        Ok(())
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn encode_android_m4a(
    source: &Path,
    destination: &Path,
    should_cancel: &dyn Fn() -> bool,
    on_progress: &dyn Fn(i64),
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android::encode(source, destination, should_cancel, on_progress)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (source, destination, should_cancel, on_progress);
        Err("Android M4A export is only available in Android builds.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_build_reports_android_encoder_unavailable() {
        let result = encode_android_m4a(
            Path::new("source.wav"),
            Path::new("export.m4a"),
            &|| false,
            &|_| {},
        );
        assert!(result
            .unwrap_err()
            .contains("only available in Android builds"));
    }
}
