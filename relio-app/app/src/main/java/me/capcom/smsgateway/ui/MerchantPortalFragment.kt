package me.capcom.smsgateway.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.view.isVisible
import androidx.fragment.app.Fragment
import me.capcom.smsgateway.MainActivity
import me.capcom.smsgateway.R
import me.capcom.smsgateway.databinding.FragmentMerchantPortalBinding
import org.koin.androidx.viewmodel.ext.android.viewModel

class MerchantPortalFragment : Fragment() {

    private var _binding: FragmentMerchantPortalBinding? = null
    private val binding get() = _binding!!

    private val vm: MerchantPortalViewModel by viewModel()

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View {
        _binding = FragmentMerchantPortalBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        // ─── Observateurs ─────────────────────────────────────────────────────

        vm.merchantName.observe(viewLifecycleOwner) { name ->
            binding.textMerchantName.text = name ?: getString(R.string.not_available)
        }

        vm.merchantKey.observe(viewLifecycleOwner) { key ->
            binding.textApiKey.text = key ?: getString(R.string.not_available)
        }

        vm.webhookSuccess.observe(viewLifecycleOwner) { url ->
            if (binding.editWebhookSuccess.text.isNullOrEmpty()) {
                binding.editWebhookSuccess.setText(url ?: "")
            }
        }

        vm.webhookFailure.observe(viewLifecycleOwner) { url ->
            if (binding.editWebhookFailure.text.isNullOrEmpty()) {
                binding.editWebhookFailure.setText(url ?: "")
            }
        }

        vm.saving.observe(viewLifecycleOwner) { saving ->
            binding.btnSaveWebhooks.isEnabled = !saving
            binding.btnSaveWebhooks.text = if (saving) getString(R.string.saving) else getString(R.string.save_webhooks)
        }

        vm.saveSuccess.observe(viewLifecycleOwner) { success ->
            binding.textSaveStatus.isVisible = success
            if (success) {
                binding.textSaveStatus.text = getString(R.string.webhooks_saved)
                binding.textSaveStatus.postDelayed({
                    if (_binding != null) binding.textSaveStatus.isVisible = false
                }, 2500)
            }
        }

        vm.error.observe(viewLifecycleOwner) { msg ->
            if (!msg.isNullOrEmpty()) {
                Toast.makeText(requireContext(), msg, Toast.LENGTH_LONG).show()
            }
        }

        // ─── Actions ──────────────────────────────────────────────────────────

        binding.btnCopyApiKey.setOnClickListener {
            val key = vm.merchantKey.value ?: return@setOnClickListener
            val clipboard = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("api_key", key))
            Toast.makeText(requireContext(), getString(R.string.api_key_copied), Toast.LENGTH_SHORT).show()
        }

        binding.btnSaveWebhooks.setOnClickListener {
            val successUrl = binding.editWebhookSuccess.text?.toString() ?: ""
            val failureUrl = binding.editWebhookFailure.text?.toString() ?: ""
            vm.saveWebhooks(successUrl, failureUrl)
        }

        binding.btnAdvancedSettings.setOnClickListener {
            requireActivity().supportFragmentManager.beginTransaction()
                .replace(R.id.fragmentContainer, SettingsFragment.newInstance())
                .addToBackStack(null)
                .commit()
        }

        binding.btnDisconnect.setOnClickListener {
            AlertDialog.Builder(requireContext())
                .setTitle(R.string.disconnect_confirm_title)
                .setMessage(R.string.disconnect_confirm_message)
                .setPositiveButton(R.string.disconnect_confirm_yes) { _, _ ->
                    vm.unpair(requireContext())
                    val intent = Intent(requireContext(), MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                    }
                    startActivity(intent)
                }
                .setNegativeButton(R.string.disconnect_confirm_no, null)
                .show()
        }

        // Rafraîchissement silencieux au démarrage
        vm.refresh()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        fun newInstance() = MerchantPortalFragment()
    }
}
