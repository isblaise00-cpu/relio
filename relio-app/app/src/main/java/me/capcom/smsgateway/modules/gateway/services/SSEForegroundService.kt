package me.capcom.smsgateway.modules.gateway.services

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import me.capcom.smsgateway.R
import me.capcom.smsgateway.modules.gateway.GatewayService
import me.capcom.smsgateway.modules.gateway.GatewaySettings
import me.capcom.smsgateway.modules.notifications.NotificationsService
import org.koin.android.ext.android.inject

/**
 * Foreground service de heartbeat.
 *
 * Envoie un heartbeat à relio-server toutes les HEARTBEAT_INTERVAL_MS (5 min).
 * Exécuter comme foreground service garantit qu'Android ne tue pas le processus
 * entre deux heartbeats WorkManager (dont le minimum est 15 min).
 *
 * Le service est démarré par GatewayService.start() dès que l'appareil est apparié
 * et s'arrête avec GatewayService.stop().
 */
class SSEForegroundService : Service() {

    private val gatewayService: GatewayService by inject()
    private val gatewaySettings: GatewaySettings by inject()
    private val notifSvc: NotificationsService by inject()

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var heartbeatJob: Job? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!gatewaySettings.isPaired) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(
            NotificationsService.NOTIFICATION_ID_REALTIME_EVENTS,
            notifSvc.makeNotification(
                this,
                NotificationsService.NOTIFICATION_ID_REALTIME_EVENTS,
                getString(R.string.relay_active_detail),
            )
        )

        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                try {
                    gatewayService.sendHeartbeat(applicationContext)
                    gatewayService.syncConfig()
                    gatewaySettings.lastHeartbeatSuccessAt = System.currentTimeMillis()
                } catch (_: Exception) {
                    // Ignoré — le prochain cycle réessaiera
                }
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        heartbeatJob?.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent): IBinder? = null

    companion object {
        /** Intervalle entre deux heartbeats (5 minutes). */
        private const val HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000L

        fun start(context: Context) {
            val intent = Intent(context, SSEForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SSEForegroundService::class.java))
        }
    }
}
