package me.capcom.smsgateway

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import me.capcom.smsgateway.databinding.ActivityMainBinding
import me.capcom.smsgateway.helpers.LocaleHelper
import me.capcom.smsgateway.modules.gateway.GatewaySettings
import me.capcom.smsgateway.ui.HomeFragment
import me.capcom.smsgateway.ui.HolderFragment
import me.capcom.smsgateway.ui.MerchantPortalFragment
import me.capcom.smsgateway.ui.OperatorsFragment
import me.capcom.smsgateway.ui.PairingFragment
import me.capcom.smsgateway.ui.SettingsFragment
import org.koin.android.ext.android.inject

class MainActivity : AppCompatActivity(), PairingFragment.PairingHost {

    private lateinit var binding: ActivityMainBinding
    private val gatewaySettings: GatewaySettings by inject()

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(LocaleHelper.onAttach(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        if (savedInstanceState == null) {
            if (!gatewaySettings.isPaired) {
                showPairingScreen()
                return
            }
            val tabIndex = intent.getIntExtra(EXTRA_TAB_INDEX, TAB_INDEX_HOME)
            showMainTabs(tabIndex)
        }

        binding.bottomNavigation.setOnItemSelectedListener { item ->
            val tabIndex = when (item.itemId) {
                R.id.nav_home -> TAB_INDEX_HOME
                R.id.nav_messages -> TAB_INDEX_MESSAGES
                R.id.nav_operators -> TAB_INDEX_OPERATORS
                R.id.nav_settings -> TAB_INDEX_SETTINGS
                else -> TAB_INDEX_HOME
            }
            navigateTo(tabIndex)
            true
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (!gatewaySettings.isPaired) return
        val tabIndex = intent.getIntExtra(EXTRA_TAB_INDEX, TAB_INDEX_HOME)
        navigateTo(tabIndex)
        binding.bottomNavigation.selectedItemId = menuIdForTab(tabIndex)
    }

    // ─── PairingHost ─────────────────────────────────────────────────────────

    override fun onPairingComplete() {
        showMainTabs(TAB_INDEX_HOME)
    }

    // ─── Navigation ──────────────────────────────────────────────────────────

    private fun showPairingScreen() {
        binding.bottomNavigation.visibility = android.view.View.GONE
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, PairingFragment.newInstance())
            .commitNow()
    }

    private fun showMainTabs(tabIndex: Int) {
        binding.bottomNavigation.visibility = android.view.View.VISIBLE
        binding.bottomNavigation.selectedItemId = menuIdForTab(tabIndex)
        navigateTo(tabIndex)
    }

    private fun navigateTo(tabIndex: Int) {
        val fragment: Fragment = when (tabIndex) {
            TAB_INDEX_HOME -> HomeFragment.newInstance()
            TAB_INDEX_MESSAGES -> HolderFragment.newInstance()
            TAB_INDEX_OPERATORS -> OperatorsFragment.newInstance()
            TAB_INDEX_SETTINGS -> MerchantPortalFragment.newInstance()
            else -> HomeFragment.newInstance()
        }
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, fragment)
            .commitNow()
    }

    private fun menuIdForTab(tabIndex: Int): Int = when (tabIndex) {
        TAB_INDEX_HOME -> R.id.nav_home
        TAB_INDEX_MESSAGES -> R.id.nav_messages
        TAB_INDEX_OPERATORS -> R.id.nav_operators
        TAB_INDEX_SETTINGS -> R.id.nav_settings
        else -> R.id.nav_home
    }

    companion object {
        const val TAB_INDEX_HOME = 0
        const val TAB_INDEX_MESSAGES = 1
        const val TAB_INDEX_OPERATORS = 2
        const val TAB_INDEX_SETTINGS = 3

        private const val EXTRA_TAB_INDEX = "tabIndex"

        fun starter(context: Context, tabIndex: Int): Intent {
            return Intent(context, MainActivity::class.java).apply {
                putExtra(EXTRA_TAB_INDEX, tabIndex)
            }
        }
    }
}
