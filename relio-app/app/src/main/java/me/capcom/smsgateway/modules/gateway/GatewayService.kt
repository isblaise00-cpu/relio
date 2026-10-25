package me.capcom.smsgateway.modules.gateway

import android.content.Context
import me.capcom.smsgateway.BuildConfig
import me.capcom.smsgateway.helpers.SubscriptionsHelper
import me.capcom.smsgateway.modules.gateway.inbox.InboxUploadService
import me.capcom.smsgateway.modules.gateway.inbox.InboxUploadWorker
import me.capcom.smsgateway.modules.gateway.services.SSEForegroundService
import me.capcom.smsgateway.modules.gateway.workers.HeartbeatWorker
import me.capcom.smsgateway.modules.receiver.data.InboxMessage
import java.util.Date

/**
 * Service principal du module gateway.
 *
 * Responsabilités :
 *  - Appairage avec relio-server (échange du code 6 chiffres)
 *  - Heartbeat périodique
 *  - Mise en file et envoi des SMS reçus
 */
class GatewayService(
    private val inboxUploadService: InboxUploadService,
    private val settings: GatewaySettings,
) {
    private var _api: GatewayApi? = null

    private val api: GatewayApi
        get() = _api ?: GatewayApi(
            baseUrl = settings.serverUrl,
            deviceId = { settings.deviceId },
            deviceSecret = { settings.deviceSecret },
        ).also { _api = it }

    // ─── Cycle de vie ────────────────────────────────────────────────────────

    fun start(context: Context) {
        if (!settings.enabled || !settings.isPaired) return
        SSEForegroundService.start(context)   // heartbeat toutes les 5 min (foreground)
        HeartbeatWorker.start(context)         // heartbeat WorkManager toutes les 15 min (fallback)
        InboxUploadWorker.start(context)
    }

    fun stop(context: Context) {
        SSEForegroundService.stop(context)
        HeartbeatWorker.stop(context)
        InboxUploadWorker.stop(context)
        _api = null
    }

    // ─── Appairage ───────────────────────────────────────────────────────────

    /**
     * Associe ce téléphone à un marchand via le code 6 chiffres.
     * Stocke device_id + device_secret et active le relais.
     */
    suspend fun pair(context: Context, code: String, name: String): GatewayApi.PairResponse {
        // Réinitialiser le client avant le pairing (pas encore de credentials)
        _api = null
        val response = api.pair(code, name)
        settings.deviceId = response.deviceId
        settings.deviceSecret = response.deviceSecret
        settings.enabled = true
        // Réinitialiser le client avec les nouveaux credentials HMAC
        _api = null
        // Récupérer immédiatement la liste des expéditeurs autorisés
        syncConfig()
        start(context)
        return response
    }

    /**
     * Dissocie ce téléphone du marchand.
     * Arrête les workers et efface les credentials.
     */
    fun unpair(context: Context) {
        stop(context)
        settings.clearPairing()
        settings.enabled = false
    }

    // ─── Configuration ───────────────────────────────────────────────────────

    /**
     * Récupère la configuration depuis relio-server et met à jour le cache local :
     * expéditeurs autorisés, nom/clé du marchand, webhooks de paiement.
     */
    suspend fun syncConfig() {
        val config = api.getConfig()
        settings.allowedSenders = config.senders
        config.merchantName?.let { settings.merchantName = it }
        config.merchantKey?.let { settings.merchantKey = it }
        settings.webhookSuccess = config.webhookSuccess
        settings.webhookFailure = config.webhookFailure
    }

    /**
     * Met à jour les webhooks de paiement sur le serveur et dans le cache local.
     */
    suspend fun updateWebhooks(successUrl: String?, failureUrl: String?) {
        api.updateWebhooks(successUrl, failureUrl)
        settings.webhookSuccess = successUrl
        settings.webhookFailure = failureUrl
    }

    // ─── Heartbeat ───────────────────────────────────────────────────────────

    /** Envoie un heartbeat au serveur avec la télémétrie courante. */
    suspend fun sendHeartbeat(context: Context) {
        val sims = SubscriptionsHelper.getActiveSimCards(context)
        val pendingCount = inboxUploadService.pendingCount()

        api.heartbeat(
            GatewayApi.HeartbeatRequest(
                battery = null,
                charging = null,
                network = null,
                appVersion = BuildConfig.VERSION_NAME,
                pendingQueue = pendingCount,
                sims = sims.map {
                    GatewayApi.SimInfo(
                        slotIndex = it.slotIndex,
                        phoneNumber = it.phoneNumber,
                        carrierName = it.carrierName,
                    )
                }
            )
        )
    }

    // ─── Upload SMS ──────────────────────────────────────────────────────────

    /**
     * Enfile un SMS reçu pour envoi vers relio-server.
     * Filtre par expéditeur autorisé — si la liste est vide ou si l'expéditeur
     * n'est pas dedans, le SMS reste sur le téléphone (protection vie privée).
     */
    fun enqueueInboxMessage(
        context: Context,
        message: InboxMessage,
        sender: String,
        recipient: String?,
        simNumber: Int?,
        date: Date,
    ) {
        if (!settings.enabled || !settings.isPaired) return
        val allowed = settings.allowedSenders
        if (allowed.isEmpty() || allowed.none { it.equals(sender, ignoreCase = true) }) return
        inboxUploadService.enqueue(context, message, sender, recipient, simNumber, date)
    }

    /** Appelé par InboxUploadWorker — envoie un lot de SMS vers relio-server. */
    internal suspend fun uploadSms(messages: List<GatewayApi.SmsMessage>): GatewayApi.SendSmsResponse {
        return api.sendSms(messages)
    }
}
