package me.capcom.smsgateway.modules.gateway

import okhttp3.Interceptor
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Intercepteur OkHttp qui signe chaque requête avec HMAC-SHA256.
 *
 * Chaîne canonique :
 *   timestamp \n nonce \n METHOD \n /path?query \n sha256(rawBody)
 *
 * En-têtes ajoutés :
 *   X-Device-Id, X-Timestamp, X-Nonce, X-Signature
 *
 * Si deviceId ou deviceSecret sont null, la requête passe sans signature
 * (utilisé pour /pair qui ne nécessite pas d'auth).
 */
internal class HmacInterceptor(
    private val deviceId: () -> String?,
    private val deviceSecret: () -> String?,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val id = deviceId() ?: return chain.proceed(original)
        val secret = deviceSecret() ?: return chain.proceed(original)

        val timestamp = (System.currentTimeMillis() / 1000).toString()
        val nonce = generateNonce()

        // Lire le corps pour calculer son hash SHA-256
        val bodyBytes: ByteArray = original.body?.let { body ->
            val buffer = Buffer()
            body.writeTo(buffer)
            buffer.readByteArray()
        } ?: ByteArray(0)

        val bodyHash = sha256Hex(bodyBytes)
        val url = original.url
        val pathAndQuery = url.encodedPath +
            if (url.encodedQuery != null) "?${url.encodedQuery}" else ""

        val canonical = "$timestamp\n$nonce\n${original.method}\n$pathAndQuery\n$bodyHash"
        val signature = hmacSha256Hex(secret, canonical)

        // Reconstruire le corps pour qu'il soit lisible par OkHttp (le Buffer original est consommé)
        val rebuiltBody: RequestBody? = if (bodyBytes.isNotEmpty()) {
            RequestBody.create(original.body?.contentType(), bodyBytes)
        } else {
            original.body
        }

        val signed = original.newBuilder()
            .header("X-Device-Id", id)
            .header("X-Timestamp", timestamp)
            .header("X-Nonce", nonce)
            .header("X-Signature", signature)
            .method(original.method, rebuiltBody)
            .build()

        return chain.proceed(signed)
    }

    private fun generateNonce(): String {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun sha256Hex(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(data)
            .joinToString("") { "%02x".format(it) }

    private fun hmacSha256Hex(secret: String, data: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
