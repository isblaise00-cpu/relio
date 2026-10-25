package me.capcom.smsgateway.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import me.capcom.smsgateway.databinding.FragmentPairingBinding
import me.capcom.smsgateway.modules.orchestrator.OrchestratorService
import org.koin.android.ext.android.inject
import org.koin.androidx.viewmodel.ext.android.viewModel

class PairingFragment : Fragment() {

    private var _binding: FragmentPairingBinding? = null
    private val binding get() = _binding!!

    private val vm: PairingViewModel by viewModel()
    private val orchestratorSvc: OrchestratorService by inject()

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentPairingBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.buttonPair.setOnClickListener {
            vm.pair(
                requireContext(),
                code = binding.editPairingCode.text?.toString() ?: "",
                deviceName = binding.editDeviceName.text?.toString() ?: "",
            )
        }

        vm.state.observe(viewLifecycleOwner) { state ->
            when (state) {
                is PairingViewModel.State.Idle -> {
                    binding.progressPairing.isVisible = false
                    binding.buttonPair.isEnabled = true
                    binding.textError.isVisible = false
                }

                is PairingViewModel.State.Loading -> {
                    binding.progressPairing.isVisible = true
                    binding.buttonPair.isEnabled = false
                    binding.textError.isVisible = false
                }

                is PairingViewModel.State.Success -> {
                    binding.progressPairing.isVisible = false
                    binding.buttonPair.isEnabled = true
                    binding.textError.isVisible = false
                    onPairingSuccess()
                }

                is PairingViewModel.State.Error -> {
                    binding.progressPairing.isVisible = false
                    binding.buttonPair.isEnabled = true
                    binding.textError.text = state.message
                    binding.textError.isVisible = true
                }
            }
        }
    }

    private fun onPairingSuccess() {
        // Request SMS permissions then start workers
        val needed = listOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.RECEIVE_MMS,
            Manifest.permission.READ_PHONE_NUMBERS
                .takeIf { Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU },
        ).filterNotNull().filter {
            ContextCompat.checkSelfPermission(requireContext(), it) !=
                PackageManager.PERMISSION_GRANTED
        }

        if (needed.isEmpty()) {
            launchMainApp()
        } else {
            permissionsRequest.launch(needed.toTypedArray())
        }
    }

    private fun launchMainApp() {
        orchestratorSvc.start(requireContext().applicationContext, false)
        // Tell MainActivity to switch to main tabs
        (activity as? PairingHost)?.onPairingComplete()
    }

    private val permissionsRequest = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        // Start regardless — some permissions are optional
        launchMainApp()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    /**
     * Implemented by the host Activity to switch to the main UI after pairing.
     */
    interface PairingHost {
        fun onPairingComplete()
    }

    companion object {
        fun newInstance() = PairingFragment()
    }
}
