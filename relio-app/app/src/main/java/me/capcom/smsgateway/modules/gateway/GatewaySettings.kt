package me.capcom.smsgateway.modules.gateway

import me.capcom.smsgateway.modules.settings.KeyValueStorage
import me.capcom.smsgateway.modules.settings.get

class GatewaySettings(
    private val storage: KeyValueStorage,
) {
    /** Le relais est actif (appareil associé et transmission activée). */
    var enabled: Boolean
        get() = storage.get<Boolean>(ENABLED) ?: false
        set(value) = storage.set(ENABLED, value)

    /** Identifiant unique de l'appareil attribué par relio-server lors du pairing. */
    var deviceId: String?
        get() = storage.get(DEVICE_ID)
        set(value) = storage.set(DEVICE_ID, value)

    /** Secret HMAC de l'appareil attribué par relio-server lors du pairing. */
    var deviceSecret: String?
        get() = storage.get(DEVICE_SECRET)
        set(value) = storage.set(DEVICE_SECRET, value)

    /** URL de base du serveur relio (pointe vers /device/v1). Fixée à la compilation. */
    val serverUrl: String get() = PUBLIC_URL

    /** Vrai si l'appareil a été associé (device_id + device_secret présents). */
    val isPaired: Boolean
        get() = deviceId != null && deviceSecret != null

    /**
     * Liste des expéditeurs autorisés à être relayés vers relio-server.
     * Mise à jour à chaque appel de /device/v1/config.
     * Si vide : aucun SMS n'est transmis (sécurité par défaut).
     */
    var allowedSenders: List<String>
        get() = storage.get<String?>(ALLOWED_SENDERS)
            ?.split(",")
            ?.filter { it.isNotBlank() }
            ?: emptyList()
        set(value) = storage.set(ALLOWED_SENDERS, value.joinToString(","))

    /** Nom du marchand (cache local, source de vérité = serveur). */
    var merchantName: String?
        get() = storage.get(MERCHANT_NAME)
        set(value) = storage.set(MERCHANT_NAME, value)

    /** Clé API publique du marchand (cache local, source de vérité = serveur). */
    var merchantKey: String?
        get() = storage.get(MERCHANT_KEY)
        set(value) = storage.set(MERCHANT_KEY, value)

    /** URL webhook succès de paiement (cache local). */
    var webhookSuccess: String?
        get() = storage.get(WEBHOOK_SUCCESS)
        set(value) = storage.set(WEBHOOK_SUCCESS, value)

    /** URL webhook échec de paiement (cache local). */
    var webhookFailure: String?
        get() = storage.get(WEBHOOK_FAILURE)
        set(value) = storage.set(WEBHOOK_FAILURE, value)

    /**
     * Timestamp (ms) du dernier heartbeat réussi envoyé à relio-server.
     * Null si aucun heartbeat n'a encore abouti depuis l'installation.
     */
    var lastHeartbeatSuccessAt: Long?
        get() = storage.get<Long?>(LAST_HEARTBEAT_SUCCESS_AT)
        set(value) = storage.set(LAST_HEARTBEAT_SUCCESS_AT, value)

    /** Supprime les credentials d'association. */
    fun clearPairing() {
        deviceId = null
        deviceSecret = null
        allowedSenders = emptyList()
        merchantName = null
        merchantKey = null
        webhookSuccess = null
        webhookFailure = null
    }

    companion object {
        private const val ENABLED = "ENABLED"
        private const val DEVICE_ID = "DEVICE_ID"
        private const val DEVICE_SECRET = "DEVICE_SECRET"
        private const val ALLOWED_SENDERS = "ALLOWED_SENDERS"
        private const val MERCHANT_NAME = "MERCHANT_NAME"
        private const val MERCHANT_KEY = "MERCHANT_KEY"
        private const val WEBHOOK_SUCCESS = "WEBHOOK_SUCCESS"
        private const val WEBHOOK_FAILURE = "WEBHOOK_FAILURE"
        private const val LAST_HEARTBEAT_SUCCESS_AT = "LAST_HEARTBEAT_SUCCESS_AT"
        /** URL fixe de relio-server. Modifier ici pour changer d'environnement. */
        const val PUBLIC_URL = "http://192.168.11.103:3000/device/v1"
    }
}
