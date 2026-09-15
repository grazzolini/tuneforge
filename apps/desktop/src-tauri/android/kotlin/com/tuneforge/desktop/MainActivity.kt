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
import android.view.WindowManager

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

  fun getTuneForgeBeatThisStatus(): String = BeatThisRunner.status(this)

  fun runTuneForgeBeatThis(input: FloatArray, frames: Int, jobId: String): Array<FloatArray> =
    BeatThisRunner.run(this, input, frames, jobId)

  fun takeTuneForgeBeatThisError(jobId: String): String = BeatThisRunner.takeError(jobId)

  fun cancelTuneForgeBeatThis(jobId: String) = BeatThisRunner.cancel(jobId)

  fun getTuneForgeCremaStatus(): String = CremaRunner.status(this)

  fun prepareTuneForgeCrema(jobId: String): String = CremaRunner.prepare(this, jobId)

  fun runTuneForgeCrema(input: FloatArray, frames: Int, jobId: String): Array<FloatArray> =
    CremaRunner.run(this, input, frames, jobId)

  fun takeTuneForgeCremaError(jobId: String): String = CremaRunner.takeError(jobId)

  fun cancelTuneForgeCrema(jobId: String) = CremaRunner.cancel(jobId)

  fun applyTuneForgeScreenProtection(expectedRevision: Long) {
    window.decorView.post {
      val requestedMask = PowerInhibitionService
        .screenProtectionRequestedMask(this, expectedRevision) ?: return@post
      if (requestedMask != 0) {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      } else {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
      PowerInhibitionService.confirmScreenProtection(this, requestedMask, expectedRevision)
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
