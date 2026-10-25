package me.capcom.smsgateway.modules.gateway

import me.capcom.smsgateway.modules.gateway.inbox.InboxUploadRepository
import me.capcom.smsgateway.modules.gateway.inbox.InboxUploadService
import me.capcom.smsgateway.ui.HomeViewModel
import me.capcom.smsgateway.ui.MerchantPortalViewModel
import me.capcom.smsgateway.ui.OperatorsViewModel
import me.capcom.smsgateway.ui.PairingViewModel
import org.koin.androidx.viewmodel.dsl.viewModelOf
import org.koin.core.module.dsl.singleOf
import org.koin.dsl.module

val gatewayModule = module {
    singleOf(::GatewayService)
    singleOf(::InboxUploadRepository)
    singleOf(::InboxUploadService)
    viewModelOf(::PairingViewModel)
    viewModelOf(::HomeViewModel)
    viewModelOf(::OperatorsViewModel)
    viewModelOf(::MerchantPortalViewModel)
}

internal const val MODULE_NAME = "gateway"
