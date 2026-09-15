#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_MAIN="$ROOT_DIR/apps/desktop/src-tauri/gen/android/app/src/main"
ANDROID_RES="$ANDROID_MAIN/res"
ANDROID_ICONS="$ROOT_DIR/apps/desktop/src-tauri/target/android-icons/android"
MANIFEST="$ANDROID_MAIN/AndroidManifest.xml"
MAIN_ACTIVITY="$ANDROID_MAIN/java/com/tuneforge/desktop/MainActivity.kt"
POWER_SERVICE="$ANDROID_MAIN/java/com/tuneforge/desktop/PowerInhibitionService.kt"
MODEL_ASSET_DESCRIPTOR="$ANDROID_MAIN/java/com/tuneforge/desktop/ModelAssetDescriptor.java"
BEAT_THIS_RUNNER="$ANDROID_MAIN/java/com/tuneforge/desktop/BeatThisRunner.java"
CREMA_RUNNER="$ANDROID_MAIN/java/com/tuneforge/desktop/CremaRunner.java"
INFERENCE_LOCK="$ANDROID_MAIN/java/com/tuneforge/desktop/InferenceLock.java"
ANDROID_JAVA_SOURCE="$ROOT_DIR/apps/desktop/src-tauri/android/java/com/tuneforge/desktop"
MODEL_ASSET_DESCRIPTOR_SOURCE="$ANDROID_JAVA_SOURCE/ModelAssetDescriptor.java"
BEAT_THIS_RUNNER_SOURCE="$ANDROID_JAVA_SOURCE/BeatThisRunner.java"
CREMA_RUNNER_SOURCE="$ANDROID_JAVA_SOURCE/CremaRunner.java"
INFERENCE_LOCK_SOURCE="$ANDROID_JAVA_SOURCE/InferenceLock.java"
ANDROID_KOTLIN_SOURCE="$ROOT_DIR/apps/desktop/src-tauri/android/kotlin/com/tuneforge/desktop"
MAIN_ACTIVITY_SOURCE="$ANDROID_KOTLIN_SOURCE/MainActivity.kt"
POWER_SERVICE_SOURCE="$ANDROID_KOTLIN_SOURCE/PowerInhibitionService.kt"
APP_GRADLE="$ROOT_DIR/apps/desktop/src-tauri/gen/android/app/build.gradle.kts"
PROGUARD_RULES="$ROOT_DIR/apps/desktop/src-tauri/proguard-tuneforge.pro"
PROGUARD_DEST="$ROOT_DIR/apps/desktop/src-tauri/gen/android/app/proguard-tuneforge.pro"
FFMPEG_ROOT="${TUNEFORGE_ANDROID_FFMPEG_ROOT:?TUNEFORGE_ANDROID_FFMPEG_ROOT is required}"
FFMPEG_JNI_DIR="$ANDROID_MAIN/jniLibs/arm64-v8a"
FFMPEG_ASSET_DIR="$ANDROID_MAIN/assets/ffmpeg"
SOXR_ROOT="${TUNEFORGE_ANDROID_SOXR_ROOT:?TUNEFORGE_ANDROID_SOXR_ROOT is required}"
SOXR_ASSET_DIR="$ANDROID_MAIN/assets/soxr"

if [[ ! -f "$MANIFEST" || ! -f "$MAIN_ACTIVITY" || ! -d "$ANDROID_RES" ]]; then
  echo "Android project is not initialized. Run pnpm --filter @tuneforge/desktop tauri android init first." >&2
  exit 1
fi

if [[ ! -f "$PROGUARD_RULES" ]]; then
  echo "TuneForge Android ProGuard rules are missing at $PROGUARD_RULES" >&2
  exit 1
fi

cp "$PROGUARD_RULES" "$PROGUARD_DEST"

