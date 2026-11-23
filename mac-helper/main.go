// Fire TV Cast helper for macOS.
//
// Runs a small web server on your Mac:
//   - Chrome on the Mac opens http://localhost/ and gets the sender page
//     (screen mirroring / video files / links).
//   - The Fire TV's Silk browser opens http://<mac-ip>/ and gets the TV player page.
//   - A WebSocket at /ws relays WebRTC signaling between the two; the video
//     itself flows directly Mac -> TV over your home network.
package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed web
var webFS embed.FS

var version = "dev"

const appSignature = "fire-tv-cast-helper"

func main() {
	noOpen := flag.Bool("no-open", false, "don't open the browser on start")
	portFlag := flag.Int("port", 0, "port to listen on (default: 80, falling back to 8765+)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	setupLogging()
	log.Printf("Fire TV Cast helper %s starting", version)

	// Install an update downloaded last time, then hand over to the new version.
	if startupUpdate(*noOpen) {
		log.Printf("launched the updated app; exiting")
		return
	}

	ln, port, err := listen(*portFlag)
	if err != nil {
		if errors.Is(err, errAlreadyRunning) {
			log.Printf("already running on port %d; opening the page", port)
			if !*noOpen {
				openBrowser(fmt.Sprintf("http://localhost:%s/", portSuffix(port)))
			}
			return
		}
		log.Fatalf("could not start server: %v", err)
	}
	srv := newServer(port)
	srv.ln = ln
	log.Printf("listening on port %d, LAN addresses %v", port, lanIPv4())
	go backgroundUpdates()

	if !*noOpen {
		go func() {
			time.Sleep(300 * time.Millisecond)
			openBrowser("http://localhost" + portColon(port) + "/")
		}()
	}
	log.Fatal(http.Serve(ln, srv))
}

// ---------- listening ----------

var errAlreadyRunning = errors.New("already running")

func listen(fixed int) (net.Listener, int, error) {
	candidates := []int{80, 8765, 8766, 8767, 8768, 8769, 8770}
	if fixed != 0 {
		candidates = []int{fixed}
	}
	var lastErr error
	for _, p := range candidates {
		if isOurHelper(p) {
			return nil, p, errAlreadyRunning
		}
		ln, err := net.Listen("tcp4", ":"+strconv.Itoa(p))
		if err == nil {
			return ln, p, nil
		}
		lastErr = err
	}
	return nil, 0, lastErr
}

func isOurHelper(port int) bool {
	c := http.Client{Timeout: 700 * time.Millisecond}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/info", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return strings.Contains(string(b), appSignature)
}

func portColon(p int) string {
	if p == 80 {
		return ""
	}
	return ":" + strconv.Itoa(p)
}

func portSuffix(p int) string { return strings.TrimPrefix(portColon(p), ":") }

// ---------- HTTP ----------

type server struct {
	ln    net.Listener
	port  int
	hub   *hub
	files http.Handler
	up    websocket.Upgrader
}

func newServer(port int) *server {
	sub, _ := fs.Sub(webFS, "web")
	return &server{
		port:  port,
		hub:   &hub{},
		files: http.FileServer(http.FS(sub)),
		up: websocket.Upgrader{
			// The TV page and the Mac page are served by us; any LAN origin is fine.
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	local := isLoopback(remoteIP(r))

	if strings.HasPrefix(r.URL.Path, "/api/media/") || strings.HasPrefix(r.URL.Path, "/media/") {
		if !local {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		serveMediaAPI(w, r)
		return
	}

	switch r.URL.Path {
	case "/ws":
		s.serveWS(w, r, local)
		return
	case "/api/info":
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"app":          appSignature,
			"version":      version,
			"ips":          lanIPv4(),
			"port":         s.port,
			"tvConnected":  s.hub.hasReceiver(),
			"hostname":     hostname(),
			"update":       upd.snapshot(),
			"soundCheck":   lastSoundCheck(),
			"nativePicker": nativePickerAvailable(),
		})
		return
	case "/api/update/check":
		if !local || r.Method != http.MethodPost {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		go upd.checkAndDownload()
		io.WriteString(w, "ok")
		return
	case "/api/update/apply":
		if !local || r.Method != http.MethodPost {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		s.applyUpdateNow(w)
		return
	case "/api/quit":
		if !local || r.Method != http.MethodPost {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		io.WriteString(w, "bye")
		log.Printf("quit requested from the page")
		go func() { time.Sleep(200 * time.Millisecond); os.Exit(0) }()
		return
	case "/", "/index.html":
		// The Mac gets the sender page; anything else on the network (the TV) gets the player.
		if local {
			serveEmbedded(w, "web/index.html")
		} else {
			serveEmbedded(w, "web/tv.html")
		}
		return
	case "/tv":
		serveEmbedded(w, "web/tv.html")
		return
	case "/soundcheck":
		serveEmbedded(w, "web/soundcheck.html")
		return
	case "/beep.wav":
		freq, _ := strconv.Atoi(r.URL.Query().Get("f"))
		w.Header().Set("Content-Type", "audio/wav")
		w.Write(beepWAV(freq))
		return
	case "/api/tvlog":
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		b, _ := io.ReadAll(io.LimitReader(r.Body, 16<<10))
		var rep struct {
			UA      string   `json:"ua"`
			Results []string `json:"results"`
		}
		json.Unmarshal(b, &rep)
		log.Printf("TV sound check (%s):\n%s", rep.UA, strings.Join(rep.Results, "\n"))
		soundCheckMu.Lock()
		soundCheck = map[string]any{"at": time.Now().Format("15:04:05"), "results": rep.Results}
		soundCheckMu.Unlock()
		io.WriteString(w, "ok")
		return
	}
	s.files.ServeHTTP(w, r)
}

// applyUpdateNow installs the staged update and restarts into it. The open pages
// notice the new version when they reconnect and reload themselves.
func (s *server) applyUpdateNow(w http.ResponseWriter) {
	if upd.snapshot()["status"] != "ready" {
		http.Error(w, "No update is ready yet.", http.StatusConflict)
		return
	}
	applied, err := applyStaged()
	if err != nil || !applied {
		msg := "The update files were missing; it will download again."
		if err != nil {
			msg = err.Error()
		}
		upd.set("error", "", "Couldn't install the update: "+msg)
		http.Error(w, msg, http.StatusInternalServerError)
		return
	}
	io.WriteString(w, "restarting")
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		hadPage := s.hub.hasSender()
		s.ln.Close() // free the port for the new version
		args := []string{}
		if hadPage {
			args = append(args, "-no-open") // the open page reloads itself
		}
		if err := relaunch(args...); err != nil {
			log.Printf("relaunch failed: %v", err)
		}
		os.Exit(0)
	}()
}

func (h *hub) hasSender() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sender != nil
}

var (
	soundCheckMu sync.Mutex
	soundCheck   map[string]any
)

func lastSoundCheck() map[string]any {
	soundCheckMu.Lock()
	defer soundCheckMu.Unlock()
	return soundCheck
}

// beepWAV returns a 1-second 16-bit mono sine tone as a WAV file.
func beepWAV(freq int) []byte {
	if freq < 100 || freq > 4000 {
		freq = 440
	}
	const rate = 44100
	n := rate
	buf := make([]byte, 44+n*2)
	le16 := func(o int, v uint16) { buf[o], buf[o+1] = byte(v), byte(v>>8) }
	le32 := func(o int, v uint32) { le16(o, uint16(v)); le16(o+2, uint16(v>>16)) }
	copy(buf, "RIFF")
	le32(4, uint32(36+n*2))
	copy(buf[8:], "WAVEfmt ")
	le32(16, 16)
	le16(20, 1)
	le16(22, 1)
	le32(24, rate)
	le32(28, rate*2)
	le16(32, 2)
	le16(34, 16)
	copy(buf[36:], "data")
	le32(40, uint32(n*2))
	for i := 0; i < n; i++ {
		env := 1.0
		if i < 2000 {
			env = float64(i) / 2000
		} else if i > n-2000 {
			env = float64(n-i) / 2000
		}
		v := int16(12000 * env * math.Sin(2*math.Pi*float64(freq)*float64(i)/rate))
		le16(44+i*2, uint16(v))
	}
	return buf
}

func serveEmbedded(w http.ResponseWriter, name string) {
	b, err := webFS.ReadFile(name)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(b)
}

func (s *server) serveWS(w http.ResponseWriter, r *http.Request, local bool) {
	role := r.URL.Query().Get("role")
	if role != roleReceiver {
		role = roleSender
	}
	// Only this Mac may send; anything on the LAN may be the TV.
	if role == roleSender && !local {
		http.Error(w, "the sender page only works on the Mac running the helper", http.StatusForbidden)
		return
	}
	conn, err := s.up.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	p := &peer{
		conn:     conn,
		role:     role,
		remoteIP: remoteIP(r),
		hostIP:   hostOnly(r.Host),
		device:   guessDevice(r.UserAgent()),
		out:      make(chan []byte, 64),
	}
	log.Printf("%s connected from %s (%s)", role, p.remoteIP, p.device)
	go p.writeLoop()
	s.hub.join(p)
	defer func() {
		s.hub.leave(p)
		p.close()
		log.Printf("%s %s disconnected", role, p.remoteIP)
	}()
	conn.SetReadLimit(1 << 20)
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		s.hub.message(p, msg)
	}
}

// ---------- signaling hub ----------

const (
	roleReceiver = "receiver"
	roleSender   = "sender"
)

type peer struct {
	conn     *websocket.Conn
	role     string
	remoteIP string
	hostIP   string
	device   string
	out      chan []byte
	once     sync.Once
	tvInfo   []byte // last "tv-info" message from a receiver
}

func (p *peer) writeLoop() {
	for m := range p.out {
		p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := p.conn.WriteMessage(websocket.TextMessage, m); err != nil {
			p.conn.Close()
			for range p.out {
			}
			return
		}
	}
	p.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "bye"))
	p.conn.Close()
}

