use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub const SYSTEM_MEDIA_CONTROL_EVENT: &str = "system-media://control";

#[derive(Clone)]
pub struct SystemMediaState {
    app: AppHandle,
    runtime: Arc<Mutex<SystemMediaRuntime>>,
}

impl SystemMediaState {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            runtime: Arc::new(Mutex::new(SystemMediaRuntime::default())),
        }
    }

    fn update(&self, payload: SystemMediaPayload) -> Result<(), String> {
        platform::update_media_state(&self.app, &payload)?;
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "System media state is unavailable.".to_string())?;
        runtime.current = Some(payload);
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        platform::clear_media_state(&self.app)?;
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "System media state is unavailable.".to_string())?;
        runtime.current = None;
        Ok(())
    }
}

#[derive(Default)]
struct SystemMediaRuntime {
    current: Option<SystemMediaPayload>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMediaPayload {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub playback_state: SystemMediaPlaybackState,
    pub duration_seconds: Option<f64>,
    pub position_seconds: Option<f64>,
    pub playback_rate: Option<f64>,
    pub can_seek: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemMediaPlaybackState {
    None,
    Playing,
    Paused,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMediaControlPayload {
    pub action: SystemMediaControlAction,
    pub position_seconds: Option<f64>,
    pub seek_offset_seconds: Option<f64>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemMediaControlAction {
    Play,
    Pause,
    PlayPause,
    Stop,
    SeekBackward,
    SeekForward,
    SeekTo,
}

pub fn emit_control(
    app: &AppHandle,
    action: SystemMediaControlAction,
    position_seconds: Option<f64>,
    seek_offset_seconds: Option<f64>,
) {
    let _ = app.emit(
        SYSTEM_MEDIA_CONTROL_EVENT,
        SystemMediaControlPayload {
            action,
            position_seconds,
            seek_offset_seconds,
        },
    );
}

#[tauri::command]
pub fn system_media_update_state(
    state: State<'_, SystemMediaState>,
    payload: SystemMediaPayload,
) -> Result<(), String> {
    state.update(payload)
}

#[tauri::command]
pub fn system_media_clear_state(state: State<'_, SystemMediaState>) -> Result<(), String> {
    state.clear()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{
        emit_control, SystemMediaControlAction, SystemMediaPayload, SystemMediaPlaybackState,
    };
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSMutableDictionary, NSNumber, NSObject, NSString};
    use std::sync::Once;
    use tauri::AppHandle;

    #[link(name = "MediaPlayer", kind = "framework")]
    extern "C" {}

    static REGISTER_REMOTE_COMMANDS: Once = Once::new();

    pub fn update_media_state(app: &AppHandle, payload: &SystemMediaPayload) -> Result<(), String> {
        register_remote_commands(app);
        unsafe {
            set_remote_commands_enabled(true, payload.can_seek);
            let center: *mut AnyObject = msg_send![class!(MPNowPlayingInfoCenter), defaultCenter];
            if center.is_null() {
                return Err("macOS Now Playing center is unavailable.".to_string());
            }
            let info = NSMutableDictionary::<NSString, NSObject>::new();
            insert_string(&info, "title", &payload.title);
            insert_string(&info, "artist", &payload.artist);
            if let Some(album) = &payload.album {
                insert_string(&info, "albumTitle", album);
            }
            if let Some(duration_seconds) = finite_non_negative(payload.duration_seconds) {
                insert_number(&info, "playbackDuration", duration_seconds);
            }
            if let Some(position_seconds) = finite_non_negative(payload.position_seconds) {
                insert_number(&info, "elapsedPlaybackTime", position_seconds);
            }
            let playback_rate = match payload.playback_state {
                SystemMediaPlaybackState::Playing => payload.playback_rate.unwrap_or(1.0),
                SystemMediaPlaybackState::Paused | SystemMediaPlaybackState::None => 0.0,
            };
            insert_number(&info, "playbackRate", playback_rate);
            let _: () = msg_send![center, setNowPlayingInfo: &*info];
            let playback_state = match payload.playback_state {
                SystemMediaPlaybackState::None => 0isize,
                SystemMediaPlaybackState::Playing => 1isize,
                SystemMediaPlaybackState::Paused => 2isize,
            };
            let _: () = msg_send![center, setPlaybackState: playback_state];
        }
        Ok(())
    }

    pub fn clear_media_state(app: &AppHandle) -> Result<(), String> {
        register_remote_commands(app);
        unsafe {
            set_remote_commands_enabled(false, false);
            let center: *mut AnyObject = msg_send![class!(MPNowPlayingInfoCenter), defaultCenter];
            if center.is_null() {
                return Ok(());
            }
            let nil_info: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![center, setNowPlayingInfo: nil_info];
            let _: () = msg_send![center, setPlaybackState: 0isize];
        }
        Ok(())
    }

    fn finite_non_negative(value: Option<f64>) -> Option<f64> {
        value.filter(|next| next.is_finite() && *next >= 0.0)
    }

    unsafe fn insert_string(
        info: &NSMutableDictionary<NSString, NSObject>,
        key: &str,
        value: &str,
    ) {
        let key = NSString::from_str(key);
        let value = NSString::from_str(value).into_super();
        info.insert(&*key, &*value);
    }

    unsafe fn insert_number(info: &NSMutableDictionary<NSString, NSObject>, key: &str, value: f64) {
        let key = NSString::from_str(key);
        let value = NSNumber::new_f64(value).into_super();
        info.insert(&*key, &*value);
    }

    fn register_remote_commands(app: &AppHandle) {
        let app = app.clone();
        REGISTER_REMOTE_COMMANDS.call_once(move || unsafe {
            let center: *mut AnyObject =
                msg_send![class!(MPRemoteCommandCenter), sharedCommandCenter];
            if center.is_null() {
                return;
            }

            let play_command: *mut AnyObject = msg_send![center, playCommand];
            add_command_handler(
                play_command,
                app.clone(),
                SystemMediaControlAction::Play,
                None,
            );

            let pause_command: *mut AnyObject = msg_send![center, pauseCommand];
            add_command_handler(
                pause_command,
                app.clone(),
                SystemMediaControlAction::Pause,
                None,
            );

            let toggle_command: *mut AnyObject = msg_send![center, togglePlayPauseCommand];
            add_command_handler(
                toggle_command,
                app.clone(),
                SystemMediaControlAction::PlayPause,
                None,
            );

            let stop_command: *mut AnyObject = msg_send![center, stopCommand];
            add_command_handler(
                stop_command,
                app.clone(),
                SystemMediaControlAction::Stop,
                None,
            );

            let backward_command: *mut AnyObject = msg_send![center, seekBackwardCommand];
            add_command_handler(
                backward_command,
                app.clone(),
                SystemMediaControlAction::SeekBackward,
                Some(10.0),
            );

            let forward_command: *mut AnyObject = msg_send![center, seekForwardCommand];
            add_command_handler(
                forward_command,
                app.clone(),
                SystemMediaControlAction::SeekForward,
                Some(10.0),
            );

            let skip_backward_command: *mut AnyObject = msg_send![center, skipBackwardCommand];
            add_skip_command_handler(
                skip_backward_command,
                app.clone(),
                SystemMediaControlAction::SeekBackward,
            );

            let skip_forward_command: *mut AnyObject = msg_send![center, skipForwardCommand];
            add_skip_command_handler(
                skip_forward_command,
                app.clone(),
                SystemMediaControlAction::SeekForward,
            );

            let previous_command: *mut AnyObject = msg_send![center, previousTrackCommand];
            add_command_handler(
                previous_command,
                app.clone(),
                SystemMediaControlAction::SeekBackward,
                Some(10.0),
            );

            let next_command: *mut AnyObject = msg_send![center, nextTrackCommand];
            add_command_handler(
                next_command,
                app.clone(),
                SystemMediaControlAction::SeekForward,
                Some(10.0),
            );

            let position_command: *mut AnyObject = msg_send![center, changePlaybackPositionCommand];
            if !position_command.is_null() {
                let _: () = msg_send![position_command, setEnabled: true];
                let block = RcBlock::new(move |event: *mut AnyObject| -> isize {
                    if event.is_null() {
                        return 0;
                    }
                    let position_seconds: f64 = msg_send![event, positionTime];
                    emit_control(
                        &app,
                        SystemMediaControlAction::SeekTo,
                        Some(position_seconds),
                        None,
                    );
                    0
                });
                let block = RcBlock::into_raw(block);
                let _: *mut AnyObject = msg_send![position_command, addTargetWithHandler: block];
            }

            set_remote_commands_enabled(false, false);
        });
    }

    unsafe fn add_command_handler(
        command: *mut AnyObject,
        app: AppHandle,
        action: SystemMediaControlAction,
        seek_offset_seconds: Option<f64>,
    ) {
        if command.is_null() {
            return;
        }
        let _: () = msg_send![command, setEnabled: true];
        let block = RcBlock::new(move |_event: *mut AnyObject| -> isize {
            emit_control(&app, action, None, seek_offset_seconds);
            0
        });
        let block = RcBlock::into_raw(block);
        let _: *mut AnyObject = msg_send![command, addTargetWithHandler: block];
    }

    unsafe fn add_skip_command_handler(
        command: *mut AnyObject,
        app: AppHandle,
        action: SystemMediaControlAction,
    ) {
        if command.is_null() {
            return;
        }
        let _: () = msg_send![command, setEnabled: true];
        let interval = NSNumber::new_f64(10.0);
        let intervals: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: &*interval];
        let _: () = msg_send![command, setPreferredIntervals: intervals];
        let block = RcBlock::new(move |event: *mut AnyObject| -> isize {
            let interval = if event.is_null() {
                10.0
            } else {
                let value: f64 = msg_send![event, interval];
                if value.is_finite() && value > 0.0 {
                    value
                } else {
                    10.0
                }
            };
            emit_control(&app, action, None, Some(interval));
            0
        });
        let block = RcBlock::into_raw(block);
        let _: *mut AnyObject = msg_send![command, addTargetWithHandler: block];
    }

    unsafe fn set_remote_commands_enabled(enabled: bool, can_seek: bool) {
        let center: *mut AnyObject = msg_send![class!(MPRemoteCommandCenter), sharedCommandCenter];
        if center.is_null() {
            return;
        }
        let play_command: *mut AnyObject = msg_send![center, playCommand];
        set_command_enabled(play_command, enabled);
        let pause_command: *mut AnyObject = msg_send![center, pauseCommand];
        set_command_enabled(pause_command, enabled);
        let toggle_command: *mut AnyObject = msg_send![center, togglePlayPauseCommand];
        set_command_enabled(toggle_command, enabled);
        let stop_command: *mut AnyObject = msg_send![center, stopCommand];
        set_command_enabled(stop_command, enabled);
        let backward_command: *mut AnyObject = msg_send![center, seekBackwardCommand];
        set_command_enabled(backward_command, enabled && can_seek);
        let forward_command: *mut AnyObject = msg_send![center, seekForwardCommand];
        set_command_enabled(forward_command, enabled && can_seek);
        let skip_backward_command: *mut AnyObject = msg_send![center, skipBackwardCommand];
        set_command_enabled(skip_backward_command, enabled && can_seek);
        let skip_forward_command: *mut AnyObject = msg_send![center, skipForwardCommand];
        set_command_enabled(skip_forward_command, enabled && can_seek);
        let previous_command: *mut AnyObject = msg_send![center, previousTrackCommand];
        set_command_enabled(previous_command, enabled && can_seek);
        let next_command: *mut AnyObject = msg_send![center, nextTrackCommand];
        set_command_enabled(next_command, enabled && can_seek);
        let position_command: *mut AnyObject = msg_send![center, changePlaybackPositionCommand];
        set_command_enabled(position_command, enabled && can_seek);
    }

    unsafe fn set_command_enabled(command: *mut AnyObject, enabled: bool) {
        if command.is_null() {
            return;
        }
        let _: () = msg_send![command, setEnabled: enabled];
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{
        emit_control, SystemMediaControlAction, SystemMediaPayload, SystemMediaPlaybackState,
    };
    use dbus::arg::{PropMap, RefArg, Variant};
    use dbus::blocking::Connection;
    use dbus::channel::{default_reply, MatchingReceiver, Sender};
    use dbus::message::MatchRule;
    use dbus::Message;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tauri::AppHandle;

    const MPRIS_BUS_NAME: &str = "org.mpris.MediaPlayer2.tuneforge";
    const MPRIS_OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";
    const MPRIS_ROOT_INTERFACE: &str = "org.mpris.MediaPlayer2";
    const MPRIS_PLAYER_INTERFACE: &str = "org.mpris.MediaPlayer2.Player";
    const DBUS_PROPERTIES_INTERFACE: &str = "org.freedesktop.DBus.Properties";
    const DBUS_INTROSPECTABLE_INTERFACE: &str = "org.freedesktop.DBus.Introspectable";

    static MPRIS_RUNTIME: Mutex<Option<Arc<MprisRuntime>>> = Mutex::new(None);

    #[derive(Clone)]
    struct MprisRuntime {
        state: Arc<Mutex<Option<SystemMediaPayload>>>,
        active: Arc<AtomicBool>,
    }

    pub fn update_media_state(app: &AppHandle, payload: &SystemMediaPayload) -> Result<(), String> {
        let runtime = ensure_mpris_runtime(app)?;
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| "Linux MPRIS state is unavailable.".to_string())?;
        *state = Some(payload.clone());
        runtime.active.store(true, Ordering::Release);
        Ok(())
    }

    pub fn clear_media_state(app: &AppHandle) -> Result<(), String> {
        let runtime = ensure_mpris_runtime(app)?;
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| "Linux MPRIS state is unavailable.".to_string())?;
        *state = None;
        runtime.active.store(false, Ordering::Release);
        Ok(())
    }

    fn ensure_mpris_runtime(app: &AppHandle) -> Result<Arc<MprisRuntime>, String> {
        let mut guard = MPRIS_RUNTIME
            .lock()
            .map_err(|_| "Linux MPRIS runtime is unavailable.".to_string())?;
        if let Some(runtime) = guard.as_ref() {
            return Ok(runtime.clone());
        }

        let runtime = Arc::new(MprisRuntime {
            state: Arc::new(Mutex::new(None)),
            active: Arc::new(AtomicBool::new(false)),
        });
        start_mpris_thread(app.clone(), runtime.clone())?;
        *guard = Some(runtime.clone());
        Ok(runtime)
    }

    fn start_mpris_thread(app: AppHandle, runtime: Arc<MprisRuntime>) -> Result<(), String> {
        let connection =
            Connection::new_session().map_err(|error| format!("D-Bus unavailable: {error}"))?;
        connection
            .request_name(MPRIS_BUS_NAME, false, true, false)
            .map_err(|error| format!("Could not register MPRIS player: {error}"))?;

        let state = runtime.state.clone();
        let active = runtime.active.clone();
        let mut rule = MatchRule::new_method_call();
        rule.path = Some(MPRIS_OBJECT_PATH.into());
        connection.start_receive(
            rule,
            Box::new(move |message, connection| {
                if !handle_mpris_message(&app, &state, &active, &message, connection) {
                    if let Some(reply) = default_reply(&message) {
                        let _ = connection.send(reply);
                    }
                }
                true
            }),
        );

        thread::spawn(move || loop {
            if connection.process(Duration::from_millis(1000)).is_err() {
                break;
            }
        });

        Ok(())
    }

    fn handle_mpris_message(
        app: &AppHandle,
        state: &Arc<Mutex<Option<SystemMediaPayload>>>,
        active: &Arc<AtomicBool>,
        message: &Message,
        connection: &Connection,
    ) -> bool {
        let interface = message.interface().map(|value| value.to_string());
        let member = message.member().map(|value| value.to_string());

        match (interface.as_deref(), member.as_deref()) {
            (Some(MPRIS_ROOT_INTERFACE), Some("Raise" | "Quit")) => {
                send_reply(connection, message.method_return());
                true
            }
            (Some(MPRIS_PLAYER_INTERFACE), Some(method)) => {
                handle_player_method(app, active, message, connection, method);
                true
            }
            (Some(DBUS_PROPERTIES_INTERFACE), Some("Get")) => {
                handle_properties_get(state, active, message, connection);
                true
            }
            (Some(DBUS_PROPERTIES_INTERFACE), Some("GetAll")) => {
                handle_properties_get_all(state, active, message, connection);
                true
            }
            (Some(DBUS_PROPERTIES_INTERFACE), Some("Set")) => {
                send_reply(connection, message.method_return());
                true
            }
            (Some(DBUS_INTROSPECTABLE_INTERFACE), Some("Introspect")) => {
                send_reply(
                    connection,
                    message.method_return().append1(INTROSPECTION_XML),
                );
                true
            }
            _ => false,
        }
    }

    fn handle_player_method(
        app: &AppHandle,
        active: &Arc<AtomicBool>,
        message: &Message,
        connection: &Connection,
        method: &str,
    ) {
        if !active.load(Ordering::Acquire) {
            send_reply(connection, message.method_return());
            return;
        }

        match method {
            "Play" => emit_control(app, SystemMediaControlAction::Play, None, None),
            "Pause" => emit_control(app, SystemMediaControlAction::Pause, None, None),
            "PlayPause" => emit_control(app, SystemMediaControlAction::PlayPause, None, None),
            "Stop" => emit_control(app, SystemMediaControlAction::Stop, None, None),
            "Seek" => {
                if let Some(offset_microseconds) = message.get1::<i64>() {
                    let offset_seconds = (offset_microseconds as f64) / 1_000_000.0;
                    let action = if offset_seconds >= 0.0 {
                        SystemMediaControlAction::SeekForward
                    } else {
                        SystemMediaControlAction::SeekBackward
                    };
                    emit_control(app, action, None, Some(offset_seconds.abs()));
                }
            }
            "SetPosition" => {
                let (_, position_microseconds): (Option<dbus::Path<'_>>, Option<i64>) =
                    message.get2();
                if let Some(position_microseconds) = position_microseconds {
                    emit_control(
                        app,
                        SystemMediaControlAction::SeekTo,
                        Some((position_microseconds as f64) / 1_000_000.0),
                        None,
                    );
                }
            }
            "Next" => emit_control(app, SystemMediaControlAction::SeekForward, None, Some(10.0)),
            "Previous" => emit_control(
                app,
                SystemMediaControlAction::SeekBackward,
                None,
                Some(10.0),
            ),
            "OpenUri" => {}
            _ => {}
        }
        send_reply(connection, message.method_return());
    }

    fn handle_properties_get(
        state: &Arc<Mutex<Option<SystemMediaPayload>>>,
        active: &Arc<AtomicBool>,
        message: &Message,
        connection: &Connection,
    ) {
        let (interface, property): (Option<String>, Option<String>) = message.get2();
        let state = snapshot_state(state);
        let Some(value) = property_value(
            interface.as_deref(),
            property.as_deref(),
            state.as_ref(),
            active.load(Ordering::Acquire),
        ) else {
            send_reply(connection, message.method_return());
            return;
        };
        send_reply(connection, message.method_return().append1(value));
    }

    fn handle_properties_get_all(
        state: &Arc<Mutex<Option<SystemMediaPayload>>>,
        active: &Arc<AtomicBool>,
        message: &Message,
        connection: &Connection,
    ) {
        let interface = message.get1::<String>();
        let state = snapshot_state(state);
        let props = properties_for_interface(
            interface.as_deref(),
            state.as_ref(),
            active.load(Ordering::Acquire),
        );
        send_reply(connection, message.method_return().append1(props));
    }

    fn snapshot_state(
        state: &Arc<Mutex<Option<SystemMediaPayload>>>,
    ) -> Option<SystemMediaPayload> {
        state.lock().ok().and_then(|guard| guard.clone())
    }

    fn properties_for_interface(
        interface: Option<&str>,
        state: Option<&SystemMediaPayload>,
        active: bool,
    ) -> PropMap {
        match interface {
            Some(MPRIS_ROOT_INTERFACE) => root_properties(),
            Some(MPRIS_PLAYER_INTERFACE) => player_properties(state, active),
            _ => PropMap::new(),
        }
    }

    fn property_value(
        interface: Option<&str>,
        property: Option<&str>,
        state: Option<&SystemMediaPayload>,
        active: bool,
    ) -> Option<Variant<Box<dyn RefArg>>> {
        properties_for_interface(interface, state, active).remove(property?)
    }

    fn root_properties() -> PropMap {
        let mut props = PropMap::new();
        props.insert("CanQuit".into(), variant(false));
        props.insert("CanRaise".into(), variant(false));
        props.insert("HasTrackList".into(), variant(false));
        props.insert("Identity".into(), variant("TuneForge".to_string()));
        props.insert("DesktopEntry".into(), variant("tuneforge".to_string()));
        props.insert("SupportedUriSchemes".into(), variant(Vec::<String>::new()));
        props.insert("SupportedMimeTypes".into(), variant(Vec::<String>::new()));
        props
    }

    fn player_properties(state: Option<&SystemMediaPayload>, active: bool) -> PropMap {
        let mut props = PropMap::new();
        let can_seek = active && state.is_some_and(|payload| payload.can_seek);
        props.insert(
            "PlaybackStatus".into(),
            variant(playback_status(state, active).to_string()),
        );
        props.insert("Metadata".into(), variant(metadata(state)));
        props.insert("Rate".into(), variant(1.0f64));
        props.insert("MinimumRate".into(), variant(1.0f64));
        props.insert("MaximumRate".into(), variant(1.0f64));
        props.insert("CanGoNext".into(), variant(false));
        props.insert("CanGoPrevious".into(), variant(false));
        props.insert("CanPlay".into(), variant(active));
        props.insert("CanPause".into(), variant(active));
        props.insert("CanSeek".into(), variant(can_seek));
        props.insert("CanControl".into(), variant(active));
        props
    }

    fn metadata(state: Option<&SystemMediaPayload>) -> PropMap {
        let mut metadata = PropMap::new();
        metadata.insert(
            "mpris:trackid".into(),
            variant(dbus::Path::from(MPRIS_OBJECT_PATH)),
        );
        let Some(payload) = state else {
            return metadata;
        };
        metadata.insert("xesam:title".into(), variant(payload.title.clone()));
        metadata.insert("xesam:artist".into(), variant(vec![payload.artist.clone()]));
        if let Some(album) = &payload.album {
            metadata.insert("xesam:album".into(), variant(album.clone()));
        }
        if let Some(duration_seconds) = finite_non_negative(payload.duration_seconds) {
            metadata.insert(
                "mpris:length".into(),
                variant((duration_seconds * 1_000_000.0) as i64),
            );
        }
        metadata
    }

    fn playback_status(state: Option<&SystemMediaPayload>, active: bool) -> &'static str {
        if !active {
            return "Stopped";
        }
        match state.map(|payload| payload.playback_state) {
            Some(SystemMediaPlaybackState::Playing) => "Playing",
            Some(SystemMediaPlaybackState::Paused) => "Paused",
            Some(SystemMediaPlaybackState::None) | None => "Stopped",
        }
    }

    fn finite_non_negative(value: Option<f64>) -> Option<f64> {
        value.filter(|next| next.is_finite() && *next >= 0.0)
    }

    fn variant<T: RefArg + 'static>(value: T) -> Variant<Box<dyn RefArg>> {
        Variant(Box::new(value))
    }

    fn send_reply(connection: &Connection, message: Message) {
        let _ = connection.send(message);
    }

    const INTROSPECTION_XML: &str = r#"
<node>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect">
      <arg name="xml_data" type="s" direction="out"/>
    </method>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="property_name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="GetAll">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="properties" type="a{sv}" direction="out"/>
    </method>
    <method name="Set">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="property_name" type="s" direction="in"/>
      <arg name="value" type="v" direction="in"/>
    </method>
  </interface>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg name="Offset" type="x" direction="in"/>
    </method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <method name="OpenUri">
      <arg name="Uri" type="s" direction="in"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>
"#;
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::SystemMediaPayload;
    use tauri::AppHandle;

    pub fn update_media_state(app: &AppHandle, payload: &SystemMediaPayload) -> Result<(), String> {
        let _ = (app, payload);
        Ok(())
    }

    pub fn clear_media_state(app: &AppHandle) -> Result<(), String> {
        let _ = app;
        Ok(())
    }
}
