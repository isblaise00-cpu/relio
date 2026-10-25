package me.capcom.smsgateway.modules.gateway.inbox

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * SMS en attente d'envoi vers relio-server.
 * Stocké en clair — le chiffrement E2E n'est pas utilisé avec relio-server.
 */
@Entity(
    tableName = "gateway__inbox_upload",
    indices = [
        Index(value = ["message_id"], unique = true),
    ]
)
data class InboxUploadEntity(
    @PrimaryKey(autoGenerate = true)
    val id: Long,

    /** Identifiant local unique du SMS (déterministe pour l'idempotence). */
    @ColumnInfo(name = "message_id")
    val messageId: String,

    /** Expéditeur du SMS (ex : "OrangeMoney"). */
    @ColumnInfo(name = "sender")
    val sender: String,

    /** Corps du SMS en clair. */
    @ColumnInfo(name = "body")
    val body: String,

    /** Index du slot SIM (0-indexé). Null si inconnu. */
    @ColumnInfo(name = "sim_slot")
    val simSlot: Int?,

    /** Numéro de téléphone de la SIM réceptrice. Null si indisponible. */
    @ColumnInfo(name = "sim_phone")
    val simPhone: String?,

    /** Timestamp de réception en millisecondes (epoch). */
    @ColumnInfo(name = "received_at")
    val receivedAt: Long,
)
