use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use tauri::State;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PowerInhibitionReason {
    Playback,
    SyncListener,
    SyncTransfer,
    TunerCapture,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PowerInhibitionPhase {
    Inactive,
    Acquiring,
    Active,
    Unsupported,
    Failed,
    Releasing,
    ReleaseFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerInhibitionStatus {
    pub phase: PowerInhibitionPhase,
    pub backend: Option<String>,
    pub active_reasons: Vec<PowerInhibitionReason>,
    pub screen_protected: bool,
    pub background_protected: bool,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

impl Default for PowerInhibitionStatus {
    fn default() -> Self {
        Self {
            phase: PowerInhibitionPhase::Inactive,
            backend: None,
            active_reasons: Vec::new(),
            screen_protected: false,
            background_protected: false,
            error_code: None,
            error_message: None,
        }
    }
}

#[derive(Clone, Debug)]
struct PlatformDetails {
    backend: &'static str,
    screen_protected: bool,
    background_protected: bool,
}

#[derive(Clone, Debug)]
struct SafeError {
    code: &'static str,
    message: &'static str,
}

struct PlatformProbe {
    details: Option<PlatformDetails>,
    error: Option<SafeError>,
    pending_phase: Option<PowerInhibitionPhase>,
    data_sync_timeout_epoch: u64,
}

#[cfg(any(test, target_os = "android"))]
fn parse_android_response(response: &str) -> Result<PlatformProbe, SafeError> {
    let mut parts = response.split(';');
    let phase = parts.next().unwrap_or_default();
    let mask = parts
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0);
    let error_code = parts.next().unwrap_or("none");
    let _requested_mask = parts.next();
    let data_sync_timeout_epoch = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let screen_protected = parts.next() == Some("true");
    let service_confirmed = mask & 0b0111 != 0;
    let details = (mask != 0).then_some(PlatformDetails {
        backend: if service_confirmed {
            "android-foreground-service"
        } else {
            "android-activity-screen"
        },
        screen_protected,
        background_protected: service_confirmed,
    });
    let confirmed = details.is_some();
    let error = match error_code {
        "none" if matches!(phase, "active" | "inactive" | "acquiring" | "releasing") => None,
        "android-data-sync-timeout" => Some(SafeError {
            code: "android-data-sync-timeout",
            message: "Android stopped sync power protection after its system time limit.",
        }),
        "android-notification-permission-denied" => Some(SafeError {
            code: "android-notification-permission-denied",
            message: if confirmed {
                "Power protection is active, but Android notification visibility is unavailable. Android still shows active work in system controls."
            } else {
                "Android notification permission is unavailable, and power protection is not confirmed."
            },
        }),
        "android-notification-post-failed" => Some(SafeError {
            code: "android-notification-post-failed",
            message: if confirmed {
                "Power protection is active, but Android notification visibility could not be confirmed."
            } else {
                "Android notification visibility and power protection could not be confirmed."
            },
        }),
        _ => {
            return Err(SafeError {
                code: "android-inhibition-failed",
                message: "Android power protection could not be updated.",
            });
        }
    };
    let pending_phase = match phase {
        "acquiring" => Some(PowerInhibitionPhase::Acquiring),
        "releasing" => Some(PowerInhibitionPhase::Releasing),
        _ => None,
    };
    Ok(PlatformProbe {
        details,
        error,
        pending_phase,
        data_sync_timeout_epoch,
    })
}

#[cfg(any(test, target_os = "android"))]
fn android_reason_mask(reasons: &[PowerInhibitionReason]) -> i32 {
    reasons.iter().fold(0, |mask, reason| {
        mask | match reason {
            PowerInhibitionReason::Playback => 1,
            PowerInhibitionReason::SyncListener => 2,
            PowerInhibitionReason::SyncTransfer => 4,
            PowerInhibitionReason::TunerCapture => 8,
        }
    })
}

trait PlatformInhibitor: Send {
    fn acquire(
        &mut self,
        reasons: &[PowerInhibitionReason],
    ) -> Result<Option<PlatformDetails>, SafeError>;
    fn release(&mut self) -> Result<(), SafeError>;

    fn probe(&mut self) -> Option<PlatformProbe> {
        None
    }
}

#[derive(Clone)]
pub struct PowerInhibitionState {
    runtime: Arc<Mutex<PowerInhibitionRuntime>>,
}

struct PowerInhibitionRuntime {
    platform: Box<dyn PlatformInhibitor>,
    frontend_reasons: BTreeSet<PowerInhibitionReason>,
    scoped_reasons: BTreeMap<PowerInhibitionReason, u32>,
    confirmed: Option<PlatformDetails>,
    platform_maybe_active: bool,
    data_sync_timeout_epoch: u64,
    status: PowerInhibitionStatus,
}

impl PowerInhibitionState {
    pub fn new() -> Self {
        Self::with_platform(platform::current())
    }

    fn with_platform(platform: Box<dyn PlatformInhibitor>) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(PowerInhibitionRuntime {
                platform,
                frontend_reasons: BTreeSet::new(),
                scoped_reasons: BTreeMap::new(),
                confirmed: None,
                platform_maybe_active: false,
                data_sync_timeout_epoch: 0,
                status: PowerInhibitionStatus::default(),
            })),
        }
    }

    pub fn set_activity(
        &self,
        reason: PowerInhibitionReason,
        active: bool,
    ) -> Result<PowerInhibitionStatus, String> {
        let mut runtime = self.lock()?;
        if active {
            runtime.frontend_reasons.insert(reason);
        } else {
            runtime.frontend_reasons.remove(&reason);
        }
        runtime.reconcile();
        Ok(runtime.status.clone())
    }

    pub fn acquire_scoped(
        &self,
        reason: PowerInhibitionReason,
    ) -> Result<PowerInhibitionGuard, String> {
        let mut runtime = self.lock()?;
        let count = runtime.scoped_reasons.entry(reason).or_default();
        *count = count.saturating_add(1);
        runtime.reconcile();
        Ok(PowerInhibitionGuard {
            state: self.clone(),
            reason,
            active: true,
        })
    }

    pub fn status(&self) -> Result<PowerInhibitionStatus, String> {
        let mut runtime = self.lock()?;
        runtime.refresh_platform_status();
        Ok(runtime.status.clone())
    }

    pub fn shutdown(&self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.frontend_reasons.clear();
            runtime.scoped_reasons.clear();
            runtime.reconcile();
        }
    }

    pub fn data_sync_timeout_epoch(&self) -> u64 {
        let Ok(mut runtime) = self.runtime.lock() else {
            return 0;
        };
        runtime.refresh_platform_status();
        runtime.data_sync_timeout_epoch
    }

    fn release_scoped(&self, reason: PowerInhibitionReason) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if let Some(count) = runtime.scoped_reasons.get_mut(&reason) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    runtime.scoped_reasons.remove(&reason);
                }
            }
            runtime.reconcile();
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, PowerInhibitionRuntime>, String> {
        self.runtime
            .lock()
            .map_err(|_| "Power protection state is unavailable.".to_string())
    }
}

