package me.capcom.smsgateway.ui.adapters

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import me.capcom.smsgateway.R
import me.capcom.smsgateway.databinding.ItemOperatorBinding
import me.capcom.smsgateway.ui.OperatorsViewModel

class OperatorsAdapter :
    ListAdapter<OperatorsViewModel.OperatorItem, OperatorsAdapter.ViewHolder>(DiffCb()) {

    inner class ViewHolder(private val binding: ItemOperatorBinding) :
        RecyclerView.ViewHolder(binding.root) {

        fun bind(item: OperatorsViewModel.OperatorItem) {
            val sim = item.sim
            val ctx = binding.root.context

            binding.textSlotBadge.text = "SIM${sim.simNumber}"
            binding.textCarrierName.text =
                sim.carrierName ?: ctx.getString(R.string.unknown_carrier)
            binding.textPhoneNumber.text =
                sim.phoneNumber ?: ctx.getString(R.string.phone_number_unavailable)
            binding.textPendingCount.text = item.pendingCount.toString()
            binding.textSlotIndex.text = sim.slotIndex.toString()
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemOperatorBinding.inflate(
            LayoutInflater.from(parent.context), parent, false
        )
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    private class DiffCb : DiffUtil.ItemCallback<OperatorsViewModel.OperatorItem>() {
        override fun areItemsTheSame(
            a: OperatorsViewModel.OperatorItem,
            b: OperatorsViewModel.OperatorItem,
        ) = a.sim.slotIndex == b.sim.slotIndex

        override fun areContentsTheSame(
            a: OperatorsViewModel.OperatorItem,
            b: OperatorsViewModel.OperatorItem,
        ) = a == b
    }
}
