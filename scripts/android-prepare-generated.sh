#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_MAIN="$ROOT_DIR/apps/desktop/src-tauri/gen/android/app/src/main"
MANIFEST="$ANDROID_MAIN/AndroidManifest.xml"
MAIN_ACTIVITY="$ANDROID_MAIN/java/com/tuneforge/desktop/MainActivity.kt"

if [[ ! -f "$MANIFEST" || ! -f "$MAIN_ACTIVITY" ]]; then
  echo "Android project is not initialized. Run pnpm --filter @tuneforge/desktop tauri android init first." >&2
  exit 1
fi

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

ensure_permission "android.permission.INTERNET"
ensure_permission "android.permission.RECORD_AUDIO"
ensure_permission "android.permission.MODIFY_AUDIO_SETTINGS"
ensure_permission "android.permission.CAMERA"

cat > "$MAIN_ACTIVITY" <<'KOTLIN'
package com.tuneforge.desktop

import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    scheduleHideNavigationBar()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      scheduleHideNavigationBar()
    }
  }

  @Suppress("DEPRECATION")
  private fun scheduleHideNavigationBar() {
    window.decorView.post {
      hideNavigationBar()
    }
  }

  @Suppress("DEPRECATION")
  private fun hideNavigationBar() {
    val decorView = window.decorView
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(true)
      decorView.windowInsetsController?.let { controller ->
        controller.hide(WindowInsets.Type.navigationBars())
        controller.systemBarsBehavior =
          WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      }
      return
    }

    decorView.systemUiVisibility =
      View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
  }
}
KOTLIN
