package me.capcom.smsgateway.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import me.capcom.smsgateway.R
import me.capcom.smsgateway.databinding.FragmentHomeBinding
import me.capcom.smsgateway.databinding.ItemSimCardBinding
import me.capcom.smsgateway.modules.localserver.domain.SimCard
import org.koin.androidx.viewmodel.ext.android.viewModel

class HomeFragment : Fragment() {

    private var _binding: FragmentHomeBinding? = null
    private val binding get() = _binding!!

    private val vm: HomeViewModel by viewModel()

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        // Device ID
        binding.textDeviceId.text = vm.deviceId ?: ""

        // Server URL — show device ID suffix for compact display
        binding.textServerUrl.text = vm.deviceId
            ?.let { "id: ${it.take(12)}…" }
            ?: getString(R.string.not_paired)

        // Relay status → header chip + queue card footer
        vm.relayStatus.observe(viewLifecycleOwner) { status ->
            updateStatusChip(status)
            updateQueueStatus(status)
        }

        // Pending count
        vm.pendingCount.observe(viewLifecycleOwner) { count ->
            binding.textPendingCount.text = count.toString()
            // Mini progress bar: 0 = empty, cap at 50 for visual
            binding.queueProgress.progress = (count.coerceAtMost(50) * 2)
        }

        // Connection badge
        vm.isConnected.observe(viewLifecycleOwner) { connected ->
            binding.textConnectionBadge.text =
                if (connected) getString(R.string.connected) else getString(R.string.disconnected)
        }

        // SIM cards
        vm.simCards.observe(viewLifecycleOwner) { sims ->
            refreshSimCards(sims)
        }

        vm.refreshSimCards(requireContext())
        vm.refreshWorkersState(requireContext())
    }

    override fun onResume() {
        super.onResume()
        vm.refreshWorkersState(requireContext())
        vm.refreshSimCards(requireContext())
    }

    // ─── UI helpers ───────────────────────────────────────────────────────────

    private fun updateStatusChip(status: HomeViewModel.RelayStatus) {
        val (dotColor, label) = when (status) {
            HomeViewModel.RelayStatus.ACTIVE ->
                R.color.relio_success to getString(R.string.relay_active)
            HomeViewModel.RelayStatus.NO_INTERNET ->
                R.color.relio_warning to getString(R.string.no_internet)
            HomeViewModel.RelayStatus.PAUSED ->
                R.color.relio_warning to getString(R.string.relay_paused)
            HomeViewModel.RelayStatus.SERVER_UNREACHABLE ->
                R.color.relio_error to getString(R.string.server_unreachable)
            HomeViewModel.RelayStatus.NOT_PAIRED ->
                R.color.relio_text_disabled to getString(R.string.not_paired)
        }
        binding.statusDot.backgroundTintList =
            ContextCompat.getColorStateList(requireContext(), dotColor)
        binding.statusText.text = label
    }

    private fun updateQueueStatus(status: HomeViewModel.RelayStatus) {
        binding.textQueueStatus.text = when (status) {
            HomeViewModel.RelayStatus.ACTIVE -> getString(R.string.relay_active_detail)
            HomeViewModel.RelayStatus.NO_INTERNET -> getString(R.string.no_internet_detail)
            HomeViewModel.RelayStatus.PAUSED -> getString(R.string.relay_paused_detail)
            HomeViewModel.RelayStatus.SERVER_UNREACHABLE -> getString(R.string.server_unreachable_detail)
            HomeViewModel.RelayStatus.NOT_PAIRED -> getString(R.string.not_paired)
        }
    }

    private fun refreshSimCards(sims: List<SimCard>) {
        binding.simCardsContainer.removeAllViews()
        binding.textNoSim.isVisible = sims.isEmpty()

        sims.forEach { sim ->
            val itemBinding = ItemSimCardBinding.inflate(
                layoutInflater, binding.simCardsContainer, false
            )
            itemBinding.textSlot.text = sim.simNumber.toString()
            itemBinding.textCarrier.text = sim.carrierName ?: getString(R.string.unknown_carrier)
            itemBinding.textPhone.text = sim.phoneNumber ?: getString(R.string.phone_number_unavailable)
            binding.simCardsContainer.addView(itemBinding.root)
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        fun newInstance() = HomeFragment()
    }
}
