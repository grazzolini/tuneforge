# Power Protection

TuneForge power protection is the shared wake, sleep, and idle-inhibition model used while
confirmed playback, tuner capture, or sync work is active. It is automatic; there is no user-facing
toggle.

Power protection prevents supported devices from sleeping, dimming, or suspending active work while
TuneForge has a confirmed owner. It does not promise background microphone capture on platforms that
do not support it, does not keep work alive after the final owner exits, and does not replace normal
platform permission or notification rules.

## Ownership Model

TuneForge tracks power protection through counted owners:

- `playback`: confirmed native or Web Audio playback.
- `tuner-capture`: confirmed native or Web Audio tuner capture.
- `sync-listener`: active sync listener.
- `sync-transfer`: active sync transfer.

Pending user intent, permission prompts, native prepare work, and failed starts do not acquire
protection. Stop, interruption, suspension, natural end, fallback, transfer completion,
cancellation, failure, and app shutdown release only the corresponding owner. Shared protection
releases after the final owner exits.

Native fallback is an explicit ownership transfer. TuneForge clears native playback ownership from
system media state and power protection before starting Web Audio at the fallback position, then
reacquires the browser wake lock after Web playback is confirmed. Other active owners continue to
hold shared protection.

## Platform Matrix

| Platform or path | Backend label | Screen protected | Background protected | Notes |
| --- | --- | --- | --- | --- |
| macOS native | `macos-iopm` | Yes | Yes | Uses an IOPM display sleep assertion while confirmed work is active. |
| Linux native portal | `xdg-desktop-portal` | Yes | Yes | Preferred Linux path when the desktop portal accepts inhibition. |
| Linux native logind | `systemd-logind` | Yes | Yes | Fallback path through `org.freedesktop.login1`; TuneForge passes `sleep:idle`, `TuneForge`, the active-work reason, and `block`. |
| Android tuner-only | `android-activity-screen` | Yes | No | Keeps the visible Activity screen on through `keepScreenOn`; no foreground service, notification, or partial wake lock. |
| Android playback or sync | `android-foreground-service` | Playback or transfer only | Yes | Uses foreground-service ownership for playback and sync work; sync listener/transfer also hold a bounded renewable partial wake lock. |
| Browser playback or tuner | `browser-screen-wake-lock` | Yes | No | Uses the browser Screen Wake Lock API for confirmed Web Audio owners only. |

Android playback uses a `mediaPlayback` foreground service and keeps the foreground Activity screen
on. An active sync listener uses `connectedDevice`; an active transfer also uses `dataSync`.
Playback and transfer keep the foreground Activity screen on when visible; listener-only sync does
not claim screen protection. Playback relies on Android's media path for CPU wakefulness, while
listener and transfer work hold a bounded renewable partial wake lock. Android 15 `dataSync` timeout
is reported as a power-protection failure, clears the transfer reason, and does not mark the
transfer complete.

On Android 13 and newer, TuneForge requests notification permission only when a user action starts
protected playback or sync work. Denial does not cancel that work; diagnostics report missing
notification visibility while Android's system active-app controls remain available. Tuner-only work
never requests notification permission.

## Diagnostics

Settings -> Local Data -> Show diagnostics reports:

- current power-protection phase: acquiring, active, unsupported, failed, releasing, or
  `release-failed` shown as Release not confirmed;
- confirmed backend;
- active reasons;
- separately confirmed screen and background coverage;
- latest safe power-protection error;
- last confirmed native backend remembered across reload.

Active power state is never restored from local storage. Only a safe historical backend and safe
historical error may survive reload. Reliability warnings for unsupported or failed protection do
not change playback, capture, or sync truth.

## Validation

Manual validation must record platform, OS version, desktop/session when applicable, package type,
backend label, active reasons, and release path.

For each owner being validated:

1. Confirm there is no stale inhibitor, wake lock, or foreground-service entry before the start.
2. Start the work and wait for the relevant TuneForge owner to be confirmed.
3. Verify diagnostics show the expected backend, phase, owner reasons, and screen/background
   coverage.
4. Verify platform evidence while work is active.
5. Stop through every relevant terminal path and verify diagnostics return to inactive after the
   final owner exits.
6. Repeat one start/stop cycle to catch leaked handles.

Recommended platform evidence:

- macOS: inspect `pmset` inhibition state while confirmed native work is active and after release.
- Linux: inspect desktop portal or `systemd-inhibit --list --mode=block --no-pager` evidence while
  confirmed native work is active and after release.
- Android: inspect foreground-service type, notification copy, screen state, and wake-lock behavior
  with `adb`.
- Browser/Web Audio: verify browser Screen Wake Lock activation and release through diagnostics and
  visible screen behavior.

Local unit tests prove TuneForge ownership transitions. They do not prove live OS handle behavior,
portal behavior, Flatpak mediation, Android foreground-service behavior, or device power policy.

## Linux Flatpak Attribution

When the Linux Flatpak falls back to `systemd-logind`, host tools may show `COMM=xdg-dbus-proxy`.
This is expected because Flatpak mediates DBus access through its proxy. Treat the run as valid when
all of these are true:

- `WHO=TuneForge`;
- `WHAT=sleep:idle`;
- `WHY` matches TuneForge active work;
- `MODE=block`;
- TuneForge diagnostics report `systemd-logind` and the expected owner state;
- the inhibitor releases after pause, stop, fallback, natural end, failure, or app exit.

Do not add host helpers, broader DBus access, telemetry, or new services only to change the host
diagnostic `COMM` column.
