package com.firetvcast.receiver

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException

class MainActivity : Activity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            webViewClient = WebViewClient()
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.d(TAG, "web: ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                    return true
                }
            }
            isFocusable = true
            isFocusableInTouchMode = true
        }
        setContentView(web)
        hideSystemUi()

        Servers.ensureStarted(applicationContext) { ok ->
            runOnUiThread {
                if (ok) {
                    web.loadUrl("http://127.0.0.1:${CastServer.HTTP_PORT}/receiver.html")
                } else {
                    web.loadData(
                        "<body style='background:#000;color:#fff;font:28px sans-serif;padding:60px'>" +
                            "<h1>Fire TV Cast couldn't start</h1><p>${Servers.lastError ?: ""}</p>" +
                            "<p>Try force-stopping the app and opening it again.</p></body>",
                        "text/html", "utf-8",
                    )
                }
            }
        }
        web.requestFocus()
    }

    override fun onResume() {
        super.onResume()
        hideSystemUi()
        js("window.onTvResume && window.onTvResume()")
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** Route remote-control buttons to the page; everything else behaves normally. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val name = when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> "back"
            KeyEvent.KEYCODE_MENU -> "menu"
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> "ok"
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY,
            KeyEvent.KEYCODE_MEDIA_PAUSE -> "playpause"
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_DPAD_RIGHT -> "forward"
            KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_DPAD_LEFT -> "rewind"
            else -> return super.dispatchKeyEvent(event)
        }
        if (event.action != KeyEvent.ACTION_UP) return true
        if (name == "back") {
            web.evaluateJavascript("window.remoteKey ? String(window.remoteKey('back')) : 'false'") { result ->
                if (result == null || !result.contains("true")) finish()
            }
        } else {
            js("window.remoteKey && window.remoteKey('$name')")
        }
        return true
    }

    private fun js(code: String) {
        if (::web.isInitialized) web.evaluateJavascript(code, null)
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
    }

    companion object {
        const val TAG = "FireTVCast"
    }
}

/** Process-wide servers; they keep running while the app process is alive. */
object Servers {
    @Volatile var lastError: String? = null
    @Volatile private var httpsReady = false
    @Volatile private var httpsError: String? = null
    private var started = false

    fun ensureStarted(context: android.content.Context, done: (Boolean) -> Unit) {
        Thread {
            val ok = synchronized(this) {
                if (started) true else start(context).also { started = it }
            }
            done(ok)
        }.start()
    }

    private fun start(context: android.content.Context): Boolean {
        val assets = CastServer.AssetSource { path ->
            try {
                context.assets.open("web/$path")
            } catch (e: FileNotFoundException) {
                null
            }
        }
        val info = { infoJson(context) }

        try {
            CastServer(CastServer.HTTP_PORT, secure = false, assets = assets, info = info).startServer()
        } catch (e: Exception) {
            lastError = "Port ${CastServer.HTTP_PORT} is busy: ${e.message}"
            Log.e(MainActivity.TAG, "http start failed", e)
            return false
        }

        // HTTPS (for the Mac) can come up a moment later; the TV page polls /api/info.
        Thread {
            try {
                val ks = CertManager.loadOrCreate(
                    File(context.filesDir, "tls.p12"), NetworkUtils.lanIPv4Addresses(),
                )
                CastServer(CastServer.HTTPS_PORT, secure = true, assets = assets, info = info).apply {
                    enableTls(ks, CertManager.PASSWORD)
                    startServer()
                }
                httpsReady = true
            } catch (e: Exception) {
                httpsError = e.toString()
                Log.e(MainActivity.TAG, "https start failed", e)
            }
        }.start()
        return true
    }

    private fun infoJson(context: android.content.Context): String {
        val version = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        } catch (e: Exception) {
            "?"
        }
        return JSONObject()
            .put("name", Build.MODEL ?: "Fire TV")
            .put("ips", JSONArray(NetworkUtils.lanIPv4Addresses()))
            .put("httpPort", CastServer.HTTP_PORT)
            .put("httpsPort", CastServer.HTTPS_PORT)
            .put("httpsReady", httpsReady)
            .put("httpsError", httpsError ?: JSONObject.NULL)
            .put("version", version)
            .toString()
    }
}
