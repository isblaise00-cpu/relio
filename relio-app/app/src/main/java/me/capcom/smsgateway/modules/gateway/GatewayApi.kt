package me.capcom.smsgateway.modules.gateway

import com.google.gson.annotations.SerializedName
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.UserAgent
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.gson.gson
import me.capcom.smsgateway.BuildConfig
import me.capcom.smsgateway.extensions.configure
import java.util.Date

/**
 * Client HTTP vers relio-server (API appareil).
 *
 * Base URL : https://votre-serveur.com/device/v1
 *
 * Routes :
 *   POST /pair        — appairage (sans auth HMAC)
 *   GET  /config      — configuration depuis le serveur
 *   POST /heartbeat   — signal de vie + télémétrie
 *   POST /sms         — envoi des SMS reçus par lot
 */
class GatewayApi(
    private val baseUrl: String,
    private val deviceId: () -> String?,
    private val deviceSecret: () -> String?,
) {
    // Client sans auth — uniquement pour /pair
    private val pairClient = HttpClient(OkHttp) {
        install(UserAgent) { agent = "me.capcom.smsgateway/${BuildConfig.VERSION_NAME}" }
        install(ContentNegotiation) { gson { configure() } }
        expectSuccess = true
    }

    // Client avec intercepteur HMAC — toutes les routes authentifiées
    private val client = HttpClient(OkHttp) {
        install(UserAgent) { agent = "me.capcom.smsgateway/${BuildConfig.VERSION_NAME}" }
        install(ContentNegotiation) { gson { configure() } }
        expectSuccess = true
        engine {
            addInterceptor(HmacInterceptor(deviceId, deviceSecret))
        }
    }

    /** Appairage : échange le code 6 chiffres contre device_id + device_secret. */
    suspend fun pair(code: String, name: String): PairResponse {
        return pairClient.post("$baseUrl/pair") {
            contentType(ContentType.Application.Json)
            setBody(PairRequest(code, name))
        }.body()
    }

    /** Configuration : expéditeurs à surveiller, intervalle heartbeat, taille max des lots. */
    suspend fun getConfig(): DeviceConfig {
        return client.get("$baseUrl/config").body()
    }

    /** Heartbeat : signal de vie + télémétrie (batterie, réseau, SIMs). */
    suspend fun heartbeat(payload: HeartbeatRequest) {
        client.post("$baseUrl/heartbeat") {
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
    }

    /** Envoi des SMS reçus par lot (idempotent via l'id local). */
    suspend fun sendSms(messages: List<SmsMessage>): SendSmsResponse {
        return client.post("$baseUrl/sms") {
            contentType(ContentType.Application.Json)
            setBody(SendSmsRequest(messages))
        }.body()
    }

    /** Met à jour les webhooks de paiement du marchand depuis l'app. */
    suspend fun updateWebhooks(successUrl: String?, failureUrl: String?) {
        client.patch("$baseUrl/webhooks") {
            contentType(ContentType.Application.Json)
            setBody(UpdateWebhooksRequest(successUrl, failureUrl))
        }
    }

    // ─── Requêtes ────────────────────────────────────────────────────────────

    data class PairRequest(val code: String, val name: String)

    data class HeartbeatRequest(
        val battery: Int?,
        val charging: Boolean?,
        val network: String?,
        @SerializedName("app_version") val appVersion: String,
        @SerializedName("pending_queue") val pendingQueue: Int,
        val sims: List<SimInfo>,
    )

    data class SimInfo(
        @SerializedName("slot_index") val slotIndex: Int,
        @SerializedName("phone_number") val phoneNumber: String?,
        @SerializedName("carrier_name") val carrierName: String?,
    )

    data class SmsMessage(
        val id: String,
        val sender: String,
        val body: String,
        @SerializedName("received_at") val receivedAt: Date,
        @SerializedName("sim_slot") val simSlot: Int?,
        @SerializedName("sim_phone") val simPhone: String?,
        val source: String = "live",
    )

    data class SendSmsRequest(val messages: List<SmsMessage>)

    data class UpdateWebhooksRequest(
        @SerializedName("webhook_success") val webhookSuccess: String?,
        @SerializedName("webhook_failure") val webhookFailure: String?,
    )

    // ─── Réponses ────────────────────────────────────────────────────────────

    data class PairResponse(
        @SerializedName("device_id") val deviceId: String,
        @SerializedName("device_secret") val deviceSecret: String,
        val merchant: MerchantInfo,
    )

    data class MerchantInfo(val id: String, val name: String)

    data class DeviceConfig(
        @SerializedName("device_id") val deviceId: String,
        val senders: List<String>,
        @SerializedName("heartbeat_interval_s") val heartbeatIntervalS: Int,
        @SerializedName("max_batch") val maxBatch: Int,
        @SerializedName("server_time") val serverTime: String?,
        @SerializedName("merchant_name") val merchantName: String?,
        @SerializedName("merchant_key") val merchantKey: String?,
        @SerializedName("webhook_success") val webhookSuccess: String?,
        @SerializedName("webhook_failure") val webhookFailure: String?,
    )

    data class SendSmsResponse(val results: List<SmsResult>)

    data class SmsResult(
        val id: String,
        @SerializedName("sms_id") val smsId: String?,
        val status: String,
        val reasons: List<String>?,
        @SerializedName("intent_id") val intentId: String?,
        @SerializedName("intent_reference") val intentReference: String?,
    )
}
