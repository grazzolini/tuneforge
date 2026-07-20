#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_MAIN="$ROOT_DIR/apps/desktop/src-tauri/gen/android/app/src/main"
ANDROID_RES="$ANDROID_MAIN/res"
ANDROID_ICONS="$ROOT_DIR/apps/desktop/src-tauri/target/android-icons/android"
MANIFEST="$ANDROID_MAIN/AndroidManifest.xml"
MAIN_ACTIVITY="$ANDROID_MAIN/java/com/tuneforge/desktop/MainActivity.kt"
POWER_SERVICE="$ANDROID_MAIN/java/com/tuneforge/desktop/PowerInhibitionService.kt"

if [[ ! -f "$MANIFEST" || ! -f "$MAIN_ACTIVITY" || ! -d "$ANDROID_RES" ]]; then
  echo "Android project is not initialized. Run pnpm --filter @tuneforge/desktop tauri android init first." >&2
  exit 1
fi

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

cat > "$MAIN_ACTIVITY" <<'KOTLIN'
package com.tuneforge.desktop

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController

class MainActivity : TauriActivity() {
  private var notificationPermissionOwnershipRevision = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    PowerInhibitionService.attachActivity(this)
    scheduleHideNavigationBar()
  }

  override fun onDestroy() {
    PowerInhibitionService.detachActivity(this)
    super.onDestroy()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      scheduleHideNavigationBar()
    }
  }

  fun setTuneForgePowerInhibition(reasonMask: Int): String {
    if (reasonMask != 0) {
      requestTuneForgeNotificationPermission()
    }
    PowerInhibitionService.requestScreenProtection(
      reasonMask and PowerInhibitionService.REASON_PLAYBACK != 0,
    )
    return PowerInhibitionService.request(this, reasonMask)
  }

  fun getTuneForgePowerInhibitionStatus(): String = PowerInhibitionService.status()

  fun applyTuneForgeScreenProtection() {
    window.decorView.post {
      val requested = PowerInhibitionService.screenProtectionRequested()
      window.decorView.keepScreenOn = requested
      PowerInhibitionService.confirmScreenProtection(requested)
    }
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
      PowerInhibitionService.recordNotificationPermissionResult(
        grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED,
        notificationPermissionOwnershipRevision,
      )
    }
  }

  private fun requestTuneForgeNotificationPermission() {
    window.decorView.post {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
      ) return@post
      val expectedRevision = PowerInhibitionService.captureNotificationPermissionOwnershipRevision()
      if (!PowerInhibitionService.beginNotificationPermissionRequest()) return@post
      notificationPermissionOwnershipRevision = expectedRevision
      requestPermissions(
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        NOTIFICATION_PERMISSION_REQUEST,
      )
    }
  }

  companion object {
    private const val NOTIFICATION_PERMISSION_REQUEST = 2305
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

cat > "$POWER_SERVICE" <<'KOTLIN'
package com.tuneforge.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicLong

class PowerInhibitionService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private var reasonMask = 0

  override fun onCreate() {
    super.onCreate()
    instance = this
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // A queued start intent may predate a later release request. Always apply
    // the latest process-wide desired mask so a stale intent cannot reacquire.
    val requestedMask = desiredReasonMask()
    applyReasons(requestedMask)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    reasonMask = 0
    confirmedMask = 0
    instance = null
    super.onDestroy()
    val remainingMask = desiredMask
    if (remainingMask != 0) {
      launch(applicationContext, remainingMask)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTimeout(startId: Int, fgsType: Int) {
    if (Build.VERSION.SDK_INT >= 35 && fgsType and ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC != 0) {
      val remainingMask = reasonMask and REASON_SYNC_TRANSFER.inv()
      ownershipRevision.incrementAndGet()
      timeoutEpoch += 1
      lastFailure = ERROR_DATA_SYNC_TIMEOUT
      desiredMask = remainingMask
      confirmedMask = 0
      requestScreenProtection(remainingMask and REASON_PLAYBACK != 0)
      releaseWakeLock()
      reasonMask = 0
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf(startId)
    }
  }

  private fun applyReasons(requestedMask: Int): String {
    return try {
      reasonMask = requestedMask
      confirmedMask = requestedMask
      updateWakeLock()
      if (reasonMask == 0) {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        status()
      } else {
        startTruthfulForegroundNotification()
        status()
      }
    } catch (_: RuntimeException) {
      releaseWakeLock()
      reasonMask = 0
      confirmedMask = 0
      desiredMask = 0
      lastFailure = ERROR_POWER_CONTROL
      requestScreenProtection(false)
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      status()
    }
  }

  private fun startTruthfulForegroundNotification() {
    val notification = buildTruthfulForegroundNotification()
    val serviceTypes = foregroundServiceTypes()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, serviceTypes)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildTruthfulForegroundNotification(): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("TuneForge active")
      .setContentText(notificationText())
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }

  private fun repostNotificationAfterPermissionGrant(expectedRevision: Long) {
    handler.post {
      if (!matchesNotificationOwnership(expectedRevision)) return@post
      try {
        val notification = buildTruthfulForegroundNotification()
        if (!matchesNotificationOwnership(expectedRevision)) return@post
        getSystemService(NotificationManager::class.java).notify(
          NOTIFICATION_ID,
          notification,
        )
      } catch (_: RuntimeException) {
        if (matchesNotificationOwnership(expectedRevision)) {
          lastFailure = ERROR_NOTIFICATION_POST_FAILED
        }
      }
    }
  }

  private fun matchesNotificationOwnership(expectedRevision: Long): Boolean =
    expectedRevision == ownershipRevision.get() &&
      reasonMask != 0 &&
      reasonMask == desiredMask &&
      reasonMask == confirmedMask

  private fun foregroundServiceTypes(): Int {
    var types = 0
    if (reasonMask and REASON_PLAYBACK != 0) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    }
    if (reasonMask and REASON_SYNC_LISTENER != 0) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
    }
    if (reasonMask and REASON_SYNC_TRANSFER != 0) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
    }
    return types
  }

  private fun notificationText(): String {
    val playback = reasonMask and REASON_PLAYBACK != 0
    val listener = reasonMask and REASON_SYNC_LISTENER != 0
    val transfer = reasonMask and REASON_SYNC_TRANSFER != 0
    return when {
      playback && (listener || transfer) -> "Playback and sync are active"
      playback -> "Playback is active"
      transfer -> "Sync transfer is active"
      listener -> "Sync listener is active"
      else -> "Finishing active work"
    }
  }

  private fun updateWakeLock() {
    val syncActive = reasonMask and (REASON_SYNC_LISTENER or REASON_SYNC_TRANSFER) != 0
    if (!syncActive) {
      releaseWakeLock()
      return
    }
    val lock = wakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TuneForge:Sync")
      .also { wakeLock = it }
    if (!lock.isHeld) {
      lock.acquire(WAKE_LOCK_DURATION_MS)
    }
    handler.removeCallbacks(renewWakeLock)
    handler.postDelayed(renewWakeLock, WAKE_LOCK_RENEW_MS)
  }

  private val renewWakeLock = object : Runnable {
    override fun run() {
      if (reasonMask and (REASON_SYNC_LISTENER or REASON_SYNC_TRANSFER) == 0) return
      wakeLock?.let { lock ->
        if (lock.isHeld) lock.release()
        lock.acquire(WAKE_LOCK_DURATION_MS)
      }
      handler.postDelayed(this, WAKE_LOCK_RENEW_MS)
    }
  }

  private fun releaseWakeLock() {
    handler.removeCallbacks(renewWakeLock)
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Playback and sync",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shows when TuneForge keeps playback or sync active"
      setShowBadge(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  companion object {
    const val REASON_PLAYBACK = 1
    const val REASON_SYNC_LISTENER = 2
    const val REASON_SYNC_TRANSFER = 4
    private const val CHANNEL_ID = "tuneforge_active_work"
    private const val NOTIFICATION_ID = 2304
    private const val EXTRA_REASON_MASK = "reasonMask"
    private const val WAKE_LOCK_DURATION_MS = 10 * 60 * 1000L
    private const val WAKE_LOCK_RENEW_MS = 9 * 60 * 1000L
    private const val ERROR_NONE = "none"
    private const val ERROR_DATA_SYNC_TIMEOUT = "android-data-sync-timeout"
    private const val ERROR_NOTIFICATION_PERMISSION_DENIED = "android-notification-permission-denied"
    private const val ERROR_NOTIFICATION_POST_FAILED = "android-notification-post-failed"
    private const val ERROR_POWER_CONTROL = "android-power-control-failed"

    @Volatile private var instance: PowerInhibitionService? = null
    @Volatile private var desiredMask = 0
    @Volatile private var confirmedMask = 0
    @Volatile private var lastFailure = ERROR_NONE
    @Volatile private var timeoutEpoch = 0L
    @Volatile private var screenRequested = false
    @Volatile private var screenConfirmed = false
    @Volatile private var notificationPermissionRequested = false
    @Volatile private var notificationPermissionDenied = false
    @Volatile private var activity = WeakReference<MainActivity>(null)
    private val ownershipRevision = AtomicLong(0)

    fun attachActivity(nextActivity: MainActivity) {
      activity = WeakReference(nextActivity)
      nextActivity.applyTuneForgeScreenProtection()
    }

    fun detachActivity(currentActivity: MainActivity) {
      if (activity.get() === currentActivity) activity.clear()
    }

    fun requestScreenProtection(enabled: Boolean) {
      screenRequested = enabled
      activity.get()?.applyTuneForgeScreenProtection()
    }

    fun screenProtectionRequested(): Boolean = screenRequested

    private fun desiredReasonMask(): Int = desiredMask

    fun confirmScreenProtection(enabled: Boolean) {
      screenConfirmed = enabled
    }

    fun beginNotificationPermissionRequest(): Boolean {
      if (notificationPermissionRequested) return false
      notificationPermissionRequested = true
      return true
    }

    fun captureNotificationPermissionOwnershipRevision(): Long = ownershipRevision.get()

    fun recordNotificationPermissionResult(granted: Boolean, expectedRevision: Long) {
      notificationPermissionDenied = !granted
      if (granted) {
        instance?.repostNotificationAfterPermissionGrant(expectedRevision)
      }
    }

    fun request(context: Context, reasonMask: Int): String {
      val previousMask = desiredMask
      ownershipRevision.incrementAndGet()
      desiredMask = reasonMask
      if (lastFailure == ERROR_DATA_SYNC_TIMEOUT &&
        (reasonMask and REASON_SYNC_TRANSFER == 0 || previousMask and REASON_SYNC_TRANSFER == 0)
      ) {
        lastFailure = ERROR_NONE
      } else if (lastFailure == ERROR_POWER_CONTROL || lastFailure == ERROR_NOTIFICATION_POST_FAILED) {
        lastFailure = ERROR_NONE
      }
      val existing = instance
      if (existing != null) {
        existing.applyOnMainThread(reasonMask)
        return status()
      }
      if (reasonMask == 0) {
        confirmedMask = 0
        return status()
      }

      launch(context, reasonMask)
      return status()
    }

    fun status(): String {
      val activeMask = confirmedMask
      val screenMatches = screenConfirmed == (desiredMask and REASON_PLAYBACK != 0)
      val statusError = when {
        lastFailure != ERROR_NONE -> lastFailure
        notificationPermissionDenied && desiredMask != 0 -> ERROR_NOTIFICATION_PERMISSION_DENIED
        else -> ERROR_NONE
      }
      val phase = when {
        statusError != ERROR_NONE -> "failed"
        activeMask == desiredMask && screenMatches && activeMask == 0 -> "inactive"
        activeMask == desiredMask && screenMatches -> "active"
        desiredMask == 0 -> "releasing"
        else -> "acquiring"
      }
      return "$phase;$activeMask;$statusError;$desiredMask;$timeoutEpoch;$screenConfirmed"
    }

    private fun launch(context: Context, reasonMask: Int) {
      try {
        val intent = Intent(context, PowerInhibitionService::class.java)
          .putExtra(EXTRA_REASON_MASK, reasonMask)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (_: RuntimeException) {
        desiredMask = 0
        confirmedMask = 0
        lastFailure = ERROR_POWER_CONTROL
        requestScreenProtection(false)
      }
    }
  }

  private fun applyOnMainThread(requestedMask: Int) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      applyReasons(requestedMask)
    } else {
      handler.post { applyReasons(requestedMask) }
    }
  }
}
KOTLIN

verify_power_notification_wiring() {
  local required_snippets=(
    'fun recordNotificationPermissionResult(granted: Boolean, expectedRevision: Long)'
    'instance?.repostNotificationAfterPermissionGrant(expectedRevision)'
    'ownershipRevision.incrementAndGet()'
    'expectedRevision == ownershipRevision.get()'
    'reasonMask == desiredMask &&'
    'reasonMask == confirmedMask'
    'if (!matchesNotificationOwnership(expectedRevision)) return@post'
    'if (matchesNotificationOwnership(expectedRevision)) {'
    'buildTruthfulForegroundNotification()'
    'ERROR_NOTIFICATION_POST_FAILED'
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
    ! grep -Fq 'notificationPermissionOwnershipRevision = expectedRevision' "$MAIN_ACTIVITY"; then
    echo "Generated Android activity does not bind notification permission to ownership." >&2
    exit 1
  fi
}

verify_power_notification_wiring
