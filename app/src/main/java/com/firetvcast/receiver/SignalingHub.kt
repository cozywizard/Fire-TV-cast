package com.firetvcast.receiver

import org.json.JSONObject

/**
 * Relays WebRTC signaling messages between the one TV "receiver" page (the WebView in this app)
 * and the one active "sender" page (Chrome on the Mac).
 *
 * The hub is deliberately dumb: apart from a few presence notifications it forwards messages
 * untouched, except that it rewrites obfuscated mDNS ICE candidates (xxxxxxxx-....local) into
 * real LAN IPs. Browsers hide local IPs behind mDNS names, and not every Fire TV WebView can
 * resolve those, so we substitute the address we already see on the socket.
 */
object SignalingHub {

    interface Peer {
        /** "receiver" or "sender". */
        val role: String
        /** IP address of the remote end of this socket. */
        val remoteIp: String
        /** The host (TV IP) the peer used to reach us, from its Host header. */
        val hostIp: String
        /** Human readable device hint (from the User-Agent). */
        val deviceName: String
        fun sendText(text: String)
        fun closeQuietly()
    }

    private val MDNS = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\.local")

    private var receiver: Peer? = null
    private var sender: Peer? = null

    private class Outgoing(val peer: Peer, val text: String, val closeAfter: Boolean = false)

    fun join(peer: Peer) {
        val out = mutableListOf<Outgoing>()
        synchronized(this) {
            if (peer.role == ROLE_RECEIVER) {
                receiver?.takeIf { it !== peer }?.let { out += Outgoing(it, msg("replaced"), closeAfter = true) }
                receiver = peer
                out += Outgoing(peer, msg("hello") { put("senderConnected", sender != null) })
                sender?.let { out += Outgoing(it, msg("receiver-ready")) }
            } else {
                sender?.takeIf { it !== peer }?.let { old ->
                    out += Outgoing(old, msg("replaced"), closeAfter = true)
                    receiver?.let { out += Outgoing(it, msg("sender-left")) }
                }
                sender = peer
                out += Outgoing(peer, msg("hello") { put("receiverReady", receiver != null) })
                receiver?.let { out += Outgoing(it, msg("sender-joined") { put("name", peer.deviceName) }) }
            }
        }
        deliver(out)
    }

    fun leave(peer: Peer) {
        val out = mutableListOf<Outgoing>()
        synchronized(this) {
            if (receiver === peer) {
                receiver = null
                sender?.let { out += Outgoing(it, msg("receiver-left")) }
            } else if (sender === peer) {
                sender = null
                receiver?.let { out += Outgoing(it, msg("sender-left")) }
            }
        }
        deliver(out)
    }

    fun onMessage(from: Peer, text: String) {
        val type = try {
            JSONObject(text).optString("type")
        } catch (e: Exception) {
            return
        }
        if (type == "ping") return

        val out = mutableListOf<Outgoing>()
        synchronized(this) {
            val s = sender
            val r = receiver
            when {
                from === s -> {
                    if (r == null) {
                        out += Outgoing(from, msg("error") { put("message", "The TV app is not ready yet.") })
                    } else {
                        out += Outgoing(r, rewriteMdns(text, from.remoteIp))
                    }
                }
                from === r -> {
                    if (s != null) out += Outgoing(s, rewriteMdns(text, s.hostIp))
                }
                // Messages from replaced / stale peers are ignored.
            }
        }
        deliver(out)
    }

    fun rewriteMdns(text: String, ip: String): String =
        if (ip.isBlank() || !text.contains(".local")) text else MDNS.replace(text, ip)

    @Synchronized
    fun hasSender(): Boolean = sender != null

    private fun deliver(out: List<Outgoing>) {
        for (o in out) {
            o.peer.sendText(o.text)
            if (o.closeAfter) o.peer.closeQuietly()
        }
    }

    private fun msg(type: String, fill: JSONObject.() -> Unit = {}): String =
        JSONObject().put("type", type).apply(fill).toString()

    const val ROLE_RECEIVER = "receiver"
    const val ROLE_SENDER = "sender"
}