copy_owned_ffmpeg_runtime() {
  local required=(libavcodec.so libavfilter.so libavformat.so libavutil.so libswresample.so libmp3lame.so)
  mkdir -p "$FFMPEG_JNI_DIR" "$FFMPEG_ASSET_DIR/licenses"
  find "$FFMPEG_JNI_DIR" -maxdepth 1 -type f \( -name 'libav*.so' -o -name 'libswresample.so' -o -name 'libmp3lame.so' \) -delete
  local library
  for library in "${required[@]}"; do
    if [[ ! -f "$FFMPEG_ROOT/lib/$library" ]]; then
      echo "Verified Android FFmpeg library missing: $FFMPEG_ROOT/lib/$library" >&2
      exit 1
    fi
    cp "$FFMPEG_ROOT/lib/$library" "$FFMPEG_JNI_DIR/$library"
  done
  cp "$FFMPEG_ROOT/provenance.json" "$FFMPEG_ASSET_DIR/provenance.json"
  cp "$FFMPEG_ROOT/licenses/"*.txt "$FFMPEG_ASSET_DIR/licenses/"
}

copy_owned_ffmpeg_runtime

copy_owned_soxr_runtime() {
  if [[ ! -f "$SOXR_ROOT/lib/libsoxr.so" || ! -f "$SOXR_ROOT/provenance.json" ]]; then
    echo "Verified Android libsoxr runtime is incomplete: $SOXR_ROOT" >&2
    exit 1
  fi
  if ! grep -Fq '"-DWITH_PFFFT=ON"' "$SOXR_ROOT/provenance.json"; then
    echo "Verified Android libsoxr runtime does not use the required PFFFT profile: $SOXR_ROOT" >&2
    exit 1
  fi
  mkdir -p "$FFMPEG_JNI_DIR" "$SOXR_ASSET_DIR/licenses"
  cp "$SOXR_ROOT/lib/libsoxr.so" "$FFMPEG_JNI_DIR/libsoxr.so"
  cp "$SOXR_ROOT/provenance.json" "$SOXR_ASSET_DIR/provenance.json"
  cp "$SOXR_ROOT/licenses/"*.txt "$SOXR_ASSET_DIR/licenses/"
}

copy_owned_soxr_runtime

ensure_executorch_dependency() {
  if grep -Fq 'implementation("org.pytorch:executorch-android:1.4.0")' "$APP_GRADLE"; then
    return
  fi
  local temp_file
  temp_file="$(mktemp)"
  awk '
    !inserted && /^[[:space:]]*dependencies[[:space:]]*\{/ {
      print
      print "    implementation(\"org.pytorch:executorch-android:1.4.0\")"
      inserted = 1
      next
    }
    { print }
    END { if (!inserted) exit 42 }
  ' "$APP_GRADLE" > "$temp_file" || {
    rm -f "$temp_file"
    echo "Could not add the ExecuTorch Android dependency." >&2
    exit 1
  }
  mv "$temp_file" "$APP_GRADLE"
}

ensure_executorch_dependency

ensure_onnxruntime_dependency() {
  if grep -Fq 'implementation("com.microsoft.onnxruntime:onnxruntime-android:1.29.0")' "$APP_GRADLE"; then
    return
  fi
  local temp_file
  temp_file="$(mktemp)"
  awk '
    !inserted && /^[[:space:]]*dependencies[[:space:]]*\{/ {
      print
      print "    implementation(\"com.microsoft.onnxruntime:onnxruntime-android:1.29.0\")"
      inserted = 1
      next
    }
    { print }
    END { if (!inserted) exit 42 }
  ' "$APP_GRADLE" > "$temp_file" || {
    rm -f "$temp_file"
    echo "Could not add the ONNX Runtime Android dependency." >&2
    exit 1
  }
  mv "$temp_file" "$APP_GRADLE"
}

ensure_onnxruntime_dependency

