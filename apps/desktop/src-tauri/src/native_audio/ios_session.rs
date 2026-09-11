use objc2::MainThreadMarker;
use objc2_avf_audio::{
    AVAudioSession, AVAudioSessionCategoryOptions, AVAudioSessionCategoryPlayback,
    AVAudioSessionModeDefault,
};
use objc2_ui_kit::{UIApplication, UIApplicationState};
use std::sync::mpsc;
use tauri::AppHandle;

pub(super) async fn application_is_active(app: &AppHandle) -> Result<bool, String> {
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let active = MainThreadMarker::new()
            .map(|marker| {
                UIApplication::sharedApplication(marker).applicationState()
                    == UIApplicationState::Active
            })
            .unwrap_or(false);
        let _ = sender.send(active);
    })
    .map_err(|_| "Native audio app state is unavailable.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|_| "Native audio app state is unavailable.".to_string())?
        .map_err(|_| "Native audio app state is unavailable.".to_string())
}

pub(crate) struct PlaybackAudioSession;

impl PlaybackAudioSession {
    pub(crate) fn activate() -> Result<Self, String> {
        let session = unsafe { AVAudioSession::sharedInstance() };
        let category = unsafe { AVAudioSessionCategoryPlayback }
            .ok_or_else(|| "Native playback audio session is unavailable.".to_string())?;
        let mode = unsafe { AVAudioSessionModeDefault }
            .ok_or_else(|| "Native playback audio session is unavailable.".to_string())?;
        unsafe {
            session.setCategory_mode_options_error(
                category,
                mode,
                AVAudioSessionCategoryOptions::empty(),
            )
        }
        .map_err(|_| "Native playback audio session could not be configured.".to_string())?;
        unsafe { session.setActive_error(true) }
            .map_err(|_| "Native playback audio session could not be activated.".to_string())?;
        Ok(Self)
    }
}

impl Drop for PlaybackAudioSession {
    fn drop(&mut self) {
        let session = unsafe { AVAudioSession::sharedInstance() };
        let _ = unsafe { session.setActive_error(false) };
    }
}
