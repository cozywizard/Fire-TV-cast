package main

// Self-updater.
//
// GitHub Actions publishes three files on the repository's "latest" release:
//   FireTVCast-Mac.zip              – for people downloading by hand
//   FireTVCast-Mac-update.tar.gz    – the same app, for the updater
//   mac-version.json                – {"version": "1.0.N", "sha256": "<of the tar.gz>"}
//
// While the helper runs it checks mac-version.json, downloads and verifies a newer
// build into ~/Library/Application Support/FireTVCast/update/, and installs it either
// the next time the app is opened or right away when the user clicks "Restart to update".

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Set at build time: -X main.updateRepo=owner/name. Empty disables updates (dev builds).
var updateRepo = ""

const appName = "Fire TV Cast.app"

// Overridable in tests.
var (
	goos           = runtime.GOOS
	executablePath = os.Executable
	releaseBase    = "https://github.com"
)

type updater struct {
	mu      sync.Mutex
	status  string // disabled | idle | checking | up-to-date | downloading | ready | error
	latest  string
	message string
}

var upd = &updater{status: "idle"}

func (u *updater) set(status, latest, message string) {
	u.mu.Lock()
	u.status, u.latest, u.message = status, latest, message
	u.mu.Unlock()
	if message != "" {
		log.Printf("update: %s %s: %s", status, latest, message)
	}
}

func (u *updater) snapshot() map[string]any {
	u.mu.Lock()
	defer u.mu.Unlock()
	return map[string]any{"status": u.status, "latest": u.latest, "message": u.message}
}

func updatesSupported() (bool, string) {
	if updateRepo == "" || version == "dev" {
		return false, "Automatic updates are off in development builds."
	}
	if goos != "darwin" {
		return false, "Automatic updates only work on macOS."
	}
	if _, err := appBundlePath(); err != nil {
		return false, err.Error()
	}
	return true, ""
}

// appBundlePath returns /Applications/Fire TV Cast.app (or wherever the app lives).
func appBundlePath() (string, error) {
	exe, err := executablePath()
	if err != nil {
		return "", err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	if strings.Contains(exe, "/AppTranslocation/") {
		return "", errors.New("Move Fire TV Cast into your Applications folder to get automatic updates.")
	}
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	bundle := filepath.Dir(contents)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || !strings.HasSuffix(bundle, ".app") {
		return "", errors.New("Automatic updates only work when running the Fire TV Cast app.")
	}
	return bundle, nil
}

func stagingDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "FireTVCast", "update")
}

func stagedApp() string { return filepath.Join(stagingDir(), appName) }

func releaseURL(file string) string {
	return fmt.Sprintf("%s/%s/releases/download/latest/%s", releaseBase, updateRepo, file)
}

// newerVersion reports whether a ("1.0.12") is newer than b ("1.0.9").
func newerVersion(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

var httpClient = &http.Client{Timeout: 2 * time.Minute}

// checkAndDownload looks for a newer version and stages it. Safe to call repeatedly.
func (u *updater) checkAndDownload() {
	if ok, why := updatesSupported(); !ok {
		u.set("disabled", "", why)
		return
	}
	u.mu.Lock()
	busy := u.status == "checking" || u.status == "downloading" || u.status == "ready"
	if !busy {
		u.status = "checking"
	}
	u.mu.Unlock()
	if busy {
		return
	}

	var info struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
	}
	resp, err := httpClient.Get(releaseURL("mac-version.json"))
	if err != nil {
		u.set("error", "", "Couldn't check for updates: "+err.Error())
		return
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		u.set("error", "", "Couldn't check for updates. If the GitHub repository is private, make it public so the app can download updates.")
		return
	}
	if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &info) != nil || info.Version == "" {
		u.set("error", "", fmt.Sprintf("Couldn't check for updates (HTTP %d).", resp.StatusCode))
		return
	}
	if !newerVersion(info.Version, version) {
		u.set("up-to-date", info.Version, "")
		return
	}

	u.set("downloading", info.Version, "")
	if err := stage(info.Version, info.SHA256); err != nil {
		u.set("error", info.Version, "Couldn't download the update: "+err.Error())
		return
	}
	u.set("ready", info.Version, "")
}