pub struct PowerInhibitionGuard {
    state: PowerInhibitionState,
    reason: PowerInhibitionReason,
    active: bool,
}

impl PowerInhibitionGuard {
    pub fn release(mut self) {
        if self.active {
            self.state.release_scoped(self.reason);
            self.active = false;
        }
    }
}

impl Drop for PowerInhibitionGuard {
    fn drop(&mut self) {
        if self.active {
            self.state.release_scoped(self.reason);
            self.active = false;
        }
    }
}

impl PowerInhibitionRuntime {
    fn reasons(&self) -> Vec<PowerInhibitionReason> {
        self.frontend_reasons
            .iter()
            .copied()
            .chain(
                self.scoped_reasons
                    .iter()
                    .filter(|(_, count)| **count > 0)
                    .map(|(reason, _)| *reason),
            )
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    fn reconcile(&mut self) {
        let reasons = self.reasons();
        if reasons == self.status.active_reasons
            && matches!(
                self.status.phase,
                PowerInhibitionPhase::Active | PowerInhibitionPhase::Unsupported
            )
        {
            return;
        }
        self.status.error_code = None;
        self.status.error_message = None;

        if reasons.is_empty() {
            if !self.platform_maybe_active
                && !matches!(self.status.phase, PowerInhibitionPhase::ReleaseFailed)
            {
                self.status = PowerInhibitionStatus::default();
                return;
            }

            self.status.phase = PowerInhibitionPhase::Releasing;
            match self.platform.release() {
                Ok(()) => {
                    if let Some(probe) = self.platform.probe() {
                        self.apply_release_probe(probe);
                    } else {
                        self.confirmed = None;
                        self.platform_maybe_active = false;
                        self.status = PowerInhibitionStatus::default();
                    }
                }
                Err(error) => {
                    self.status.phase = PowerInhibitionPhase::ReleaseFailed;
                    self.set_error(error);
                    self.apply_confirmed_details();
                }
            }
            return;
        }

        self.status.active_reasons = reasons.clone();
        self.status.phase = PowerInhibitionPhase::Acquiring;
        self.platform_maybe_active = true;
        match self.platform.acquire(&reasons) {
            Ok(Some(details)) => {
                self.confirmed = Some(details);
                self.status.phase = PowerInhibitionPhase::Active;
                self.apply_confirmed_details();
            }
            Ok(None) => {
                if let Some(probe) = self.platform.probe() {
                    self.apply_acquire_probe(probe);
                } else {
                    self.confirmed = None;
                    self.platform_maybe_active = false;
                    self.status.phase = PowerInhibitionPhase::Unsupported;
                    self.status.backend = None;
                    self.status.screen_protected = false;
                    self.status.background_protected = false;
                    self.set_error(SafeError {
                        code: "power-inhibition-unsupported",
                        message: "Power protection is unavailable on this platform.",
                    });
                }
            }
            Err(error) => {
                self.status.phase = PowerInhibitionPhase::Failed;
                self.set_error(error);
                self.apply_confirmed_details();
            }
        }
    }

    fn refresh_platform_status(&mut self) {
        let Some(probe) = self.platform.probe() else {
            return;
        };
        self.data_sync_timeout_epoch = self
            .data_sync_timeout_epoch
            .max(probe.data_sync_timeout_epoch);
        self.confirmed = probe.details;
        if let Some(error) = probe.error {
            self.status.phase = if self.reasons().is_empty() {
                PowerInhibitionPhase::ReleaseFailed
            } else {
                PowerInhibitionPhase::Failed
            };
            self.set_error(error);
        } else if let Some(phase) = probe.pending_phase {
            self.status.phase = phase;
            self.status.error_code = None;
            self.status.error_message = None;
        } else if self.confirmed.is_some() {
            self.status.phase = PowerInhibitionPhase::Active;
            self.status.error_code = None;
            self.status.error_message = None;
        } else if !self.reasons().is_empty() {
            self.status.phase = PowerInhibitionPhase::Failed;
            self.set_error(SafeError {
                code: "power-inhibition-lost",
                message: "Power protection stopped unexpectedly.",
            });
        } else {
            self.platform_maybe_active = false;
            self.status = PowerInhibitionStatus::default();
            return;
        }
        self.apply_confirmed_details();
    }

    fn apply_acquire_probe(&mut self, probe: PlatformProbe) {
        self.data_sync_timeout_epoch = self
            .data_sync_timeout_epoch
            .max(probe.data_sync_timeout_epoch);
        self.confirmed = probe.details;
        if let Some(error) = probe.error {
            self.status.phase = PowerInhibitionPhase::Failed;
            self.set_error(error);
        } else if let Some(phase) = probe.pending_phase {
            self.status.phase = phase;
            self.status.error_code = None;
            self.status.error_message = None;
        } else if self.confirmed.is_some() {
            self.status.phase = PowerInhibitionPhase::Active;
            self.status.error_code = None;
            self.status.error_message = None;
        } else {
            self.status.phase = PowerInhibitionPhase::Failed;
            self.set_error(SafeError {
                code: "power-inhibition-lost",
                message: "Power protection stopped unexpectedly.",
            });
        }
        self.apply_confirmed_details();
    }

    fn apply_release_probe(&mut self, probe: PlatformProbe) {
        self.data_sync_timeout_epoch = self
            .data_sync_timeout_epoch
            .max(probe.data_sync_timeout_epoch);
        self.confirmed = probe.details;
        if let Some(error) = probe.error {
            self.status.phase = PowerInhibitionPhase::ReleaseFailed;
            self.set_error(error);
            self.apply_confirmed_details();
        } else if probe.pending_phase.is_some() || self.confirmed.is_some() {
            self.status.phase = PowerInhibitionPhase::Releasing;
            self.status.error_code = None;
            self.status.error_message = None;
            self.apply_confirmed_details();
        } else {
            self.platform_maybe_active = false;
            self.status = PowerInhibitionStatus::default();
        }
    }

    fn set_error(&mut self, error: SafeError) {
        self.status.error_code = Some(error.code.to_string());
        self.status.error_message = Some(error.message.to_string());
    }

    fn apply_confirmed_details(&mut self) {
        if let Some(details) = &self.confirmed {
            self.status.backend = Some(details.backend.to_string());
            self.status.screen_protected = details.screen_protected;
            self.status.background_protected = details.background_protected;
        } else {
            self.status.backend = None;
            self.status.screen_protected = false;
            self.status.background_protected = false;
        }
    }
}

#[tauri::command]
pub fn power_inhibition_set_activity(
    state: State<'_, PowerInhibitionState>,
    reason: PowerInhibitionReason,
    active: bool,
) -> Result<PowerInhibitionStatus, String> {
    state.set_activity(reason, active)
}

#[tauri::command]
pub fn power_inhibition_status(
    state: State<'_, PowerInhibitionState>,
) -> Result<PowerInhibitionStatus, String> {
    state.status()
}

#[tauri::command]
pub fn system_media_set_idle_inhibition(
    state: State<'_, PowerInhibitionState>,
    active: bool,
) -> Result<(), String> {
    state
        .set_activity(PowerInhibitionReason::Playback, active)
        .map(|_| ())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::{c_char, c_void, CString};

    type CFAllocatorRef = *const c_void;
    type CFStringRef = *const c_void;
    type IOPMAssertionID = u32;
    type IOReturn = i32;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;
    const K_IO_RETURN_SUCCESS: IOReturn = 0;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: CFAllocatorRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> IOReturn;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
    }

