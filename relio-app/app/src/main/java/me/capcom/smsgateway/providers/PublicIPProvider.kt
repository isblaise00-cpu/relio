package me.capcom.smsgateway.providers

class PublicIPProvider : IPProvider {
    override suspend fun getIP(): String? = null
}
