package me.capcom.smsgateway.ui

import android.content.Context
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import me.capcom.smsgateway.helpers.SubscriptionsHelper
import me.capcom.smsgateway.modules.connection.ConnectionService
import me.capcom.smsgateway.modules.gateway.inbox.InboxUploadRepository
import me.capcom.smsgateway.modules.localserver.domain.SimCard

class OperatorsViewModel(
    private val connectionService: ConnectionService,
    private val inboxRepo: InboxUploadRepository,
) : ViewModel() {

    data class OperatorItem(
        val sim: SimCard,
        /** Pending SMS in queue for this SIM slot (null = unknown). */
        val pendingCount: Int,
    )

    private val _operators = MutableLiveData<List<OperatorItem>>(emptyList())
    val operators: LiveData<List<OperatorItem>> = _operators

    val isConnected: LiveData<Boolean> = connectionService.status

    fun refresh(context: Context) {
        viewModelScope.launch {
            val sims = SubscriptionsHelper.getActiveSimCards(context)
            val pendingBySlot = inboxRepo.countPendingBySlot()

            _operators.postValue(
                sims.map { sim ->
                    OperatorItem(
                        sim = sim,
                        pendingCount = pendingBySlot[sim.slotIndex] ?: 0,
                    )
                }
            )
        }
    }
}
