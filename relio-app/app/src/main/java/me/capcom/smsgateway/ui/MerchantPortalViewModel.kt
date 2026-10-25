package me.capcom.smsgateway.ui

import android.content.Context
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import me.capcom.smsgateway.modules.gateway.GatewayService
import me.capcom.smsgateway.modules.gateway.GatewaySettings

class MerchantPortalViewModel(
    private val gatewayService: GatewayService,
    private val settings: GatewaySettings,
) : ViewModel() {

    private val _merchantName = MutableLiveData(settings.merchantName)
    val merchantName: LiveData<String?> = _merchantName

    private val _merchantKey = MutableLiveData(settings.merchantKey)
    val merchantKey: LiveData<String?> = _merchantKey

    private val _webhookSuccess = MutableLiveData(settings.webhookSuccess)
    val webhookSuccess: LiveData<String?> = _webhookSuccess

    private val _webhookFailure = MutableLiveData(settings.webhookFailure)
    val webhookFailure: LiveData<String?> = _webhookFailure

    private val _saving = MutableLiveData(false)
    val saving: LiveData<Boolean> = _saving

    private val _saveSuccess = MutableLiveData(false)
    val saveSuccess: LiveData<Boolean> = _saveSuccess

    private val _error = MutableLiveData<String?>(null)
    val error: LiveData<String?> = _error

    /** Rafraîchit les infos merchant depuis le serveur (en tâche de fond). */
    fun refresh() {
        viewModelScope.launch {
            try {
                gatewayService.syncConfig()
                _merchantName.postValue(settings.merchantName)
                _merchantKey.postValue(settings.merchantKey)
                _webhookSuccess.postValue(settings.webhookSuccess)
                _webhookFailure.postValue(settings.webhookFailure)
            } catch (_: Exception) {
                // Données en cache restent affichées
            }
        }
    }

    /** Envoie les webhooks au serveur et met à jour le cache. */
    fun saveWebhooks(successUrl: String, failureUrl: String) {
        viewModelScope.launch {
            _saving.postValue(true)
            _error.postValue(null)
            _saveSuccess.postValue(false)
            try {
                val success = successUrl.trim().takeIf { it.isNotBlank() }
                val failure = failureUrl.trim().takeIf { it.isNotBlank() }
                gatewayService.updateWebhooks(success, failure)
                _webhookSuccess.postValue(success)
                _webhookFailure.postValue(failure)
                _saveSuccess.postValue(true)
            } catch (e: Exception) {
                _error.postValue(e.message ?: "Erreur inconnue")
            } finally {
                _saving.postValue(false)
            }
        }
    }

    /** Dissocie l'appareil du marchand. */
    fun unpair(context: Context) {
        gatewayService.unpair(context)
    }
}