func (p *peer) send(b []byte) {
	defer func() { recover() }() // channel may be closed
	select {
	case p.out <- b:
	default:
		log.Printf("dropping message to slow %s", p.role)
	}
}

func (p *peer) close() { p.once.Do(func() { close(p.out) }) }

type hub struct {
	mu       sync.Mutex
	receiver *peer
	sender   *peer
}

var mdnsRe = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.local`)

func msg(typ string, kv ...any) []byte {
	m := map[string]any{"type": typ}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i].(string)] = kv[i+1]
	}
	b, _ := json.Marshal(m)
	return b
}

func (h *hub) hasReceiver() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.receiver != nil
}

func (h *hub) join(p *peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.role == roleReceiver {
		if old := h.receiver; old != nil && old != p {
			old.send(msg("replaced"))
			old.close()
		}
		h.receiver = p
		p.send(msg("hello", "senderConnected", h.sender != nil, "version", version))
		if h.sender != nil {
			h.sender.send(msg("receiver-ready", "device", p.device))
		}
		return
	}
	if old := h.sender; old != nil && old != p {
		old.send(msg("replaced"))
		old.close()
		if h.receiver != nil {
			h.receiver.send(msg("sender-left"))
		}
	}
	h.sender = p
	p.send(msg("hello", "receiverReady", h.receiver != nil, "version", version))
	if h.receiver != nil {
		if h.receiver.tvInfo != nil {
			p.send(h.receiver.tvInfo)
		}
		h.receiver.send(msg("sender-joined", "name", "your "+p.device))
	}
}

func (h *hub) leave(p *peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch p {
	case h.receiver:
		h.receiver = nil
		if h.sender != nil {
			h.sender.send(msg("receiver-left"))
		}
	case h.sender:
		h.sender = nil
		if h.receiver != nil {
			h.receiver.send(msg("sender-left"))
		}
	}
}

func (h *hub) message(from *peer, raw []byte) {
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &head) != nil || head.Type == "ping" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	switch from {
	case h.sender:
		if h.receiver == nil {
			from.send(msg("error", "message", "The TV isn't connected yet."))
			return
		}
		// Browsers hide local IPs behind random *.local names; replace them with
		// this Mac's address as the TV sees it, so the TV can always connect.
		h.receiver.send(rewriteMDNS(raw, h.receiver.hostIP))
	case h.receiver:
		if head.Type == "tv-info" {
			from.tvInfo = append([]byte(nil), raw...)
			log.Printf("TV info: %s", raw)
		}
		if h.sender != nil {
			h.sender.send(rewriteMDNS(raw, from.remoteIP))
		}
	}
}

func rewriteMDNS(raw []byte, ip string) []byte {
	if ip == "" || isLoopback(ip) || !strings.Contains(string(raw), ".local") {
		return raw
	}
	return mdnsRe.ReplaceAll(raw, []byte(ip))
}

// ---------- helpers ----------

func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return strings.TrimPrefix(host, "::ffff:")
}

func hostOnly(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		return strings.Trim(host, "[]")
	}
	return strings.Trim(h, "[]")
}

func isLoopback(ip string) bool {
	parsed := net.ParseIP(ip)
	return parsed != nil && parsed.IsLoopback()
}

func lanIPv4() []string {
	type cand struct {
		rank int
		ip   string
	}
	var out []cand
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(iface.Name)
		rank := 5
		switch {
		case name == "en0":
			rank = 0 // MacBook Wi-Fi
		case strings.HasPrefix(name, "en"):
			rank = 1
		case strings.HasPrefix(name, "utun"), strings.HasPrefix(name, "bridge"),
			strings.HasPrefix(name, "awdl"), strings.HasPrefix(name, "llw"), strings.HasPrefix(name, "docker"):
			rank = 9
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipn.IP.To4()
			if ip4 == nil || ip4.IsLinkLocalUnicast() || ip4.IsLoopback() {
				continue
			}
			out = append(out, cand{rank, ip4.String()})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].rank < out[j].rank })
	ips := []string{}
	seen := map[string]bool{}
	for _, c := range out {
		if c.rank < 9 && !seen[c.ip] {
			seen[c.ip] = true
			ips = append(ips, c.ip)
		}
	}
	return ips
}

func guessDevice(ua string) string {
	switch {
	case strings.Contains(ua, "Silk"), strings.Contains(ua, "AFT"), strings.Contains(ua, "Vega"):
		return "Fire TV"
	case strings.Contains(ua, "Macintosh"):
		return "Mac"
	case strings.Contains(ua, "Windows"):
		return "Windows PC"
	case strings.Contains(ua, "Android"):
		return "Android device"
	case strings.Contains(ua, "Linux"):
		return "Linux device"
	}
	return "device"
}

func hostname() string {
	h, _ := os.Hostname()
	return strings.TrimSuffix(h, ".local")
}

func openBrowser(url string) {
	if runtime.GOOS != "darwin" {
		log.Printf("open %s in your browser", url)
		return
	}
	// Chrome is needed for screen sharing with audio and for video files.
	if err := exec.Command("open", "-a", "Google Chrome", url).Run(); err != nil {
		exec.Command("open", url).Run()
	}
}

func setupLogging() {
	if runtime.GOOS != "darwin" {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	dir := filepath.Join(home, "Library", "Logs")
	os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(filepath.Join(dir, "FireTVCast.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err == nil {
		log.SetOutput(io.MultiWriter(os.Stderr, f))
	}
}
