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
import android.app.AppOpsManager
import android.content.pm.PackageManager
import android.hardware.SensorPrivacyManager
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController

class MainActivity : TauriActivity() {
  private var notificationPermissionOwnershipRevision = 0L
  @Volatile private var microphonePermissionRequestPending = false

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
    if (reasonMask and PowerInhibitionService.SERVICE_REASON_MASK != 0) {
      requestTuneForgeNotificationPermission()
    }
    return PowerInhibitionService.request(this, reasonMask)
  }

  fun getTuneForgePowerInhibitionStatus(): String = PowerInhibitionService.status()

  fun applyTuneForgeScreenProtection() {
    window.decorView.post {
      val requestedMask = PowerInhibitionService.screenProtectionRequestedMask()
      window.decorView.keepScreenOn = requestedMask != 0
      PowerInhibitionService.confirmScreenProtection(requestedMask)
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
    if (requestCode == MICROPHONE_PERMISSION_REQUEST) {
      microphonePermissionRequestPending = false
    }
  }

  fun getTuneForgeAudioPermissionState(): String {
    if (!packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)) return "unavailable"
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      return if (microphonePrivacyBlocked()) "privacy-blocked" else "granted"
    }
    if (microphonePermissionRequestPending) return "prompting"
    val requestedBefore = getPreferences(MODE_PRIVATE)
      .getBoolean(MICROPHONE_PERMISSION_REQUESTED, false)
    if (!requestedBefore) return "prompt"
    return if (shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
      "denied"
    } else {
      "blocked"
    }
  }

  fun requestTuneForgeAudioPermission(): String {
    val state = getTuneForgeAudioPermissionState()
    if (state != "prompt" && state != "denied") return state
    microphonePermissionRequestPending = true
    getPreferences(MODE_PRIVATE).edit()
      .putBoolean(MICROPHONE_PERMISSION_REQUESTED, true)
      .apply()
    window.decorView.post {
      if (microphonePermissionRequestPending) {
        requestPermissions(
          arrayOf(Manifest.permission.RECORD_AUDIO),
          MICROPHONE_PERMISSION_REQUEST,
        )
      }
    }
    return "prompting"
  }

  private fun microphonePrivacyBlocked(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    val privacy = getSystemService(SensorPrivacyManager::class.java) ?: return false
    if (!privacy.supportsSensorToggle(SensorPrivacyManager.Sensors.MICROPHONE)) return false
    val appOps = getSystemService(AppOpsManager::class.java) ?: return false
    return appOps.checkOpNoThrow(
      AppOpsManager.OPSTR_RECORD_AUDIO,
      Process.myUid(),
      packageName,
    ) == AppOpsManager.MODE_IGNORED
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
    private const val MICROPHONE_PERMISSION_REQUEST = 2306
    private const val MICROPHONE_PERMISSION_REQUESTED = "tuneforge_microphone_permission_requested"
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
    val requestedMask = desiredServiceReasonMask()
    applyReasons(requestedMask)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    reasonMask = 0
    confirmedServiceMask = 0
    instance = null
    super.onDestroy()
    val remainingServiceMask = desiredServiceMask
    if (remainingServiceMask != 0) {
      launch(applicationContext, remainingServiceMask)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTimeout(startId: Int, fgsType: Int) {
    if (Build.VERSION.SDK_INT >= 35 && fgsType and ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC != 0) {
      val remainingMask = desiredMask and REASON_SYNC_TRANSFER.inv()
      ownershipRevision.incrementAndGet()
      timeoutEpoch += 1
      lastFailure = ERROR_DATA_SYNC_TIMEOUT
      desiredMask = remainingMask
      desiredServiceMask = remainingMask and SERVICE_REASON_MASK
      requestScreenProtection(remainingMask and SCREEN_REASON_MASK)
      confirmedServiceMask = 0
      releaseWakeLock()
      reasonMask = 0
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf(startId)
    }
  }

  private fun applyReasons(requestedMask: Int): String {
    return try {
      reasonMask = requestedMask
      confirmedServiceMask = requestedMask
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
      confirmedServiceMask = 0
      desiredServiceMask = 0
      desiredMask = desiredMask and SERVICE_REASON_MASK.inv()
      lastFailure = ERROR_POWER_CONTROL
      requestScreenProtection(desiredMask and SCREEN_REASON_MASK)
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
      reasonMask == desiredServiceMask &&
      reasonMask == confirmedServiceMask

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
    val syncActive = reasonMask and PARTIAL_WAKE_REASON_MASK != 0
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
      if (reasonMask and PARTIAL_WAKE_REASON_MASK == 0) return
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
    const val REASON_TUNER_CAPTURE = 8
    const val SCREEN_REASON_MASK = REASON_PLAYBACK or REASON_TUNER_CAPTURE
    const val SERVICE_REASON_MASK = REASON_PLAYBACK or REASON_SYNC_LISTENER or REASON_SYNC_TRANSFER
    private const val PARTIAL_WAKE_REASON_MASK = REASON_SYNC_LISTENER or REASON_SYNC_TRANSFER
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
    @Volatile private var desiredServiceMask = 0
    @Volatile private var confirmedServiceMask = 0
    @Volatile private var lastFailure = ERROR_NONE
    @Volatile private var timeoutEpoch = 0L
    @Volatile private var desiredScreenMask = 0
    @Volatile private var confirmedScreenMask = 0
    @Volatile private var notificationPermissionRequested = false
    @Volatile private var notificationPermissionDenied = false
    @Volatile private var activity = WeakReference<MainActivity>(null)
    private val ownershipRevision = AtomicLong(0)

    fun attachActivity(nextActivity: MainActivity) {
      activity = WeakReference(nextActivity)
      nextActivity.applyTuneForgeScreenProtection()
    }

    fun detachActivity(currentActivity: MainActivity) {
      if (activity.get() === currentActivity) {
        activity.clear()
        confirmedScreenMask = 0
      }
    }

    fun requestScreenProtection(reasonMask: Int) {
      desiredScreenMask = reasonMask and SCREEN_REASON_MASK
      activity.get()?.applyTuneForgeScreenProtection()
    }

    fun screenProtectionRequestedMask(): Int = desiredScreenMask

    private fun desiredServiceReasonMask(): Int = desiredServiceMask

    fun confirmScreenProtection(reasonMask: Int) {
      confirmedScreenMask = reasonMask and SCREEN_REASON_MASK
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
      val previousServiceMask = desiredServiceMask
      val nextServiceMask = reasonMask and SERVICE_REASON_MASK
      if (previousServiceMask != nextServiceMask) {
        ownershipRevision.incrementAndGet()
      }
      desiredMask = reasonMask
      desiredServiceMask = nextServiceMask
      requestScreenProtection(reasonMask and SCREEN_REASON_MASK)
      if (lastFailure == ERROR_DATA_SYNC_TIMEOUT &&
        (reasonMask and REASON_SYNC_TRANSFER == 0 || previousServiceMask and REASON_SYNC_TRANSFER == 0)
      ) {
        lastFailure = ERROR_NONE
      } else if (lastFailure == ERROR_POWER_CONTROL || lastFailure == ERROR_NOTIFICATION_POST_FAILED) {
        lastFailure = ERROR_NONE
      }
      val existing = instance
      if (existing != null) {
        existing.applyOnMainThread(nextServiceMask)
        return status()
      }
      if (nextServiceMask == 0) {
        confirmedServiceMask = 0
        return status()
      }

      launch(context, nextServiceMask)
      return status()
    }

    fun status(): String {
      val screenMatches = confirmedScreenMask == desiredScreenMask
      val serviceMatches = confirmedServiceMask == desiredServiceMask
      val screenOnlyMask = confirmedScreenMask and SERVICE_REASON_MASK.inv()
      val activeMask = if (serviceMatches) (confirmedServiceMask or screenOnlyMask) else 0
      val statusError = when {
        lastFailure != ERROR_NONE -> lastFailure
        notificationPermissionDenied && desiredServiceMask != 0 -> ERROR_NOTIFICATION_PERMISSION_DENIED
        else -> ERROR_NONE
      }
      val phase = when {
        statusError != ERROR_NONE -> "failed"
        serviceMatches && screenMatches && activeMask == 0 -> "inactive"
        serviceMatches && screenMatches -> "active"
        desiredMask == 0 -> "releasing"
        else -> "acquiring"
      }
      return "$phase;$activeMask;$statusError;$desiredMask;$timeoutEpoch;${confirmedScreenMask != 0}"
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
        desiredMask = desiredMask and SERVICE_REASON_MASK.inv()
        desiredServiceMask = 0
        confirmedServiceMask = 0
        lastFailure = ERROR_POWER_CONTROL
        requestScreenProtection(desiredMask and SCREEN_REASON_MASK)
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
    'reasonMask == desiredServiceMask &&'
    'reasonMask == confirmedServiceMask'
    'if (!matchesNotificationOwnership(expectedRevision)) return@post'
    'if (matchesNotificationOwnership(expectedRevision)) {'
    'buildTruthfulForegroundNotification()'
    'ERROR_NOTIFICATION_POST_FAILED'
    'const val REASON_TUNER_CAPTURE = 8'
    'const val SCREEN_REASON_MASK = REASON_PLAYBACK or REASON_TUNER_CAPTURE'
    'const val SERVICE_REASON_MASK = REASON_PLAYBACK or REASON_SYNC_LISTENER or REASON_SYNC_TRANSFER'
    'val activeMask = if (serviceMatches) (confirmedServiceMask or screenOnlyMask) else 0'
    'notificationPermissionDenied && desiredServiceMask != 0'
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
    ! grep -Fq 'window.decorView.keepScreenOn = requestedMask != 0' "$MAIN_ACTIVITY"; then
    echo "Generated Android activity does not bind notification permission to ownership." >&2
    exit 1
  fi
}

verify_power_notification_wiring
