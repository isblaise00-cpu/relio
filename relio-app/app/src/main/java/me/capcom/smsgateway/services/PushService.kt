package me.capcom.smsgateway.services

import android.content.Context
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Firebase Cloud Messaging service — placeholder.
 * relio-server ne pousse pas encore de notifications FCM vers l'appareil.
 * TODO : utiliser le token FCM pour réveiller l'appareil si nécessaire.
 */
class PushService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        Log.d(TAG, "New FCM token received (not used yet)")
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Log.d(TAG, "FCM message received (not processed): ${message.data}")
    }

    companion object {
        private const val TAG = "PushService"

        fun register(context: Context) {
            // No-op — FCM registration not needed until relio-server sends push notifications
        }
    }
}
