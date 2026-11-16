package com.firetvcast.receiver

import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import java.io.IOException
import java.io.InputStream
import java.security.KeyStore
import javax.net.ssl.KeyManagerFactory

/**
 * Embedded web server. Two instances run:
 *  - HTTP on [HTTP_PORT]: serves the TV's own receiver page to the WebView (loopback only).
 *    Browsers on the network that hit this port are redirected to HTTPS.
 *  - HTTPS on [HTTPS_PORT]: serves the sender page that you open on the Mac.
 * Both expose the signaling WebSocket at /ws and share [SignalingHub].
 */
class CastServer(
    port: Int,
    private val secure: Boolean,
    private val assets: AssetSource,
    private val info: () -> String,
) : NanoWSD(null, port) {

    fun interface AssetSource {
        /** Returns the file under the web root, or null if it does not exist. */
        fun open(path: String): InputStream?
    }

    fun enableTls(keyStore: KeyStore, password: CharArray) {
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        kmf.init(keyStore, password)
        makeSecure(NanoHTTPD.makeSSLSocketFactory(keyStore, kmf), null)
    }

    /** Start without a socket read timeout so idle WebSockets stay open. */
    fun startServer() = start(0, false)

    override fun openWebSocket(handshake: IHTTPSession): WebSocket = PeerSocket(handshake)

    override fun serveHttp(session: IHTTPSession): Response {
        val remote = session.headers["remote-addr"] ?: ""
        if (!secure && !NetworkUtils.isLoopback(remote)) {
            // Someone typed http://<tv-ip>:8080 on the Mac: send them to the HTTPS page.
            val host = NetworkUtils.hostFromHeader(session.headers["host"])
            return newFixedLengthResponse(Response.Status.REDIRECT, MIME_HTML, "").apply {
                addHeader("Location", "https://$host:$HTTPS_PORT/")
            }
        }

        val uri = session.uri ?: "/"
        if (uri == "/api/info") {
            return newFixedLengthResponse(Response.Status.OK, "application/json", info()).noCache()
        }

        val path = when (uri) {
            "/", "" -> if (secure) "index.html" else "receiver.html"
            else -> uri.trimStart('/')
        }
        if (path.contains("..")) return notFound()
        val stream = assets.open(path) ?: return notFound()
        return newChunkedResponse(Response.Status.OK, mimeFor(path), stream).noCache()
    }

    private fun notFound() =
        newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found")

    private fun Response.noCache() = apply { addHeader("Cache-Control", "no-store") }

    private fun mimeFor(path: String) = when (path.substringAfterLast('.').lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js" -> "application/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "json" -> "application/json"
        "ico" -> "image/x-icon"
        else -> "application/octet-stream"
    }

    private inner class PeerSocket(handshake: IHTTPSession) : WebSocket(handshake), SignalingHub.Peer {
        override val role: String =
            if (handshake.parameters["role"]?.firstOrNull() == SignalingHub.ROLE_RECEIVER)
                SignalingHub.ROLE_RECEIVER else SignalingHub.ROLE_SENDER
        override val remoteIp: String = NetworkUtils.normalizeIp(handshake.headers["remote-addr"] ?: "")
        override val hostIp: String = NetworkUtils.hostFromHeader(handshake.headers["host"])
        override val deviceName: String = guessDevice(handshake.headers["user-agent"] ?: "")

        @Volatile private var joined = false
        private val sendLock = Any()

        override fun onOpen() {
            // Only the TV's own WebView may act as the receiver.
            if (role == SignalingHub.ROLE_RECEIVER && !NetworkUtils.isLoopback(remoteIp)) {
                closeQuietly()
                return
            }
            joined = true
            SignalingHub.join(this)
        }

        override fun onClose(code: WebSocketFrame.CloseCode?, reason: String?, initiatedByRemote: Boolean) {
            if (joined) SignalingHub.leave(this)
            joined = false
        }

        override fun onMessage(message: WebSocketFrame) {
            val text = message.textPayload ?: return
            SignalingHub.onMessage(this, text)
        }

        override fun onPong(pong: WebSocketFrame?) {}

        override fun onException(exception: IOException?) {
            if (joined) SignalingHub.leave(this)
            joined = false
        }

        override fun sendText(text: String) {
            synchronized(sendLock) {
                try {
                    if (isOpen) send(text)
                } catch (e: Exception) {
                    // Socket died; onClose/onException will clean up.
                }
            }
        }

        override fun closeQuietly() {
            try {
                close(WebSocketFrame.CloseCode.NormalClosure, "bye", false)
            } catch (e: Exception) {
            }
        }
    }

    companion object {
        const val HTTP_PORT = 8080
        const val HTTPS_PORT = 8443

        fun guessDevice(ua: String): String = when {
            ua.contains("Macintosh") -> "Mac"
            ua.contains("Windows") -> "Windows PC"
            ua.contains("iPhone") || ua.contains("iPad") -> "iOS device"
            ua.contains("Android") -> "Android device"
            ua.contains("Linux") -> "Linux PC"
            else -> "computer"
        }
    }
}
