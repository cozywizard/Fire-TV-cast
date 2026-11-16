# Fire TV Cast

Free casting from your Mac to your Fire TV with no subscription.
Mirror your screen, a window or a Chrome tab, or play a video file from your Mac on the TV.

There are two parts:

| Part | What it is | Where it runs |
|---|---|---|
| **Fire TV Cast app** | A small Android app that plays the stream full-screen | Your Fire TV |
| **Sender page** | A web page the TV app hosts. You open it in Chrome. | Your Mac. There's nothing to install. |

```
 MacBook (Chrome)                                   Fire TV 4K
┌──────────────────────┐   1. open https://TV:8443  ┌──────────────────────────┐
│  sender page         │ ─────────────────────────▶ │  embedded web server     │
│  (screen / file /    │ ◀── 2. WebRTC signaling ─▶ │  + signaling relay       │
│   link)              │                            │                          │
│                      │ ══ 3. H.264 video + audio ═▶  full-screen player      │
└──────────────────────┘     (peer-to-peer, LAN)    └──────────────────────────┘
```

Video goes straight from your Mac to the TV over your home Wi-Fi using WebRTC. Your Mac
encodes H.264 on its hardware encoder and the Fire TV decodes it on its own hardware, so
you get roughly 1080p at 30–60 fps with low delay. Nothing passes through the internet.

---

## 1. Install the app on your Fire TV (one time)

### Turn on sideloading

1. On the Fire TV, go to **Settings → My Fire TV → About** and click your device name
   **7 times** until it says you're a developer.
2. Go back to **Settings → My Fire TV → Developer options** and turn on **ADB debugging**.
   Also turn on **Install unknown apps**. On some models this setting is called
   **Apps from Unknown Sources**.
3. Note your TV's IP address from **Settings → My Fire TV → About → Network**, for example `192.168.1.50`.

### Option A: install from your Mac (recommended)

Open **Terminal** on your Mac and run:

```bash
git clone https://github.com/cozywizard/Fire-TV-cast.git
cd Fire-TV-cast
./mac/install-to-firetv.sh 192.168.1.50      # ← your TV's IP
```

The script installs `adb` with Homebrew if you don't have it. It then downloads the latest
`FireTVCast.apk`, installs it and opens the app. The first time, the TV asks
**"Allow USB debugging?"**. Tick *Always allow* and press **OK**.

