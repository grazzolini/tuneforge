package com.tuneforge.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** User-started local-file processing. Never owns screen or playback/sync protection. */
class ProcessingService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    synchronized(guard) {
      if (!wanted || intent?.getLongExtra("generation", -1) != generation) {
        stopSelf(startId)
        return START_NOT_STICKY
      }
      try {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Audio processing", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(this, CHANNEL)
          .setSmallIcon(android.R.drawable.ic_media_play)
          .setContentTitle("TuneForge is processing audio")
          .setContentText("Analysis, chords, and lyrics continue in the background.")
          .setContentIntent(open).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 29) {
          val type = if (Build.VERSION.SDK_INT >= 35) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING else ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
          startForeground(NOTIFICATION, notification, type)
        } else {
          startForeground(NOTIFICATION, notification)
        }
        instance = this
        ready = true
        acknowledgement?.countDown()
      } catch (_: Exception) {
        failLocked()
      }
    }
    return START_NOT_STICKY
  }

  private fun activeLocked(active: Boolean) {
    if (active) {
      if (wakeLock?.isHeld != true) {
        wakeLock = getSystemService(PowerManager::class.java)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TuneForge:processing")
          .also { it.acquire() }
      }
    } else {
      wakeLock?.let { if (it.isHeld) it.release() }
      wakeLock = null
    }
  }

  private fun finishLocked() {
    activeLocked(false)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun failLocked() {
    wanted = false
    ready = false
    failed = true
    acknowledgement?.countDown()
    if (instance === this) instance = null
    finishLocked()
  }

  override fun onTimeout(startId: Int) { synchronized(guard) { failLocked() } }
  override fun onTimeout(startId: Int, fgsType: Int) { synchronized(guard) { failLocked() } }

  override fun onDestroy() {
    synchronized(guard) {
      activeLocked(false)
      if (instance === this) {
        instance = null
        ready = false
        if (wanted) { wanted = false; failed = true; acknowledgement?.countDown() }
      }
    }
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "tuneforge-processing"
    private const val NOTIFICATION = 2307
    private val guard = Any()
    private var instance: ProcessingService? = null
    private var wanted = false
    private var ready = false
    private var failed = false
    private var visible = false
    private var generation = 0L
    private var acknowledgement: CountDownLatch? = null

    fun visibility(isVisible: Boolean) { synchronized(guard) { visible = isVisible } }

    fun request(activity: MainActivity, state: Int): String {
      var wait: CountDownLatch? = null
      synchronized(guard) {
        when (state) {
          0 -> {
            wanted = false; ready = false; generation += 1
            instance?.finishLocked(); instance = null
            acknowledgement?.countDown()
            return "ready"
          }
          1 -> {
            if (wanted && ready && !failed) return "ready"
            if (!visible) return "background-start-rejected"
            wanted = true; ready = false; failed = false; generation += 1
            wait = CountDownLatch(1); acknowledgement = wait
            try {
              activity.startForegroundService(Intent(activity, ProcessingService::class.java).putExtra("generation", generation))
            } catch (_: Exception) {
              wanted = false; failed = true; wait?.countDown()
              return "start-failed"
            }
          }
          2, 3 -> {
            if (!wanted || !ready || failed) return "service-stopped"
            try { instance?.activeLocked(state == 2) ?: return "service-stopped" }
            catch (_: Exception) { instance?.failLocked(); return "wake-lock-failed" }
            return "ready"
          }
          4 -> return if (wanted && ready && !failed) "ready" else "service-stopped"
          else -> return "invalid-state"
        }
      }
      // Called from the native blocking lane, never the Android main thread.
      if (wait?.await(10, TimeUnit.SECONDS) != true) {
        synchronized(guard) {
          wanted = false; ready = false; failed = true; generation += 1
          instance?.finishLocked(); instance = null
        }
        return "start-timeout"
      }
      return synchronized(guard) { if (wanted && ready && !failed) "ready" else "start-failed" }
    }
  }
}