func stage(want, sha string) error {
	resp, err := httpClient.Get(releaseURL("FireTVCast-Mac-update.tar.gz"))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	tmp, err := os.CreateTemp("", "firetvcast-update-*.tar.gz")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, 200<<20)); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, sha) {
		return errors.New("the download was incomplete or corrupted (checksum mismatch); will retry later")
	}

	dir := stagingDir()
	os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if _, err := tmp.Seek(0, 0); err != nil {
		return err
	}
	if err := untar(tmp, dir); err != nil {
		os.RemoveAll(dir)
		return err
	}
	// Make sure the new build actually runs on this Mac and is the version we expect.
	out, err := exec.Command(filepath.Join(stagedApp(), "Contents", "MacOS", "FireTVCast"), "-version").Output()
	if err != nil || strings.TrimSpace(string(out)) != want {
		os.RemoveAll(dir)
		return fmt.Errorf("the downloaded app didn't start correctly (%v %q)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func untar(r io.Reader, dest string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	root := filepath.Clean(dest) + string(os.PathSeparator)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(hdr.Name)
		if strings.HasPrefix(filepath.Base(name), "._") {
			continue // macOS metadata
		}
		target := filepath.Join(dest, name)
		if !strings.HasPrefix(target, root) || !strings.HasPrefix(name, appName) {
			return fmt.Errorf("unexpected file in update: %s", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode)&0o755|0o644)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			f.Close()
			if err != nil {
				return err
			}
		default:
			// The app bundle has no symlinks or special files; ignore anything else.
		}
	}
}

// applyStaged swaps the staged app into place. Returns false if nothing was staged.
func applyStaged() (bool, error) {
	staged := stagedApp()
	if _, err := os.Stat(staged); err != nil {
		return false, nil
	}
	bundle, err := appBundlePath()
	if err != nil {
		return false, err
	}
	old := filepath.Join(filepath.Dir(bundle), ".Fire TV Cast.app.old")
	os.RemoveAll(old)
	if err := os.Rename(bundle, old); err != nil {
		return false, permissionHint(err)
	}
	if err := os.Rename(staged, bundle); err != nil {
		os.Rename(old, bundle) // put the working app back
		return false, permissionHint(err)
	}
	os.RemoveAll(old)
	os.RemoveAll(stagingDir())
	log.Printf("update installed")
	return true, nil
}

func permissionHint(err error) error {
	if errors.Is(err, os.ErrPermission) {
		return errors.New("macOS didn't allow Fire TV Cast to replace itself. Open System Settings → Privacy & Security → App Management, turn on Fire TV Cast, then try again")
	}
	return err
}

// relaunch starts the (new) app and lets the caller exit.
func relaunch(extraArgs ...string) error {
	bundle, err := appBundlePath()
	if err != nil {
		return err
	}
	args := append([]string{"-n", bundle, "--args"}, extraArgs...)
	return exec.Command("open", args...).Start()
}

// startupUpdate installs an update downloaded during an earlier run. It returns true
// if the new version was launched and this process should exit.
func startupUpdate(noOpen bool) bool {
	if ok, _ := updatesSupported(); !ok {
		return false
	}
	applied, err := applyStaged()
	if err != nil {
		upd.set("error", "", "Couldn't install the downloaded update: "+err.Error())
		return false
	}
	if !applied {
		return false
	}
	var args []string
	if noOpen {
		args = append(args, "-no-open")
	}
	if err := relaunch(args...); err != nil {
		log.Printf("relaunch failed: %v", err)
		return false
	}
	return true
}

// backgroundUpdates checks shortly after start and then every 6 hours.
func backgroundUpdates() {
	time.Sleep(5 * time.Second)
	for {
		upd.checkAndDownload()
		time.Sleep(6 * time.Hour)
	}
}