    #[derive(Default)]
    struct MacOsInhibitor {
        assertion_id: Option<IOPMAssertionID>,
    }

    impl PlatformInhibitor for MacOsInhibitor {
        fn acquire(
            &mut self,
            _reasons: &[PowerInhibitionReason],
        ) -> Result<Option<PlatformDetails>, SafeError> {
            if self.assertion_id.is_none() {
                let assertion_type = cf_string("NoDisplaySleepAssertion")?;
                let assertion_name = cf_string("TuneForge active audio and sync")?;
                let mut assertion_id = 0;
                let result = unsafe {
                    IOPMAssertionCreateWithName(
                        assertion_type,
                        K_IOPM_ASSERTION_LEVEL_ON,
                        assertion_name,
                        &mut assertion_id,
                    )
                };
                unsafe {
                    CFRelease(assertion_type);
                    CFRelease(assertion_name);
                }
                if result != K_IO_RETURN_SUCCESS {
                    return Err(acquire_error());
                }
                self.assertion_id = Some(assertion_id);
            }
            Ok(Some(PlatformDetails {
                backend: "macos-iopm",
                screen_protected: true,
                background_protected: true,
            }))
        }

        fn release(&mut self) -> Result<(), SafeError> {
            let Some(assertion_id) = self.assertion_id else {
                return Ok(());
            };
            if unsafe { IOPMAssertionRelease(assertion_id) } != K_IO_RETURN_SUCCESS {
                return Err(SafeError {
                    code: "macos-inhibition-release-failed",
                    message: "macOS power protection could not be released.",
                });
            }
            self.assertion_id = None;
            Ok(())
        }
    }

