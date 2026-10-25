package me.capcom.smsgateway.modules.gateway.inbox

import androidx.lifecycle.LiveData

class InboxUploadRepository(
    private val dao: InboxUploadDao,
) {
    fun countPendingLive(): LiveData<Int> = dao.countPendingLive()

    /** Returns a map of sim_slot (null = unknown) → pending count. */
    suspend fun countPendingBySlot(): Map<Int?, Int> =
        dao.countPendingBySlot().associate { it.sim_slot to it.cnt }
    suspend fun enqueue(
        messageId: String,
        sender: String,
        body: String,
        simSlot: Int?,
        simPhone: String?,
        receivedAt: Long,
    ) {
        dao.insert(
            InboxUploadEntity(
                id = 0,
                messageId = messageId,
                sender = sender,
                body = body,
                simSlot = simSlot,
                simPhone = simPhone,
                receivedAt = receivedAt,
            )
        )
    }

    suspend fun getPending(limit: Int = 100): List<InboxUploadEntity> =
        dao.getPending(limit)

    suspend fun complete(ids: List<Long>) {
        if (ids.isEmpty()) return
        dao.delete(ids)
    }
}
