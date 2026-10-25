package me.capcom.smsgateway.modules.gateway.inbox

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import me.capcom.smsgateway.modules.gateway.MODULE_NAME
import me.capcom.smsgateway.modules.logs.LogsService
import me.capcom.smsgateway.modules.logs.db.LogEntry
import me.capcom.smsgateway.modules.receiver.data.InboxMessage
import org.koin.core.component.KoinComponent
import org.koin.core.component.inject
import java.util.Date

/**
 * Prépare et enfile les SMS reçus pour upload vers relio-server.
 * Seuls les SMS texte (InboxMessage.Text) sont transmis.
 * Pas de chiffrement — relio-server reçoit le contenu en clair.
 */
class InboxUploadService : KoinComponent {
    private val repository: InboxUploadRepository by inject()
    private val logsService: LogsService by inject()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    suspend fun pendingCount(): Int = repository.getPending(limit = Int.MAX_VALUE).size

    fun enqueue(
        context: Context,
        message: InboxMessage,
        sender: String,
        recipient: String?,
        simNumber: Int?,
        date: Date,
    ) {
        // Ignorer les MMS et Data SMS — relio-server ne traite que les SMS texte
        if (message !is InboxMessage.Text) return

        scope.launch {
            try {
                // ID déterministe basé sur expéditeur + horodatage pour l'idempotence
                val messageId = "${sender}_${date.time}"
                val simSlot = simNumber?.let { it - 1 }  // convertir 1-indexé → 0-indexé

                repository.enqueue(
                    messageId = messageId,
                    sender = sender,
                    body = message.text,
                    simSlot = simSlot,
                    simPhone = recipient,
                    receivedAt = date.time,
                )
                InboxUploadWorker.start(context)
            } catch (e: Exception) {
                logsService.insert(
                    LogEntry.Priority.ERROR,
                    MODULE_NAME,
                    "Échec mise en file SMS",
                    mapOf(
                        "error" to (e.message ?: e.toString()),
                        "stackTrace" to e.stackTraceToString(),
                    )
                )
            }
        }
    }
}