cp "$MODEL_ASSET_DESCRIPTOR_SOURCE" "$MODEL_ASSET_DESCRIPTOR"
cp "$BEAT_THIS_RUNNER_SOURCE" "$BEAT_THIS_RUNNER"
cp "$CREMA_RUNNER_SOURCE" "$CREMA_RUNNER"
cp "$INFERENCE_LOCK_SOURCE" "$INFERENCE_LOCK"
cp "$MAIN_ACTIVITY_SOURCE" "$MAIN_ACTIVITY"
cp "$POWER_SERVICE_SOURCE" "$POWER_SERVICE"

copy_android_icons() {
  if [[ ! -d "$ANDROID_ICONS" ]]; then
    echo "Android icon output is missing at $ANDROID_ICONS. Run pnpm --filter @tuneforge/desktop android:icons first." >&2
    exit 1
  fi

  local required_paths=(
    "$ANDROID_ICONS/mipmap-mdpi"
    "$ANDROID_ICONS/mipmap-hdpi"
    "$ANDROID_ICONS/mipmap-xhdpi"
    "$ANDROID_ICONS/mipmap-xxhdpi"
    "$ANDROID_ICONS/mipmap-xxxhdpi"
    "$ANDROID_ICONS/mipmap-anydpi-v26"
    "$ANDROID_ICONS/values/ic_launcher_background.xml"
  )

  local required_path
  for required_path in "${required_paths[@]}"; do
    if [[ ! -e "$required_path" ]]; then
      echo "Android icon output is incomplete. Missing $required_path." >&2
      exit 1
    fi
  done

  local mipmap_dir
  for mipmap_dir in "$ANDROID_ICONS"/mipmap-*; do
    if [[ ! -d "$mipmap_dir" ]]; then
      continue
    fi

    local target_dir="$ANDROID_RES/${mipmap_dir##*/}"
    mkdir -p "$target_dir"
    cp -R "$mipmap_dir/." "$target_dir/"
  done

  mkdir -p "$ANDROID_RES/values"
  cp "$ANDROID_ICONS/values/ic_launcher_background.xml" "$ANDROID_RES/values/ic_launcher_background.xml"
}

ensure_permission() {
  local permission="$1"
  if grep -Fq "android:name=\"$permission\"" "$MANIFEST"; then
    return
  fi

  local temp_file
  temp_file="$(mktemp)"
  awk -v permission="$permission" '
    !inserted && /^[[:space:]]*<application([[:space:]>]|$)/ {
      print "    <uses-permission android:name=\"" permission "\" />"
      inserted = 1
    }
    { print }
    END {
      if (!inserted) {
        exit 42
      }
    }
  ' "$MANIFEST" > "$temp_file" || {
    rm -f "$temp_file"
    echo "Could not add Android permission $permission to $MANIFEST" >&2
    exit 1
  }
  mv "$temp_file" "$MANIFEST"
}

ensure_power_service() {
  if grep -Fq 'android:name=".PowerInhibitionService"' "$MANIFEST"; then
    return
  fi

  local temp_file
  temp_file="$(mktemp)"
  awk '
    !inserted && /^[[:space:]]*<\/application>/ {
      print "        <service"
      print "            android:name=\".PowerInhibitionService\""
      print "            android:exported=\"false\""
      print "            android:foregroundServiceType=\"mediaPlayback|connectedDevice|dataSync\" />"
      inserted = 1
    }
    { print }
    END {
      if (!inserted) {
        exit 42
      }
    }
  ' "$MANIFEST" > "$temp_file" || {
    rm -f "$temp_file"
    echo "Could not add Android power inhibition service to $MANIFEST" >&2
    exit 1
  }
  mv "$temp_file" "$MANIFEST"
}

copy_android_icons

ensure_permission "android.permission.INTERNET"
ensure_permission "android.permission.RECORD_AUDIO"
ensure_permission "android.permission.MODIFY_AUDIO_SETTINGS"
ensure_permission "android.permission.CAMERA"
ensure_permission "android.permission.FOREGROUND_SERVICE"
ensure_permission "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"
ensure_permission "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"
ensure_permission "android.permission.FOREGROUND_SERVICE_DATA_SYNC"
ensure_permission "android.permission.POST_NOTIFICATIONS"
ensure_permission "android.permission.WAKE_LOCK"
ensure_permission "android.permission.CHANGE_NETWORK_STATE"
ensure_power_service




