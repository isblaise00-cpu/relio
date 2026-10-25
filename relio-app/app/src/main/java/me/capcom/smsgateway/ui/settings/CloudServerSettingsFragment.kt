package me.capcom.smsgateway.ui.settings

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import androidx.preference.Preference
import me.capcom.smsgateway.MainActivity
import me.capcom.smsgateway.R
import me.capcom.smsgateway.modules.gateway.GatewayService
import me.capcom.smsgateway.modules.gateway.GatewaySettings
import org.koin.android.ext.android.inject

/**
 * Réglages du serveur relio — URL, identifiant appareil, désappairage.
 */
class CloudServerSettingsFragment : BasePreferenceFragment() {

    private val settings: GatewaySettings by inject()
    private val service: GatewayService by inject()

    @SuppressLint("NotifyDataSetChanged")
    override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
        setPreferencesFromResource(R.xml.cloud_server_preferences, rootKey)

        // Device ID (read-only)
        findPreference<Preference>("transient.device_id")?.summary =
            settings.deviceId ?: getString(R.string.n_a)

        // Unpair
        findPreference<Preference>("transient.unpair")?.apply {
            isEnabled = settings.isPaired
            summary = if (settings.isPaired)
                getString(R.string.unpair_summary)
            else
                getString(R.string.not_paired)

            onPreferenceClickListener = Preference.OnPreferenceClickListener {
                service.unpair(requireContext())
                // Return to pairing screen
                val intent = MainActivity.starter(requireContext(), MainActivity.TAB_INDEX_HOME)
                    .apply { addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK) }
                startActivity(intent)
                requireActivity().finish()
                true
            }
        }
    }


}