If the repository is private, the script can't download the APK. Download `FireTVCast.apk`
yourself from the repository's **Releases** page, or from the latest run on the **Actions** tab
(it's in the `FireTVCast-apk` artifact). Then run:
`./mac/install-to-firetv.sh 192.168.1.50 ~/Downloads/FireTVCast.apk`

### Option B: install from the TV with the free Downloader app

This only works if the repository is public.

1. On the Fire TV, search for and install **Downloader** (by AFTVnews). It's free.
2. In **Settings → My Fire TV → Developer options → Install unknown apps**, allow **Downloader**.
3. Open Downloader and enter:
   `https://github.com/cozywizard/Fire-TV-cast/releases/download/latest/FireTVCast.apk`
4. Choose **Install**.

## 2. Cast

1. Open **Fire TV Cast** on the TV. It's under *Apps* or *Your Apps & Channels*. The TV shows
   an address such as `https://192.168.1.50:8443`.
2. On your Mac, open **Google Chrome** and go to that address.
3. The first time, Chrome says *"Your connection is not private"*. Click **Advanced →
   Proceed to 192.168.1.50 (unsafe)**. This is expected: the TV made its own security
   certificate. Chrome remembers your choice.
4. If macOS asks whether Chrome may *find devices on your local network*, click **Allow**.
5. Pick one of these:
   - **Mirror screen**: share your whole screen, one window, or a Chrome tab.
     - For **sound** from a tab, keep *"Also share tab audio"* on. The sound plays only on the TV.
     - For sound when sharing the **entire screen**, turn on *"Also share system audio"*.
       This needs macOS 14.2 or later and a recent Chrome.
   - **Play a video file**: pick an MP4/MOV/WebM from your Mac. This gives the best quality
     for movies, because it streams the decoded video rather than a picture of your screen.
     Use the player on your Mac to pause and seek.
   - **Play a link**: a direct video URL (`.mp4`, `.m3u8`…) that the TV downloads and plays
     itself. You can pause and seek from the Mac or the remote.

### Remote control

| Button | Action |
|---|---|
| **Back** | Stop casting. On the start screen, it exits the app. |
| **OK / Play-Pause** | Turn sound on if it was muted, or pause/play a link |
| **⏩ / ⏪** (or right/left) | Seek ±30s / 10s when playing a link |
| **Menu ☰** | Show stream stats (resolution, fps, bitrate, codec) |

### Quality settings

Open **Quality settings** on the sender page:

- **Resolution:** 1080p is the default. Pick 720p if the picture stutters. 4K needs strong 5 GHz Wi-Fi.
- **Frame rate:** 30 or 60 fps.
- **Optimise for:** *Video & motion* keeps playback smooth. *Text & sharp detail* keeps
  slides and code crisp.
- **Codec:** H.264 is the default and uses hardware encoding and decoding. Try VP8 if you see glitches.

---

## Troubleshooting

- **The page won't load on the Mac:** make sure the Fire TV Cast app is open on the TV.
  The Mac and the TV must also be on the **same Wi-Fi network**. A guest network often blocks
  devices from talking to each other. Use the exact address the TV shows.
- **"Can't reach the TV"** but the page loaded earlier: the app was closed on the TV. Open it again.
  Casting resumes on its own.
- **Choppy or blurry picture:** choose 720p, use 5 GHz Wi-Fi, or move the router closer.
  Press **Menu** on the remote to see the bitrate. Plugging the Fire TV into Ethernet
  helps a lot.
- **No sound:** see the audio tips in step 5. Safari can't share audio. Use Chrome.
- **Netflix, Disney+ or other protected video shows black:** streaming services block
  screen capture of their videos (DRM). This tool can't get around that. Use the service's
  own Fire TV app instead.
- **"Couldn't connect to your Mac":** a VPN or firewall on the Mac may be blocking local
  connections. Pause the VPN and try again.
- **Installing an update fails with a signature error:** run
  `adb uninstall com.firetvcast.receiver` and then install again. The install script does
  this automatically.

## Security notes

- Anyone on your home Wi-Fi who opens the address can cast to the TV while the app is open,
  just like a Chromecast. Only the newest sender is shown.
- The TV makes its own self-signed certificate on first launch and keeps it on the TV.
  That's why Chrome warns once. Traffic between your Mac and the TV is encrypted (HTTPS and
  WebRTC/DTLS) and never leaves your network.

## How it works (for the curious)

- `app/src/main/java/.../CastServer.kt`: an embedded [NanoHTTPD](https://github.com/NanoHttpd/nanohttpd)
  server. It runs plain HTTP on `127.0.0.1:8080` for the TV's own WebView, and HTTPS on
  `:8443` for your Mac. Screen capture in browsers needs a secure (HTTPS) origin.
- `SignalingHub.kt`: passes WebRTC offers, answers and ICE candidates between the Mac and the TV.
  Browsers hide local IPs behind random `*.local` names, so the hub rewrites them to the real
  LAN addresses it sees. That makes connecting reliable on every Fire OS version.
- `CertManager.kt`: generates the per-device TLS certificate with BouncyCastle.
- `assets/web/receiver.*`: the full-screen TV player, which runs in a WebView.
- `assets/web/index.html` + `sender.*`: the page you use on the Mac. It uses
  `getDisplayMedia()` for mirroring, and `video.captureStream()` with Web Audio for files.

### Building it yourself

GitHub Actions builds the APK on every push (`.github/workflows/build.yml`). To build
locally you need JDK 17 and the Android SDK (Android Studio installs both):

```bash
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```