    fn cf_string(value: &str) -> Result<CFStringRef, SafeError> {
        let value = CString::new(value).map_err(|_| acquire_error())?;
        let value = unsafe {
            CFStringCreateWithCString(std::ptr::null(), value.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if value.is_null() {
            return Err(acquire_error());
        }
        Ok(value)
    }

    fn acquire_error() -> SafeError {
        SafeError {
            code: "macos-inhibition-failed",
            message: "macOS power protection could not be enabled.",
        }
    }

    pub(super) fn current() -> Box<dyn PlatformInhibitor> {
        Box::<MacOsInhibitor>::default()
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use dbus::arg::{OwnedFd, PropMap, Variant};
    use dbus::blocking::Connection;
    use dbus::message::MatchRule;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const PORTAL_DESTINATION: &str = "org.freedesktop.portal.Desktop";
    const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
    const PORTAL_INHIBIT_INTERFACE: &str = "org.freedesktop.portal.Inhibit";
    const PORTAL_REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
    const LOGIND_DESTINATION: &str = "org.freedesktop.login1";
    const LOGIND_PATH: &str = "/org/freedesktop/login1";
    const LOGIND_INTERFACE: &str = "org.freedesktop.login1.Manager";

    enum LinuxHandle {
        Portal {
            connection: Connection,
            request_path: dbus::Path<'static>,
        },
        Logind {
            _fd: OwnedFd,
        },
    }

    #[derive(Default)]
    struct LinuxInhibitor {
        handle: Option<LinuxHandle>,
    }

    impl PlatformInhibitor for LinuxInhibitor {
        fn acquire(
            &mut self,
            _reasons: &[PowerInhibitionReason],
        ) -> Result<Option<PlatformDetails>, SafeError> {
            if let Some(handle) = &self.handle {
                return Ok(Some(details(handle)));
            }

            if let Ok(handle) = acquire_portal() {
                let result = Some(details(&handle));
                self.handle = Some(handle);
                return Ok(result);
            }
            if let Ok(handle) = acquire_logind() {
                let result = Some(details(&handle));
                self.handle = Some(handle);
                return Ok(result);
            }
            Err(SafeError {
                code: "linux-inhibition-failed",
                message: "Linux power protection is unavailable through the desktop portal or system service.",
            })
        }

        fn release(&mut self) -> Result<(), SafeError> {
            let Some(handle) = self.handle.as_ref() else {
                return Ok(());
            };
            if let LinuxHandle::Portal {
                connection,
                request_path,
            } = handle
            {
                let proxy = connection.with_proxy(
                    PORTAL_DESTINATION,
                    request_path.clone(),
                    Duration::from_secs(2),
                );
                proxy
                    .method_call::<(), _, _, _>(PORTAL_REQUEST_INTERFACE, "Close", ())
                    .map_err(|_| SafeError {
                        code: "linux-inhibition-release-failed",
                        message: "Linux power protection could not be released.",
                    })?;
            }
            self.handle = None;
            Ok(())
        }
    }

    fn details(handle: &LinuxHandle) -> PlatformDetails {
        PlatformDetails {
            backend: match handle {
                LinuxHandle::Portal { .. } => "xdg-desktop-portal",
                LinuxHandle::Logind { .. } => "systemd-logind",
            },
            screen_protected: true,
            background_protected: true,
        }
    }

    fn acquire_portal() -> Result<LinuxHandle, ()> {
        let connection = Connection::new_session().map_err(|_| ())?;
        let response = Arc::new(Mutex::new(None::<u32>));
        let response_for_match = response.clone();
        let rule = MatchRule::new_signal(PORTAL_REQUEST_INTERFACE, "Response");
        connection
            .add_match(rule, move |(code, _results): (u32, PropMap), _, _| {
                if let Ok(mut response) = response_for_match.lock() {
                    *response = Some(code);
                }
                true
            })
            .map_err(|_| ())?;

        let token = format!("tuneforge_{}", std::process::id());
        let mut options = PropMap::new();
        options.insert("handle_token".into(), Variant(Box::new(token)));
        let proxy = connection.with_proxy(PORTAL_DESTINATION, PORTAL_PATH, Duration::from_secs(2));
        let (request_path,): (dbus::Path<'static>,) = proxy
            .method_call(PORTAL_INHIBIT_INTERFACE, "Inhibit", ("", 12u32, options))
            .map_err(|_| ())?;

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            connection
                .process(Duration::from_millis(100))
                .map_err(|_| ())?;
            if let Some(code) = *response.lock().map_err(|_| ())? {
                if code == 0 {
                    return Ok(LinuxHandle::Portal {
                        connection,
                        request_path,
                    });
                }
                break;
            }
        }
        Err(())
    }

    fn acquire_logind() -> Result<LinuxHandle, ()> {
        let connection = Connection::new_system().map_err(|_| ())?;
        let proxy = connection.with_proxy(LOGIND_DESTINATION, LOGIND_PATH, Duration::from_secs(2));
        let (fd,): (OwnedFd,) = proxy
            .method_call(
                LOGIND_INTERFACE,
                "Inhibit",
                (
                    "sleep:idle",
                    "TuneForge",
                    "Playback, tuner, or sync is active",
                    "block",
                ),
            )
            .map_err(|_| ())?;
        Ok(LinuxHandle::Logind { _fd: fd })
    }

    pub(super) fn current() -> Box<dyn PlatformInhibitor> {
        Box::<LinuxInhibitor>::default()
    }
}

#[cfg(target_os = "android")]
mod platform {
    use super::*;
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;

    #[derive(Default)]
    struct AndroidInhibitor;

    impl PlatformInhibitor for AndroidInhibitor {
        fn acquire(
            &mut self,
            reasons: &[PowerInhibitionReason],
        ) -> Result<Option<PlatformDetails>, SafeError> {
            let mask = android_reason_mask(reasons);
            let response = call_android("setTuneForgePowerInhibition", mask)?;
            let probe = parse_android_response(&response)?;
            if let Some(error) = probe.error {
                return Err(error);
            }
            if probe.pending_phase == Some(PowerInhibitionPhase::Acquiring) {
                return Ok(None);
            }
            probe.details.map(Some).ok_or_else(android_error)
        }

        fn release(&mut self) -> Result<(), SafeError> {
            let response = call_android("setTuneForgePowerInhibition", 0)?;
            let probe = parse_android_response(&response)?;
            if probe.error.is_some() {
                return Err(SafeError {
                    code: "android-inhibition-release-failed",
                    message: "Android power protection could not be released.",
                });
            }
            Ok(())
        }

        fn probe(&mut self) -> Option<PlatformProbe> {
            Some(
                call_android("getTuneForgePowerInhibitionStatus", 0)
                    .and_then(|response| parse_android_response(&response))
                    .unwrap_or_else(|error| PlatformProbe {
                        details: None,
                        error: Some(error),
                        pending_phase: None,
                        data_sync_timeout_epoch: 0,
                    }),
            )
        }
    }

    fn call_android(method: &str, mask: i32) -> Result<String, SafeError> {
        use tauri::tao::platform::android::prelude::main_android_context;

        let context = main_android_context().ok_or_else(android_error)?;
        if context.java_vm.is_null() || context.context_jobject.is_null() {
            return Err(android_error());
        }
        let vm =
            unsafe { JavaVM::from_raw(context.java_vm.cast()) }.map_err(|_| android_error())?;
        let mut env = vm.attach_current_thread().map_err(|_| android_error())?;
        let activity = unsafe { JObject::from_raw(context.context_jobject.cast()) };
        let result = if method == "setTuneForgePowerInhibition" {
            env.call_method(
                &activity,
                method,
                "(I)Ljava/lang/String;",
                &[JValue::Int(mask)],
            )
        } else {
            env.call_method(&activity, method, "()Ljava/lang/String;", &[])
        }
        .and_then(|value| value.l());
        std::mem::forget(activity);
        let result = result.map_err(|_| android_error())?;
        let result = jni::objects::JString::from(result);
        env.get_string(&result)
            .map(|value| value.to_string_lossy().into_owned())
            .map_err(|_| android_error())
    }

    fn android_error() -> SafeError {
        SafeError {
            code: "android-inhibition-failed",
            message: "Android power protection could not be updated.",
        }
    }

    pub(super) fn current() -> Box<dyn PlatformInhibitor> {
        Box::<AndroidInhibitor>::default()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
mod platform {
    use super::*;

    struct UnsupportedInhibitor;

    impl PlatformInhibitor for UnsupportedInhibitor {
        fn acquire(
            &mut self,
            _reasons: &[PowerInhibitionReason],
        ) -> Result<Option<PlatformDetails>, SafeError> {
            Ok(None)
        }

        fn release(&mut self) -> Result<(), SafeError> {
            Ok(())
        }
    }

    pub(super) fn current() -> Box<dyn PlatformInhibitor> {
        Box::new(UnsupportedInhibitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct FakeControl {
        acquisitions: Arc<Mutex<Vec<Vec<PowerInhibitionReason>>>>,
        releases: Arc<Mutex<u32>>,
        acquire_error: Arc<Mutex<bool>>,
        release_error: Arc<Mutex<bool>>,
        unsupported: Arc<Mutex<bool>>,
        probes: Arc<Mutex<VecDeque<PlatformProbe>>>,
    }

    struct FakePlatform(FakeControl);

    impl PlatformInhibitor for FakePlatform {
        fn acquire(
            &mut self,
            reasons: &[PowerInhibitionReason],
        ) -> Result<Option<PlatformDetails>, SafeError> {
            self.0.acquisitions.lock().unwrap().push(reasons.to_vec());
            if *self.0.unsupported.lock().unwrap() {
                return Ok(None);
            }
            if *self.0.acquire_error.lock().unwrap() {
                return Err(SafeError {
                    code: "test-acquire-failed",
                    message: "Power protection could not be enabled.",
                });
            }
            Ok(Some(PlatformDetails {
                backend: "test",
                screen_protected: reasons.iter().any(|reason| {
                    matches!(
                        reason,
                        PowerInhibitionReason::Playback | PowerInhibitionReason::TunerCapture
                    )
                }),
                background_protected: true,
            }))
        }

        fn release(&mut self) -> Result<(), SafeError> {
            *self.0.releases.lock().unwrap() += 1;
            if *self.0.release_error.lock().unwrap() {
                return Err(SafeError {
                    code: "test-release-failed",
                    message: "Power protection could not be released.",
                });
            }
            Ok(())
        }

        fn probe(&mut self) -> Option<PlatformProbe> {
            self.0.probes.lock().unwrap().pop_front()
        }
    }

    fn state() -> (PowerInhibitionState, FakeControl) {
        let control = FakeControl::default();
        let state = PowerInhibitionState::with_platform(Box::new(FakePlatform(control.clone())));
        (state, control)
    }

    #[test]
    fn frontend_activity_is_idempotent() {
        let (state, control) = state();
        state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        state
            .set_activity(PowerInhibitionReason::Playback, false)
            .unwrap();
        state
            .set_activity(PowerInhibitionReason::Playback, false)
            .unwrap();

        assert_eq!(*control.releases.lock().unwrap(), 1);
        assert_eq!(control.acquisitions.lock().unwrap().len(), 1);
        assert_eq!(
            state.status().unwrap().phase,
            PowerInhibitionPhase::Inactive
        );
    }

    #[test]
    fn scoped_holds_are_counted_and_reasons_do_not_release_each_other() {
        let (state, control) = state();
        let first = state
            .acquire_scoped(PowerInhibitionReason::SyncTransfer)
            .unwrap();
        let second = state
            .acquire_scoped(PowerInhibitionReason::SyncTransfer)
            .unwrap();
        let listener = state
            .acquire_scoped(PowerInhibitionReason::SyncListener)
            .unwrap();

        drop(first);
        drop(listener);
        assert_eq!(*control.releases.lock().unwrap(), 0);
        assert_eq!(
            state.status().unwrap().active_reasons,
            vec![PowerInhibitionReason::SyncTransfer]
        );
        drop(second);
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn all_four_reasons_hold_shared_protection_until_final_release() {
        let (state, control) = state();
        let tuner = state
            .acquire_scoped(PowerInhibitionReason::TunerCapture)
            .unwrap();
        let transfer = state
            .acquire_scoped(PowerInhibitionReason::SyncTransfer)
            .unwrap();
        state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        state
            .set_activity(PowerInhibitionReason::SyncListener, true)
            .unwrap();

        assert_eq!(
            state.status().unwrap().active_reasons,
            vec![
                PowerInhibitionReason::Playback,
                PowerInhibitionReason::SyncListener,
                PowerInhibitionReason::SyncTransfer,
                PowerInhibitionReason::TunerCapture,
            ]
        );

        drop(tuner);
        state
            .set_activity(PowerInhibitionReason::Playback, false)
            .unwrap();
        drop(transfer);
        assert_eq!(*control.releases.lock().unwrap(), 0);
        assert_eq!(
            state.status().unwrap().active_reasons,
            vec![PowerInhibitionReason::SyncListener]
        );

        state
            .set_activity(PowerInhibitionReason::SyncListener, false)
            .unwrap();
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn acquisition_failure_is_safe_and_retryable() {
        let (state, control) = state();
        *control.acquire_error.lock().unwrap() = true;
        let failed = state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        assert_eq!(failed.phase, PowerInhibitionPhase::Failed);
        assert_eq!(failed.error_code.as_deref(), Some("test-acquire-failed"));
        assert_eq!(failed.backend, None);

        *control.acquire_error.lock().unwrap() = false;
        let active = state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        assert_eq!(active.phase, PowerInhibitionPhase::Active);
    }

    #[test]
    fn failed_acquisition_is_rolled_back_before_retry() {
        let (state, control) = state();
        *control.acquire_error.lock().unwrap() = true;

        let failed = state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        assert_eq!(failed.phase, PowerInhibitionPhase::Failed);

        let inactive = state
            .set_activity(PowerInhibitionReason::Playback, false)
            .unwrap();
        assert_eq!(inactive.phase, PowerInhibitionPhase::Inactive);
        assert_eq!(*control.releases.lock().unwrap(), 1);

        *control.acquire_error.lock().unwrap() = false;
        let active = state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        assert_eq!(active.phase, PowerInhibitionPhase::Active);
        assert_eq!(control.acquisitions.lock().unwrap().len(), 2);
    }

    #[test]
    fn failed_acquisition_release_failure_keeps_attributable_reason() {
        let (state, control) = state();
        *control.acquire_error.lock().unwrap() = true;
        *control.release_error.lock().unwrap() = true;
        state
            .set_activity(PowerInhibitionReason::SyncListener, true)
            .unwrap();

        let failed = state
            .set_activity(PowerInhibitionReason::SyncListener, false)
            .unwrap();

        assert_eq!(failed.phase, PowerInhibitionPhase::ReleaseFailed);
        assert_eq!(
            failed.active_reasons,
            vec![PowerInhibitionReason::SyncListener]
        );
        assert_eq!(*control.releases.lock().unwrap(), 1);
    }

    #[test]
    fn release_failure_preserves_confirmed_state_until_retry() {
        let (state, control) = state();
        state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        *control.release_error.lock().unwrap() = true;
        let failed = state
            .set_activity(PowerInhibitionReason::Playback, false)
            .unwrap();
        assert_eq!(failed.phase, PowerInhibitionPhase::ReleaseFailed);
        assert_eq!(failed.backend.as_deref(), Some("test"));
        assert!(failed.screen_protected);
        assert_eq!(failed.active_reasons, vec![PowerInhibitionReason::Playback]);

        *control.release_error.lock().unwrap() = false;
        state.shutdown();
        assert_eq!(
            state.status().unwrap().phase,
            PowerInhibitionPhase::Inactive
        );
    }

    #[test]
    fn async_release_completes_inactive_without_reporting_lost_protection() {
        let (state, control) = state();
        state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        control.probes.lock().unwrap().extend([
            PlatformProbe {
                details: None,
                error: None,
                pending_phase: Some(PowerInhibitionPhase::Releasing),
                data_sync_timeout_epoch: 0,
            },
            PlatformProbe {
                details: None,
                error: None,
                pending_phase: None,
                data_sync_timeout_epoch: 0,
            },
        ]);

        let releasing = state
            .set_activity(PowerInhibitionReason::Playback, false)
            .unwrap();
        assert_eq!(releasing.phase, PowerInhibitionPhase::Releasing);
        assert_eq!(
            releasing.active_reasons,
            vec![PowerInhibitionReason::Playback]
        );

        let inactive = state.status().unwrap();
        assert_eq!(inactive, PowerInhibitionStatus::default());
    }

    #[test]
    fn unsupported_state_never_claims_protection() {
        let (state, control) = state();
        *control.unsupported.lock().unwrap() = true;
        let status = state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        assert_eq!(status.phase, PowerInhibitionPhase::Unsupported);
        assert!(!status.screen_protected);
        assert!(!status.background_protected);
        assert_eq!(status.backend, None);
    }

    #[test]
    fn android_notification_denial_without_confirmed_mask_never_claims_protection() {
        let probe =
            parse_android_response("failed;0;android-notification-permission-denied;2;0;false")
                .expect("valid Android response");

        assert!(probe.details.is_none());
        let error = probe.error.expect("permission denial");
        assert_eq!(error.code, "android-notification-permission-denied");
        assert_eq!(
            error.message,
            "Android notification permission is unavailable, and power protection is not confirmed."
        );
        assert!(!error.message.contains("protection is active"));
    }

    #[test]
    fn android_tuner_only_reports_activity_screen_without_background_protection() {
        let probe =
            parse_android_response("active;8;none;8;0;true").expect("valid Android response");
        let details = probe.details.expect("confirmed tuner protection");

        assert_eq!(details.backend, "android-activity-screen");
        assert!(details.screen_protected);
        assert!(!details.background_protected);
        assert_eq!(
            android_reason_mask(&[PowerInhibitionReason::TunerCapture]),
            8
        );
    }

    #[test]
    fn android_tuner_with_service_owner_reports_foreground_service() {
        let probe =
            parse_android_response("active;9;none;9;0;true").expect("valid Android response");
        let details = probe.details.expect("confirmed combined protection");

        assert_eq!(details.backend, "android-foreground-service");
        assert!(details.screen_protected);
        assert!(details.background_protected);
    }

    #[test]
    fn shutdown_releases_all_owners() {
        let (state, control) = state();
        let _guard = state
            .acquire_scoped(PowerInhibitionReason::SyncListener)
            .unwrap();
        state
            .set_activity(PowerInhibitionReason::Playback, true)
            .unwrap();
        state.shutdown();
        assert_eq!(*control.releases.lock().unwrap(), 1);
        assert_eq!(
            state.status().unwrap().phase,
            PowerInhibitionPhase::Inactive
        );
    }
}
