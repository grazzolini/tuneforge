use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::Path,
};

pub(crate) enum AudioOutputFormat {
    Wav,
    Flac,
    Mp3,
    M4a,
}

impl AudioOutputFormat {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "wav" => Ok(Self::Wav),
            "flac" => Ok(Self::Flac),
            "mp3" => Ok(Self::Mp3),
            "m4a" => Ok(Self::M4a),
            _ => Err("Android audio conversion requires WAV, FLAC, MP3, or M4A.".to_string()),
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Flac => "flac",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
        }
    }
}

#[repr(C)]
struct TfFfmpegJob {
    _private: [u8; 0],
}

#[repr(C)]
struct TfFfmpegRenderRequest {
    input_path: *const c_char,
    output_path: *const c_char,
    output_format: *const c_char,
    pitch_cents: f64,
    callback_opaque: *mut c_void,
    should_cancel: Option<unsafe extern "C" fn(*mut c_void) -> c_int>,
    on_progress: Option<unsafe extern "C" fn(*mut c_void, c_int)>,
}

unsafe extern "C" {
    fn tf_ffmpeg_job_create() -> *mut TfFfmpegJob;
    fn tf_ffmpeg_job_destroy(job: *mut TfFfmpegJob);
    fn tf_ffmpeg_render(job: *mut TfFfmpegJob, request: *const TfFfmpegRenderRequest) -> c_int;
    fn tf_ffmpeg_job_error(job: *const TfFfmpegJob) -> *const c_char;
    fn tf_ffmpeg_job_output_sample_rate(job: *const TfFfmpegJob) -> c_int;
    fn tf_ffmpeg_job_output_channels(job: *const TfFfmpegJob) -> c_int;
    fn tf_ffmpeg_job_output_samples(job: *const TfFfmpegJob) -> i64;
}

pub(crate) struct RenderedAudio {
    pub(crate) duration_seconds: f64,
    pub(crate) sample_rate: u32,
    pub(crate) channels: u32,
}

struct Job(*mut TfFfmpegJob);

impl Job {
    fn new() -> Result<Self, String> {
        let job = unsafe { tf_ffmpeg_job_create() };
        if job.is_null() {
            Err("Android FFmpeg could not allocate an operation context.".to_string())
        } else {
            Ok(Self(job))
        }
    }

    fn error(&self) -> String {
        let value = unsafe { tf_ffmpeg_job_error(self.0) };
        if value.is_null() {
            return "Android FFmpeg conversion failed.".to_string();
        }
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned()
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { tf_ffmpeg_job_destroy(self.0) };
    }
}

struct Callbacks<'a> {
    should_cancel: &'a mut dyn FnMut() -> bool,
    on_progress: &'a mut dyn FnMut(i32),
}

unsafe extern "C" fn should_cancel(opaque: *mut c_void) -> c_int {
    let callbacks = unsafe { &mut *(opaque.cast::<Callbacks<'_>>()) };
    i32::from((callbacks.should_cancel)())
}

unsafe extern "C" fn on_progress(opaque: *mut c_void, progress: c_int) {
    let callbacks = unsafe { &mut *(opaque.cast::<Callbacks<'_>>()) };
    (callbacks.on_progress)(progress);
}

pub(crate) fn render_audio(
    input: &Path,
    output: &Path,
    format: AudioOutputFormat,
    pitch_cents: f64,
    should_cancel_callback: &mut dyn FnMut() -> bool,
    progress_callback: &mut dyn FnMut(i32),
) -> Result<RenderedAudio, String> {
    if !pitch_cents.is_finite() || pitch_cents.abs() > 4800.0 {
        return Err(
            "Android audio conversion received an invalid pitch transformation.".to_string(),
        );
    }
    let input = CString::new(input.to_string_lossy().as_bytes())
        .map_err(|_| "Android audio input path contained an invalid NUL byte.".to_string())?;
    let output = CString::new(output.to_string_lossy().as_bytes())
        .map_err(|_| "Android audio output path contained an invalid NUL byte.".to_string())?;
    let format = CString::new(format.as_str()).expect("fixed format names never contain NUL");
    let mut callbacks = Callbacks {
        should_cancel: should_cancel_callback,
        on_progress: progress_callback,
    };
    let request = TfFfmpegRenderRequest {
        input_path: input.as_ptr(),
        output_path: output.as_ptr(),
        output_format: format.as_ptr(),
        pitch_cents,
        callback_opaque: (&mut callbacks as *mut Callbacks<'_>).cast(),
        should_cancel: Some(should_cancel),
        on_progress: Some(on_progress),
    };
    let job = Job::new()?;
    let result = unsafe { tf_ffmpeg_render(job.0, &request) };
    if result < 0 {
        Err(job.error())
    } else {
        let sample_rate = unsafe { tf_ffmpeg_job_output_sample_rate(job.0) };
        let channels = unsafe { tf_ffmpeg_job_output_channels(job.0) };
        let samples = unsafe { tf_ffmpeg_job_output_samples(job.0) };
        if sample_rate <= 0 || channels <= 0 || samples <= 0 {
            return Err("Android FFmpeg returned invalid output audio properties.".to_string());
        }
        Ok(RenderedAudio {
            duration_seconds: samples as f64 / sample_rate as f64,
            sample_rate: sample_rate as u32,
            channels: channels as u32,
        })
    }
}