verify_power_notification_wiring() {
  local required_snippets=(
    'fun recordNotificationPermissionResult(granted: Boolean, expectedRevision: Long)'
    'instance?.repostNotificationAfterPermissionGrant(expectedRevision)'
    'ownershipRevision.incrementAndGet()'
    'expectedRevision == ownershipRevision.get()'
    'reasonMask == desiredServiceMask &&'
    'reasonMask == confirmedServiceMask'
    'if (!matchesNotificationOwnership(expectedRevision)) return@post'
    'if (matchesNotificationOwnership(expectedRevision)) {'
    'buildTruthfulForegroundNotification()'
    'ERROR_NOTIFICATION_POST_FAILED'
    'const val REASON_TUNER_CAPTURE = 8'
    'const val SCREEN_REASON_MASK = REASON_PLAYBACK or REASON_SYNC_TRANSFER or REASON_TUNER_CAPTURE'
    'const val SERVICE_REASON_MASK = REASON_PLAYBACK or REASON_SYNC_LISTENER or REASON_SYNC_TRANSFER'
    'val activeMask = if (serviceMatches) (confirmedServiceMask or screenOnlyMask) else 0'
    'notificationPermissionDenied && desiredServiceMask != 0'
    'private val screenProtectionRevision = AtomicLong(0)'
    'private val serviceOwnershipRevision = AtomicLong(0)'
    'val serviceRevision: Long'
    'private fun transitionDesiredState('
    'val transition = transitionDesiredState(reasonMask, 0)'
    'transitionDesiredState(null, REASON_SYNC_TRANSFER)'
    'desiredScreenMask = nextMask and SCREEN_REASON_MASK'
    'activity.get()?.applyTuneForgeScreenProtection(revision)'
    'activity.get() !== currentActivity'
    'reasonMask != desiredScreenMask'
    'private fun recordPowerControlFailure(attemptedState: DesiredStateTransition)'
    'attemptedState.serviceRevision != serviceOwnershipRevision.get()'
    'attemptedState.serviceMask != desiredServiceMask'
    'handler.post { applyReasons(desiredServiceState()) }'
  )
  local snippet
  for snippet in "${required_snippets[@]}"; do
    if ! grep -Fq "$snippet" "$POWER_SERVICE"; then
      echo "Generated Android notification grant wiring is incomplete: $snippet" >&2
      exit 1
    fi
  done
  if ! grep -Fq 'notificationPermissionOwnershipRevision,' "$MAIN_ACTIVITY" ||
    ! grep -Fq 'val expectedRevision = PowerInhibitionService.captureNotificationPermissionOwnershipRevision()' "$MAIN_ACTIVITY" ||
    ! grep -Fq 'if (!PowerInhibitionService.beginNotificationPermissionRequest()) return@post' "$MAIN_ACTIVITY" ||
    ! grep -Fq 'notificationPermissionOwnershipRevision = expectedRevision' "$MAIN_ACTIVITY" ||
    ! grep -Fq 'reasonMask and PowerInhibitionService.SERVICE_REASON_MASK != 0' "$MAIN_ACTIVITY" ||
    ! grep -Fq 'screenProtectionRequestedMask(this, expectedRevision) ?: return@post' "$MAIN_ACTIVITY" ||
    ! grep -Fq 'window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)' "$MAIN_ACTIVITY" ||
    ! grep -Fq 'window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)' "$MAIN_ACTIVITY" ||
    ! grep -Fq 'PowerInhibitionService.confirmScreenProtection(this, requestedMask, expectedRevision)' "$MAIN_ACTIVITY"; then
    echo "Generated Android activity does not bind notification permission to ownership." >&2
    exit 1
  fi
}

verify_power_notification_wiring
