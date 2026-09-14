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
    applyReasons(desiredServiceState())
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    reasonMask = 0
    confirmedServiceMask = 0
    instance = null
    super.onDestroy()
    val remainingState = desiredServiceState()
    if (remainingState.serviceMask != 0) {
      launch(applicationContext, remainingState)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTimeout(startId: Int, fgsType: Int) {
    if (Build.VERSION.SDK_INT >= 35 && fgsType and ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC != 0) {
      transitionDesiredState(null, REASON_SYNC_TRANSFER)
      timeoutEpoch += 1
      lastFailure = ERROR_DATA_SYNC_TIMEOUT
      confirmedServiceMask = 0
      releaseWakeLock()
      reasonMask = 0
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf(startId)
    }
  }

  private fun applyReasons(attemptedState: DesiredStateTransition): String {
    return try {
      reasonMask = attemptedState.serviceMask
      confirmedServiceMask = attemptedState.serviceMask
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
      recordPowerControlFailure(attemptedState)
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
    const val SCREEN_REASON_MASK = REASON_PLAYBACK or REASON_SYNC_TRANSFER or REASON_TUNER_CAPTURE
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
    private val screenProtectionRevision = AtomicLong(0)
    private val serviceOwnershipRevision = AtomicLong(0)

    private data class DesiredStateTransition(
      val previousServiceMask: Int,
      val serviceMask: Int,
      val serviceRevision: Long,
    )

    @Synchronized
    fun attachActivity(nextActivity: MainActivity) {
      activity = WeakReference(nextActivity)
      confirmedScreenMask = 0
      val revision = screenProtectionRevision.incrementAndGet()
      nextActivity.applyTuneForgeScreenProtection(revision)
    }

    @Synchronized
    fun detachActivity(currentActivity: MainActivity) {
      if (activity.get() === currentActivity) {
        screenProtectionRevision.incrementAndGet()
        activity.clear()
        confirmedScreenMask = 0
      }
    }

    @Synchronized
    fun screenProtectionRequestedMask(
      currentActivity: MainActivity,
      expectedRevision: Long,
    ): Int? {
      if (activity.get() !== currentActivity || expectedRevision != screenProtectionRevision.get()) {
        return null
      }
      return desiredScreenMask
    }

    @Synchronized
    private fun desiredServiceState(): DesiredStateTransition = DesiredStateTransition(
      previousServiceMask = desiredServiceMask,
      serviceMask = desiredServiceMask,
      serviceRevision = serviceOwnershipRevision.get(),
    )

    @Synchronized
    fun confirmScreenProtection(
      currentActivity: MainActivity,
      reasonMask: Int,
      expectedRevision: Long,
    ) {
      if (activity.get() !== currentActivity ||
        expectedRevision != screenProtectionRevision.get() ||
        reasonMask != desiredScreenMask
      ) return
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
      val transition = transitionDesiredState(reasonMask, 0)
      if (lastFailure == ERROR_DATA_SYNC_TIMEOUT &&
        (reasonMask and REASON_SYNC_TRANSFER == 0 ||
          transition.previousServiceMask and REASON_SYNC_TRANSFER == 0)
      ) {
        lastFailure = ERROR_NONE
      } else if (lastFailure == ERROR_POWER_CONTROL || lastFailure == ERROR_NOTIFICATION_POST_FAILED) {
        lastFailure = ERROR_NONE
      }
      val existing = instance
      if (existing != null) {
        existing.applyOnMainThread()
        return status()
      }
      if (transition.serviceMask == 0) {
        confirmedServiceMask = 0
        return status()
      }

      launch(context, transition)
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

    private fun launch(context: Context, attemptedState: DesiredStateTransition) {
      try {
        val intent = Intent(context, PowerInhibitionService::class.java)
          .putExtra(EXTRA_REASON_MASK, attemptedState.serviceMask)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      } catch (_: RuntimeException) {
        recordPowerControlFailure(attemptedState)
      }
    }

    @Synchronized
    private fun transitionDesiredState(
      requestedMask: Int?,
      clearedReasons: Int,
    ): DesiredStateTransition {
      val nextMask = requestedMask ?: (desiredMask and clearedReasons.inv())
      val previousServiceMask = desiredServiceMask
      val nextServiceMask = nextMask and SERVICE_REASON_MASK
      if (previousServiceMask != nextServiceMask) {
        ownershipRevision.incrementAndGet()
      }
      desiredMask = nextMask
      desiredServiceMask = nextServiceMask
      desiredScreenMask = nextMask and SCREEN_REASON_MASK
      val serviceRevision = serviceOwnershipRevision.incrementAndGet()
      val revision = screenProtectionRevision.incrementAndGet()
      activity.get()?.applyTuneForgeScreenProtection(revision)
      return DesiredStateTransition(previousServiceMask, nextServiceMask, serviceRevision)
    }

    @Synchronized
    private fun recordPowerControlFailure(attemptedState: DesiredStateTransition) {
      if (attemptedState.serviceRevision != serviceOwnershipRevision.get() ||
        attemptedState.serviceMask != desiredServiceMask
      ) return
      transitionDesiredState(null, SERVICE_REASON_MASK)
      confirmedServiceMask = 0
      lastFailure = ERROR_POWER_CONTROL
    }
  }

  private fun applyOnMainThread() {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      applyReasons(desiredServiceState())
    } else {
      handler.post { applyReasons(desiredServiceState()) }
    }
  }
}
