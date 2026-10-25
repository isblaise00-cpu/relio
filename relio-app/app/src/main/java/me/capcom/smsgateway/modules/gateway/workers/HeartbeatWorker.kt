package me.capcom.smsgateway.modules.gateway.workers

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import me.capcom.smsgateway.modules.gateway.GatewayService
import me.capcom.smsgateway.modules.gateway.GatewaySettings
import me.capcom.smsgateway.modules.gateway.MODULE_NAME
import me.capcom.smsgateway.modules.logs.LogsService
import me.capcom.smsgateway.modules.logs.db.LogEntry
import org.koin.core.component.KoinComponent
import org.koin.core.component.inject
import java.util.concurrent.TimeUnit

/**
 * Envoie périodiquement un heartbeat à relio-server.
 * Intervalle par défaut : 30 secondes (configurable via /device/v1/config).
 * WorkManager garantit l'exécution même si l'app est en arrière-plan.
 */
class HeartbeatWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params), KoinComponent {

    private val gatewayService: GatewayService by inject()
    private val gatewaySettings: GatewaySettings by inject()
    private val logsSvc: LogsService by inject()

    override suspend fun doWork(): Result {
        return try {
            gatewayService.sendHeartbeat(applicationContext)
            gatewayService.syncConfig()
            gatewaySettings.lastHeartbeatSuccessAt = System.currentTimeMillis()
            Result.success()
        } catch (e: Exception) {
            logsSvc.insert(
                LogEntry.Priority.WARN,
                MODULE_NAME,
                "Heartbeat échoué : ${e.message}",
            )
            Result.retry()
        }
    }

    companion object {
        private const val WORK_NAME = "relio_heartbeat"
        private const val INTERVAL_MINUTES = 15L  // WorkManager minimum : 15 min

        fun start(context: Context) {
            val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(
                INTERVAL_MINUTES, TimeUnit.MINUTES
            )
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build()
                )
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.REPLACE,
                request,
            )
        }

        fun stop(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}
