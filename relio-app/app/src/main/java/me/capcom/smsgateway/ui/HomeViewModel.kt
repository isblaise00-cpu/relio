package me.capcom.smsgateway.ui

import android.content.Context
import androidx.lifecycle.LiveData
import androidx.lifecycle.MediatorLiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.WorkInfo
import androidx.work.WorkManager
import kotlinx.coroutines.launch
import me.capcom.smsgateway.helpers.SubscriptionsHelper
import me.capcom.smsgateway.modules.connection.ConnectionService
import me.capcom.smsgateway.modules.gateway.GatewaySettings
import me.capcom.smsgateway.modules.gateway.inbox.InboxUploadRepository
import me.capcom.smsgateway.modules.localserver.domain.SimCard

class HomeViewModel(
    private val gatewaySettings: GatewaySettings,
    private val connectionService: ConnectionService,
    private val inboxRepo: InboxUploadRepository,
) : ViewModel() {

    // ─── Connectivity ─────────────────────────────────────────────────────────

    /** true = internet available */
    val isConnected: LiveData<Boolean> = connectionService.status

    // ─── Gateway state ────────────────────────────────────────────────────────

    val isPaired: Boolean get() = gatewaySettings.isPaired
    val deviceId: String? get() = gatewaySettings.deviceId

    /** true = workers are scheduled in WorkManager */
    private val _workersActive = MutableLiveData(false)
    val workersActive: LiveData<Boolean> = _workersActive

    /** true = serveur a accusé réception d'un heartbeat il y a moins de 20 min */
    private val _serverReachable = MutableLiveData(false)
    val serverReachable: LiveData<Boolean> = _serverReachable

    fun refreshWorkersState(context: Context) {
        // Vérification synchrone : le serveur est-il encore joignable ?
        val lastHb = gatewaySettings.lastHeartbeatSuccessAt
        _serverReachable.value = lastHb != null &&
            (System.currentTimeMillis() - lastHb) < SERVER_UNREACHABLE_AFTER_MS

        // Vérification asynchrone : les workers WorkManager sont-ils planifiés ?
        val liveData = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWorkLiveData("relio_heartbeat")
        val observer = object : androidx.lifecycle.Observer<List<WorkInfo>> {
            override fun onChanged(infos: List<WorkInfo>) {
                _workersActive.postValue(
                    infos.any {
                        it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING
                    }
                )
                liveData.removeObserver(this)
            }
        }
        liveData.observeForever(observer)
    }

    /** Overall relay status: paired + connected + workers up + server reachable */
    val relayStatus: LiveData<RelayStatus> = object : MediatorLiveData<RelayStatus>() {
        private var connected = false
        private var workers = false
        private var serverOk = false

        init {
            addSource(isConnected) { v -> connected = v; update() }
            addSource(workersActive) { v -> workers = v; update() }
            addSource(serverReachable) { v -> serverOk = v; update() }
            update()
        }

        private fun update() {
            value = when {
                !gatewaySettings.isPaired -> RelayStatus.NOT_PAIRED
                !connected -> RelayStatus.NO_INTERNET
                !workers -> RelayStatus.PAUSED
                !serverOk -> RelayStatus.SERVER_UNREACHABLE
                else -> RelayStatus.ACTIVE
            }
        }
    }

    // ─── Queue ────────────────────────────────────────────────────────────────

    /** Live count of SMS pending upload */
    val pendingCount: LiveData<Int> = inboxRepo.countPendingLive()

    // ─── SIM cards ────────────────────────────────────────────────────────────

    private val _simCards = MutableLiveData<List<SimCard>>(emptyList())
    val simCards: LiveData<List<SimCard>> = _simCards

    fun refreshSimCards(context: Context) {
        viewModelScope.launch {
            _simCards.postValue(SubscriptionsHelper.getActiveSimCards(context))
        }
    }

    // ─── Types ────────────────────────────────────────────────────────────────

    enum class RelayStatus {
        NOT_PAIRED,
        NO_INTERNET,
        PAUSED,
        SERVER_UNREACHABLE,
        ACTIVE,
    }

    companion object {
        /** Au-delà de 20 min sans heartbeat réussi → serveur considéré injoignable. */
        private const val SERVER_UNREACHABLE_AFTER_MS = 20 * 60 * 1000L
    }
}
