package me.capcom.smsgateway.modules.gateway.inbox

import androidx.lifecycle.LiveData
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface InboxUploadDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: InboxUploadEntity)

    @Query(
        """
        SELECT * FROM gateway__inbox_upload
        ORDER BY id ASC
        LIMIT :limit
    """
    )
    suspend fun getPending(
        limit: Int = 100,
    ): List<InboxUploadEntity>

    @Query("SELECT COUNT(*) FROM gateway__inbox_upload")
    fun countPendingLive(): LiveData<Int>

    /** Returns a map of sim_slot → pending count for all pending messages. */
    @Query("SELECT sim_slot, COUNT(*) as cnt FROM gateway__inbox_upload GROUP BY sim_slot")
    suspend fun countPendingBySlot(): List<SlotCount>

    @Query("DELETE FROM gateway__inbox_upload WHERE id IN (:ids)")
    suspend fun delete(ids: List<Long>)
}

/** Projection for per-SIM pending count query. */
data class SlotCount(
    val sim_slot: Int?,
    val cnt: Int,
)
