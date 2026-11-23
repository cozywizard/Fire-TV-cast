# Fire TV Cast

Free casting from your Mac to your Fire TV with no subscription.
You can mirror your screen, a window or a Chrome tab, play a video file from your Mac, or send a video link to the TV.

It works on **every Fire TV**, including the **Fire TV Stick 4K Select** (Vega OS), because
nothing has to be installed on the TV. The TV just opens a web page in its built-in **Silk Browser**.

```
 MacBook                                             Fire TV
┌──────────────────────────┐                        ┌──────────────────────────┐
│ Fire TV Cast helper app  │◀── Silk opens          │  Silk Browser            │
│  (small local server)    │    http://<mac-ip> ────│  shows the player page   │
│                          │                        │                          │
│ Chrome: http://localhost │══ video + audio ══════▶│  full-screen video       │
│  (screen / file / link)  │   (WebRTC, home Wi‑Fi) │                          │
└──────────────────────────┘                        └──────────────────────────┘
```

Everything stays on your home network. Nothing goes through the internet.

---

## One-time setup (Mac)

1. Download **`FireTVCast-Mac.zip`** from this repository's
   [**Releases → latest**](https://github.com/cozywizard/Fire-TV-cast/releases/tag/latest) page.
2. Double-click the zip to unzip it, then drag **Fire TV Cast** into your **Applications** folder.
3. Open it. Because the app isn't from the App Store, macOS blocks it the first time:
   - **macOS 15 Sequoia or newer:** in the warning, click **Done**. Open **System Settings →
     Privacy & Security**, scroll down to *"Fire TV Cast" was blocked*, click **Open Anyway**,
     then enter your password. You only do this once.
   - **macOS 14 or older:** right-click (or Control-click) the app, choose **Open**, then click **Open**.
4. If macOS asks whether Fire TV Cast may **accept incoming network connections**, click **Allow**.
   The TV needs this to reach your Mac.

You need **Google Chrome** on the Mac. Safari can't share sound or play video files to the TV.

## Casting

1. On the Mac, open **Fire TV Cast** from Applications. Chrome opens the Fire TV Cast page.
   The app has no window or Dock icon. The Chrome page is the app.
2. The page shows an address such as **`http://192.168.1.20`**. On your Fire TV, open the **Silk Browser**
   app and type that address **including `http://`**. Without it, Silk runs a web search instead.
   Bookmark the page in Silk so next time it's one click.
3. The TV says **Almost ready**. Press **OK** on the remote. That makes the page full-screen
   and lets it play sound.
4. On the Mac, pick one of these:
   - **Mirror screen:** your whole screen, one window, or a Chrome tab.
     For sound from a tab, keep *"Also share tab audio"* on. For sound from the whole screen,
     turn on *"Also share system audio"* (macOS 14.2+).
   - **Play a video file:** an MP4, MOV or WebM from your Mac. This gives the best quality for movies.
   - **Play a link:** a direct video URL (`.mp4`, `.m3u8`) that the TV plays itself.
5. To stop, click **Stop casting** on the Mac, or press **Back** on the remote.
   When you're done for the day, click **Quit Fire TV Cast helper** at the bottom of the page.

**The first time**, the Mac page shows a line like *"TV browser: WebRTC ✓ · can decode H264, VP8"*.
That's the TV's browser reporting what it supports. If it says **WebRTC ✗**, the TV's browser
can't receive live video. Mirroring and video files won't work on that TV, but *Play a link* might.

## Updates

Fire TV Cast updates itself. While it's running, it checks for a new version every few hours
and downloads it in the background. The update installs the next time you open the app.
To install it right away, click **Restart to update now** at the bottom of the page.
The TV page reloads by itself afterwards. Press the middle button on the remote once to carry on.

Automatic updates need two things:
- **The app must be in your Applications folder.** If you run it from Downloads, it can't update.
- **The GitHub repository must be public.** GitHub doesn't let the app download files from a
  private repository without a login.

If macOS says Fire TV Cast was prevented from modifying apps, go to **System Settings →
Privacy & Security → App Management**, turn on **Fire TV Cast**, and click **Try again** on the page.

## Troubleshooting

- **Silk can't open the address:** check that the Mac and the TV are on the **same Wi-Fi**.
  A guest network usually blocks this. Check that the Fire TV Cast helper is running: open it
  again from Applications. If you clicked "Deny" for incoming connections, go to **System
  Settings → Network → Firewall → Options** and allow Fire TV Cast.
- **No sound on the TV:** press **OK** on the remote. Silk won't play sound until a button has been pressed.
- **Choppy picture:** open **Quality settings** and choose 720p. Also use 5 GHz Wi-Fi.
  Press **Menu ☰** on the remote to see the stream's bitrate and frame rate.
- **Mac asks whether Chrome may find devices on your local network:** click **Allow**.
  You can also turn it on in System Settings → Privacy & Security → Local Network → Google Chrome.
- **Netflix, Disney+ and other protected video show black:** those services block screen capture (DRM).
- **Something else:** the helper writes a log to `~/Library/Logs/FireTVCast.log`.

## Security notes

- Only the Mac running the helper can start a cast. Other devices on your Wi-Fi can open the
  TV page, but they can't send video.
- The helper only runs while you have it open. "Quit Fire TV Cast helper" stops it completely.

---

## Optional: Android app for Fire OS devices

The `app/` folder holds an installable Fire TV app. It's for older Fire TV models that run
**Fire OS**, such as the Fire TV Stick 4K, 4K Max or Cube. With this app the TV runs the server,
so the Mac needs nothing but Chrome.
**It can't be installed on the Fire TV Stick 4K Select (Vega OS).** Use the helper above instead.

To install it on a Fire OS device:

1. On the TV, go to Settings → My Fire TV → About and click the device name 7 times.
2. In Developer options, turn on ADB debugging.
3. On the Mac, run `./mac/install-to-firetv.sh <tv-ip> FireTVCast.apk`. The APK is on the Releases page.

## How it's built

| Path | What |
|---|---|
| `mac-helper/main.go` | The Mac helper: a Go web server and WebSocket signaling relay. It rewrites browsers' hidden `*.local` ICE addresses into real LAN IPs so the TV can always connect. |
| `mac-helper/web/index.html`, `sender.*` | The page you use in Chrome on the Mac (`getDisplayMedia`, `captureStream`, WebRTC). |
| `mac-helper/web/tv.*` | The player page Silk opens on the TV. |
| `app/` | The optional Fire OS Android app: the same idea, with the server running on the TV. |
| `.github/workflows/` | GitHub Actions builds `FireTVCast-Mac.zip` (a universal Apple Silicon + Intel app) and the APK on every push. |

To build the helper yourself (Go 1.22+): `cd mac-helper && go build -o FireTVCast . && ./FireTVCast`
