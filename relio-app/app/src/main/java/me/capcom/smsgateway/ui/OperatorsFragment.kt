package me.capcom.smsgateway.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import me.capcom.smsgateway.R
import me.capcom.smsgateway.databinding.FragmentOperatorsBinding
import me.capcom.smsgateway.ui.adapters.OperatorsAdapter
import org.koin.androidx.viewmodel.ext.android.viewModel

class OperatorsFragment : Fragment() {

    private var _binding: FragmentOperatorsBinding? = null
    private val binding get() = _binding!!

    private val vm: OperatorsViewModel by viewModel()
    private val adapter = OperatorsAdapter()

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentOperatorsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.recyclerOperators.adapter = adapter

        // Connection badge
        vm.isConnected.observe(viewLifecycleOwner) { connected ->
            val dotColor = if (connected) R.color.relio_success else R.color.relio_text_disabled
            binding.connectionDot.backgroundTintList =
                ContextCompat.getColorStateList(requireContext(), dotColor)
            binding.connectionText.text =
                if (connected) getString(R.string.connected)
                else getString(R.string.disconnected)
        }

        // Operators list
        vm.operators.observe(viewLifecycleOwner) { items ->
            adapter.submitList(items)
            val empty = items.isEmpty()
            binding.recyclerOperators.isVisible = !empty
            binding.emptyState.isVisible = empty
        }

        vm.refresh(requireContext())
    }

    override fun onResume() {
        super.onResume()
        vm.refresh(requireContext())
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        fun newInstance() = OperatorsFragment()
    }
}
