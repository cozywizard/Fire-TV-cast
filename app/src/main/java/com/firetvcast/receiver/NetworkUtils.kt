package com.firetvcast.receiver

import java.net.Inet4Address
import java.net.NetworkInterface

object NetworkUtils {
    /** IPv4 LAN addresses of this device, Wi-Fi/Ethernet first. */
    fun lanIPv4Addresses(): List<String> {
        val result = mutableListOf<Pair<Int, String>>()
        try {
            val ifaces = NetworkInterface.getNetworkInterfaces() ?: return emptyList()
            for (iface in ifaces.toList()) {
                if (!iface.isUp || iface.isLoopback) continue
                val name = iface.name.lowercase()
                val rank = when {
                    name.startsWith("wlan") -> 0
                    name.startsWith("eth") -> 1
                    name.startsWith("rmnet") || name.startsWith("dummy") || name.startsWith("p2p") -> 9
                    else -> 5
                }
                for (addr in iface.inetAddresses.toList()) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress && !addr.isLinkLocalAddress) {
                        addr.hostAddress?.let { result += rank to it }
                    }
                }
            }
        } catch (e: Exception) {
            // Ignore; we'll just report no addresses.
        }
        return result.sortedBy { it.first }.map { it.second }.distinct()
    }

    fun isLoopback(ip: String): Boolean {
        val clean = normalizeIp(ip)
        return clean.startsWith("127.") || clean == "::1" || clean == "0:0:0:0:0:0:0:1"
    }

    fun normalizeIp(ip: String): String = ip.trim().removePrefix("/").removePrefix("::ffff:")

    /** "192.168.1.5:8443" -> "192.168.1.5", "[fe80::1]:8443" -> "fe80::1" */
    fun hostFromHeader(host: String?): String {
        if (host.isNullOrBlank()) return ""
        val h = host.trim()
        if (h.startsWith("[")) return h.substringAfter("[").substringBefore("]")
        return h.substringBefore(":")
    }
}
