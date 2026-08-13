#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::path::Path;

use super::decode::{DecodedAudio, DecodedInterleavedAudio};

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use std::{
        ffi::{CStr, CString},
        fs, mem,
        os::{fd::AsRawFd, raw::c_char},
        ptr, slice,
    };

    struct MediaExtractorHandle {
        ptr: *mut ndk_sys::AMediaExtractor,
        data_source_file: Option<fs::File>,
    }

    impl MediaExtractorHandle {
        fn new() -> Result<Self, String> {
            let ptr = unsafe { ndk_sys::AMediaExtractor_new() };
            if ptr.is_null() {
                return Err("Android MediaExtractor could not be created.".to_string());
            }
            Ok(Self {
                ptr,
                data_source_file: None,
            })
        }

        fn set_data_source(&mut self, path: &Path) -> Result<(), String> {
            let file = fs::File::open(path).map_err(|error| {
                format!("Android MediaExtractor could not open the imported audio: {error}")
            })?;
            let length: ndk_sys::off64_t = file
                .metadata()
                .map_err(|error| {
                    format!("Android MediaExtractor could not inspect the imported audio: {error}")
                })?
                .len()
                .try_into()
                .map_err(|_| {
                    "Imported audio is too large for Android MediaExtractor.".to_string()
                })?;
            let fd_status = unsafe {
                ndk_sys::AMediaExtractor_setDataSourceFd(self.ptr, file.as_raw_fd(), 0, length)
            };
            if fd_status == ndk_sys::media_status_t::AMEDIA_OK {
                self.data_source_file = Some(file);
                return Ok(());
            }

            let path = CString::new(path.to_string_lossy().as_bytes())
                .map_err(|_| "Audio path contains an invalid null byte.".to_string())?;
            let status = unsafe { ndk_sys::AMediaExtractor_setDataSource(self.ptr, path.as_ptr()) };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                return Err("Android MediaExtractor could not open the imported audio.".to_string());
            }
            Ok(())
        }
    }

    impl Drop for MediaExtractorHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = ndk_sys::AMediaExtractor_delete(self.ptr);
            }
        }
    }

    struct MediaFormatHandle(*mut ndk_sys::AMediaFormat);

    impl MediaFormatHandle {
        fn from_track(extractor: &MediaExtractorHandle, index: usize) -> Result<Self, String> {
            let ptr = unsafe { ndk_sys::AMediaExtractor_getTrackFormat(extractor.ptr, index) };
            if ptr.is_null() {
                return Err("Android MediaExtractor returned an invalid track format.".to_string());
            }
            Ok(Self(ptr))
        }
    }

    impl Drop for MediaFormatHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = ndk_sys::AMediaFormat_delete(self.0);
            }
        }
    }

    struct MediaCodecHandle {
        ptr: *mut ndk_sys::AMediaCodec,
        started: bool,
    }

    impl MediaCodecHandle {
        fn new(mime: &str) -> Result<Self, String> {
            let mime = CString::new(mime)
                .map_err(|_| "Audio MIME type contains a null byte.".to_string())?;
            let ptr = unsafe { ndk_sys::AMediaCodec_createDecoderByType(mime.as_ptr()) };
            if ptr.is_null() {
                return Err("Android MediaCodec has no decoder for this audio format.".to_string());
            }
            Ok(Self {
                ptr,
                started: false,
            })
        }

        fn configure(&self, format: &MediaFormatHandle) -> Result<(), String> {
            let status = unsafe {
                ndk_sys::AMediaCodec_configure(
                    self.ptr,
                    format.0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    0,
                )
            };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                return Err("Android MediaCodec could not configure the audio decoder.".to_string());
            }
            Ok(())
        }

        fn start(&mut self) -> Result<(), String> {
            let status = unsafe { ndk_sys::AMediaCodec_start(self.ptr) };
            if status != ndk_sys::media_status_t::AMEDIA_OK {
                return Err("Android MediaCodec could not start the audio decoder.".to_string());
            }
            self.started = true;
            Ok(())
        }
    }

    impl Drop for MediaCodecHandle {
        fn drop(&mut self) {
            unsafe {
                if self.started {
                    let _ = ndk_sys::AMediaCodec_stop(self.ptr);
                }
                let _ = ndk_sys::AMediaCodec_delete(self.ptr);
            }
        }
    }

    fn media_format_string(
        format: &MediaFormatHandle,
        key: *const c_char,
    ) -> Result<Option<String>, String> {
        let mut value: *const c_char = ptr::null();
        let found = unsafe { ndk_sys::AMediaFormat_getString(format.0, key, &mut value) };
        if !found || value.is_null() {
            return Ok(None);
        }
        let value = unsafe { CStr::from_ptr(value) }
            .to_str()
            .map_err(|_| "Android media format contained invalid UTF-8.".to_string())?
            .to_string();
        Ok(Some(value))
    }

    fn media_format_i32(format: *mut ndk_sys::AMediaFormat, key: *const c_char) -> Option<i32> {
        let mut value = 0i32;
        let found = unsafe { ndk_sys::AMediaFormat_getInt32(format, key, &mut value) };
        found.then_some(value)
    }

    fn media_format_handle_i32(format: &MediaFormatHandle, key: *const c_char) -> Option<i32> {
        media_format_i32(format.0, key)
    }

    pub(super) fn read(path: &Path) -> Result<DecodedInterleavedAudio, String> {
        const TIMEOUT_US: i64 = 10_000;
        const PCM_ENCODING_16BIT: i32 = 2;
        const PCM_ENCODING_FLOAT: i32 = 4;

        let mut extractor = MediaExtractorHandle::new()?;
        extractor.set_data_source(path)?;

        let track_count = unsafe { ndk_sys::AMediaExtractor_getTrackCount(extractor.ptr) };
        let mut selected_track = None;
        let mut selected_format = None;
        let mut selected_mime = None;
        for track_index in 0..track_count {
            let format = MediaFormatHandle::from_track(&extractor, track_index)?;
            let mime = media_format_string(&format, unsafe { ndk_sys::AMEDIAFORMAT_KEY_MIME })?;
            if mime
                .as_deref()
                .is_some_and(|value| value.starts_with("audio/"))
            {
                selected_track = Some(track_index);
                selected_mime = mime;
                selected_format = Some(format);
                break;
            }
        }

        let track_index = selected_track.ok_or_else(|| {
            "Android MediaExtractor did not find an audio track in the imported file.".to_string()
        })?;
        let format = selected_format
            .ok_or_else(|| "Android MediaExtractor lost the selected audio format.".to_string())?;
        let mime = selected_mime.ok_or_else(|| {
            "Android MediaExtractor did not report an audio MIME type.".to_string()
        })?;

        let sample_rate =
            media_format_handle_i32(&format, unsafe { ndk_sys::AMEDIAFORMAT_KEY_SAMPLE_RATE })
                .ok_or_else(|| {
                    "Android MediaExtractor did not report an audio sample rate.".to_string()
                })?;
        let channels =
            media_format_handle_i32(&format, unsafe { ndk_sys::AMEDIAFORMAT_KEY_CHANNEL_COUNT })
                .ok_or_else(|| {
                    "Android MediaExtractor did not report an audio channel count.".to_string()
                })?;
        if sample_rate <= 0 || channels <= 0 {
            return Err("Android MediaExtractor reported invalid audio metadata.".to_string());
        }

        let status = unsafe { ndk_sys::AMediaExtractor_selectTrack(extractor.ptr, track_index) };
        if status != ndk_sys::media_status_t::AMEDIA_OK {
            return Err("Android MediaExtractor could not select the audio track.".to_string());
        }

        let mut codec = MediaCodecHandle::new(&mime)?;
        codec.configure(&format)?;
        codec.start()?;

        let mut output_sample_rate = sample_rate;
        let mut output_channels = channels;
        let mut output_encoding = PCM_ENCODING_16BIT;
        let mut decoded = Vec::new();
        let mut input_eos = false;
        let mut output_eos = false;
        let mut idle_iterations = 0usize;

        while !output_eos {
            let mut made_progress = false;
            if !input_eos {
                let input_index =
                    unsafe { ndk_sys::AMediaCodec_dequeueInputBuffer(codec.ptr, TIMEOUT_US) };
                if input_index >= 0 {
                    let mut input_capacity = 0usize;
                    let input_buffer = unsafe {
                        ndk_sys::AMediaCodec_getInputBuffer(
                            codec.ptr,
                            input_index as usize,
                            &mut input_capacity,
                        )
                    };
                    if input_buffer.is_null() {
                        return Err(
                            "Android MediaCodec returned an invalid input buffer.".to_string()
                        );
                    }
                    let sample_size = unsafe {
                        ndk_sys::AMediaExtractor_readSampleData(
                            extractor.ptr,
                            input_buffer,
                            input_capacity,
                        )
                    };
                    if sample_size < 0 {
                        let status = unsafe {
                            ndk_sys::AMediaCodec_queueInputBuffer(
                                codec.ptr,
                                input_index as usize,
                                0,
                                0,
                                0,
                                ndk_sys::AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM,
                            )
                        };
                        if status != ndk_sys::media_status_t::AMEDIA_OK {
                            return Err("Android MediaCodec could not queue audio end-of-stream."
                                .to_string());
                        }
                        input_eos = true;
                    } else {
                        let sample_time =
                            unsafe { ndk_sys::AMediaExtractor_getSampleTime(extractor.ptr) };
                        let sample_flags =
                            unsafe { ndk_sys::AMediaExtractor_getSampleFlags(extractor.ptr) };
                        let status = unsafe {
                            ndk_sys::AMediaCodec_queueInputBuffer(
                                codec.ptr,
                                input_index as usize,
                                0,
                                sample_size as usize,
                                sample_time.max(0) as u64,
                                sample_flags,
                            )
                        };
                        if status != ndk_sys::media_status_t::AMEDIA_OK {
                            return Err(
                                "Android MediaCodec could not queue compressed audio.".to_string()
                            );
                        }
                        unsafe {
                            ndk_sys::AMediaExtractor_advance(extractor.ptr);
                        }
                    }
                    made_progress = true;
                }
            }

            let mut info: ndk_sys::AMediaCodecBufferInfo = unsafe { mem::zeroed() };
            let output_index = unsafe {
                ndk_sys::AMediaCodec_dequeueOutputBuffer(codec.ptr, &mut info, TIMEOUT_US)
            };
            if output_index >= 0 {
                let mut output_capacity = 0usize;
                let output_buffer = unsafe {
                    ndk_sys::AMediaCodec_getOutputBuffer(
                        codec.ptr,
                        output_index as usize,
                        &mut output_capacity,
                    )
                };
                if output_buffer.is_null() {
                    return Err("Android MediaCodec returned an invalid output buffer.".to_string());
                }
                let offset = info.offset.max(0) as usize;
                let size = info.size.max(0) as usize;
                if size > 0 {
                    let end = offset.saturating_add(size);
                    if end > output_capacity {
                        return Err(
                            "Android MediaCodec returned an invalid output range.".to_string()
                        );
                    }
                    let output = unsafe { slice::from_raw_parts(output_buffer.add(offset), size) };
                    decoded.extend_from_slice(output);
                }
                if info.flags & ndk_sys::AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM != 0 {
                    output_eos = true;
                }
                unsafe {
                    ndk_sys::AMediaCodec_releaseOutputBuffer(
                        codec.ptr,
                        output_index as usize,
                        false,
                    );
                }
                made_progress = true;
            } else if output_index == ndk_sys::AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED as isize {
                let output_format = unsafe { ndk_sys::AMediaCodec_getOutputFormat(codec.ptr) };
                if !output_format.is_null() {
                    output_sample_rate = media_format_i32(output_format, unsafe {
                        ndk_sys::AMEDIAFORMAT_KEY_SAMPLE_RATE
                    })
                    .unwrap_or(output_sample_rate);
                    output_channels = media_format_i32(output_format, unsafe {
                        ndk_sys::AMEDIAFORMAT_KEY_CHANNEL_COUNT
                    })
                    .unwrap_or(output_channels);
                    output_encoding = media_format_i32(output_format, unsafe {
                        ndk_sys::AMEDIAFORMAT_KEY_PCM_ENCODING
                    })
                    .unwrap_or(PCM_ENCODING_16BIT);
                    unsafe {
                        let _ = ndk_sys::AMediaFormat_delete(output_format);
                    }
                }
                made_progress = true;
            } else if output_index != ndk_sys::AMEDIACODEC_INFO_TRY_AGAIN_LATER as isize {
                return Err("Android MediaCodec failed while decoding audio.".to_string());
            }

            if made_progress {
                idle_iterations = 0;
            } else {
                idle_iterations += 1;
                if idle_iterations > 2_000 {
                    return Err("Android MediaCodec timed out while decoding audio.".to_string());
                }
            }
        }

        match output_encoding {
            PCM_ENCODING_16BIT => {
                pcm_i16_bytes_to_interleaved(&decoded, output_sample_rate, output_channels)
            }
            PCM_ENCODING_FLOAT => {
                pcm_f32_bytes_to_interleaved(&decoded, output_sample_rate, output_channels)
            }
            _ => Err("Android MediaCodec returned an unsupported PCM output encoding.".to_string()),
        }
    }

    fn pcm_i16_bytes_to_interleaved(
        bytes: &[u8],
        sample_rate: i32,
        channels: i32,
    ) -> Result<DecodedInterleavedAudio, String> {
        if sample_rate <= 0 || channels <= 0 {
            return Err("Android MediaCodec returned invalid PCM metadata.".to_string());
        }
        let channel_count = channels as usize;
        let frame_bytes = channel_count
            .checked_mul(2)
            .ok_or_else(|| "Android MediaCodec returned invalid channel metadata.".to_string())?;
        if frame_bytes == 0 {
            return Err("Android MediaCodec returned invalid channel metadata.".to_string());
        }
        let mut samples = Vec::with_capacity(bytes.len() / 2);
        for raw in bytes.chunks_exact(2) {
            samples.push(
                (i16::from_le_bytes([raw[0], raw[1]]) as f32 / i16::MAX as f32).clamp(-1.0, 1.0),
            );
        }
        Ok(DecodedInterleavedAudio {
            samples,
            sample_rate: sample_rate as u32,
            channels: channels as u32,
        })
    }

    fn pcm_f32_bytes_to_interleaved(
        bytes: &[u8],
        sample_rate: i32,
        channels: i32,
    ) -> Result<DecodedInterleavedAudio, String> {
        if sample_rate <= 0 || channels <= 0 {
            return Err("Android MediaCodec returned invalid PCM metadata.".to_string());
        }
        let channel_count = channels as usize;
        let frame_bytes = channel_count
            .checked_mul(4)
            .ok_or_else(|| "Android MediaCodec returned invalid channel metadata.".to_string())?;
        if frame_bytes == 0 {
            return Err("Android MediaCodec returned invalid channel metadata.".to_string());
        }
        let mut samples = Vec::with_capacity(bytes.len() / 4);
        for raw in bytes.chunks_exact(4) {
            samples.push(f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]).clamp(-1.0, 1.0));
        }
        Ok(DecodedInterleavedAudio {
            samples,
            sample_rate: sample_rate as u32,
            channels: channels as u32,
        })
    }
}

pub fn read_android_media_audio_interleaved(
    path: &Path,
) -> Result<DecodedInterleavedAudio, String> {
    #[cfg(target_os = "android")]
    {
        android::read(path)
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = path;
        Err("Android MediaCodec decode is only available in Android builds.".to_string())
    }
}

pub fn read_android_media_audio(path: &Path) -> Result<DecodedAudio, String> {
    let audio = read_android_media_audio_interleaved(path)?;
    let channels = usize::try_from(audio.channels)
        .map_err(|_| "Android MediaCodec returned invalid channel metadata.".to_string())?;
    let samples = audio
        .samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / audio.channels as f32)
        .collect();
    Ok(DecodedAudio {
        samples,
        sample_rate: audio.sample_rate,
        channels: audio.channels,
    })
}
