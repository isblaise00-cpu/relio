package me.capcom.smsgateway.ui

import android.content.Context
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import me.capcom.smsgateway.modules.gateway.GatewayService

class PairingViewModel(
    private val gatewaySvc: GatewayService,
) : ViewModel() {

    sealed class State {
        object Idle : State()
        object Loading : State()
        data class Success(val merchantName: String) : State()
        data class Error(val message: String) : State()
    }

    private val _state = MutableLiveData<State>(State.Idle)
    val state: LiveData<State> = _state

    fun pair(context: Context, code: String, deviceName: String) {
        if (_state.value is State.Loading) return

        val trimmedCode = code.trim()
        val trimmedName = deviceName.trim()

        if (trimmedCode.length != 6 || !trimmedCode.all { it.isDigit() }) {
            _state.value = State.Error("Le code doit contenir exactement 6 chiffres")
            return
        }
        if (trimmedName.isBlank()) {
            _state.value = State.Error("Veuillez saisir un nom pour cet appareil")
            return
        }

        _state.value = State.Loading
        viewModelScope.launch {
            try {
                val response = gatewaySvc.pair(context, trimmedCode, trimmedName)
                _state.value = State.Success(response.merchant.name)
            } catch (e: Exception) {
                _state.value = State.Error(e.message ?: "Erreur inconnue")
            }
        }
    }

    fun resetError() {
        if (_state.value is State.Error) {
            _state.value = State.Idle
        }
    }
}
