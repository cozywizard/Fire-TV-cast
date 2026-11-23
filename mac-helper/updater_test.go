package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeApp writes a fake app whose executable prints the given version.
func appTarGz(t *testing.T, ver string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	add := func(name string, mode int64, body string, dir bool) {
		h := &tar.Header{Name: name, Mode: mode}
		if dir {
			h.Typeflag = tar.TypeDir
		} else {
			h.Typeflag = tar.TypeReg
			h.Size = int64(len(body))
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if !dir {
			tw.Write([]byte(body))
		}
	}
	add("Fire TV Cast.app/", 0o755, "", true)
	add("Fire TV Cast.app/Contents/", 0o755, "", true)
	add("Fire TV Cast.app/Contents/MacOS/", 0o755, "", true)
	add("Fire TV Cast.app/Contents/Info.plist", 0o644, "<plist/>", false)
	add("Fire TV Cast.app/Contents/MacOS/FireTVCast", 0o755, "#!/bin/sh\necho "+ver+"\n", false)
	add("Fire TV Cast.app/Contents/._junk", 0o644, "x", false)
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func setup(t *testing.T, latest string, payload []byte, sha string) (installed string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	apps := filepath.Join(home, "Applications")
	bundle := filepath.Join(apps, appName)
	exe := filepath.Join(bundle, "Contents", "MacOS", "FireTVCast")
	os.MkdirAll(filepath.Dir(exe), 0o755)
	os.WriteFile(exe, []byte("#!/bin/sh\necho 1.0.4\n"), 0o755)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/missing"):
			http.NotFound(w, r) // what GitHub returns for a private repository
		case strings.HasSuffix(r.URL.Path, "/mac-version.json"):
			fmt.Fprintf(w, `{"version":%q,"sha256":%q}`, latest, sha)
		case strings.HasSuffix(r.URL.Path, "/FireTVCast-Mac-update.tar.gz"):
			w.Write(payload)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	oldV, oldRepo, oldGoos, oldExe, oldBase := version, updateRepo, goos, executablePath, releaseBase
	t.Cleanup(func() {
		version, updateRepo, goos, executablePath, releaseBase = oldV, oldRepo, oldGoos, oldExe, oldBase
	})
	version, updateRepo, goos, releaseBase = "1.0.4", "owner/repo", "darwin", srv.URL
	executablePath = func() (string, error) { return exe, nil }
	upd = &updater{status: "idle"}
	return exe
}

func shaOf(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func TestUpdateDownloadsVerifiesAndInstalls(t *testing.T) {
	payload := appTarGz(t, "1.0.9")
	exe := setup(t, "1.0.9", payload, shaOf(payload))

	upd.checkAndDownload()
	if s := upd.snapshot(); s["status"] != "ready" {
		t.Fatalf("status = %v", s)
	}
	if _, err := os.Stat(filepath.Join(stagedApp(), "Contents", "._junk")); err == nil {
		t.Fatal("macOS metadata file should be skipped")
	}
	applied, err := applyStaged()
	if err != nil || !applied {
		t.Fatalf("apply: %v %v", applied, err)
	}
	b, _ := os.ReadFile(exe)
	if !strings.Contains(string(b), "1.0.9") {
		t.Fatalf("installed app is not the new version: %s", b)
	}
	if _, err := os.Stat(stagingDir()); err == nil {
		t.Fatal("staging dir should be cleaned up")
	}
	if applied, _ := applyStaged(); applied {
		t.Fatal("nothing should be left to apply")
	}
}

func TestUpdateRejectsBadChecksum(t *testing.T) {
	payload := appTarGz(t, "1.0.9")
	exe := setup(t, "1.0.9", payload, strings.Repeat("0", 64))
	upd.checkAndDownload()
	if s := upd.snapshot(); s["status"] != "error" || !strings.Contains(s["message"].(string), "checksum") {
		t.Fatalf("status = %v", s)
	}
	if applied, _ := applyStaged(); applied {
		t.Fatal("must not install a corrupted download")
	}
	b, _ := os.ReadFile(exe)
	if !strings.Contains(string(b), "1.0.4") {
		t.Fatal("original app must be untouched")
	}
}

func TestUpdateRejectsWrongVersionBinary(t *testing.T) {
	payload := appTarGz(t, "1.0.7") // claims 1.0.9 but the binary says 1.0.7
	setup(t, "1.0.9", payload, shaOf(payload))
	upd.checkAndDownload()
	if s := upd.snapshot(); s["status"] != "error" {
		t.Fatalf("status = %v", s)
	}
}

func TestNoUpdateWhenCurrent(t *testing.T) {
	payload := appTarGz(t, "1.0.4")
	setup(t, "1.0.4", payload, shaOf(payload))
	upd.checkAndDownload()
	if s := upd.snapshot(); s["status"] != "up-to-date" {
		t.Fatalf("status = %v", s)
	}
}

func TestPrivateRepoMessage(t *testing.T) {
	payload := appTarGz(t, "1.0.9")
	setup(t, "1.0.9", payload, shaOf(payload))
	releaseBase = releaseBase + "/missing"
	updateRepo = "x"
	upd.checkAndDownload()
	s := upd.snapshot()
	if s["status"] != "error" {
		t.Fatalf("status = %v", s)
	}
	t.Log(s["message"])
}

func TestTranslocatedAppHasNoUpdates(t *testing.T) {
	setup(t, "1.0.9", nil, "")
	executablePath = func() (string, error) {
		return "/private/var/folders/x/AppTranslocation/ABC/d/Fire TV Cast.app/Contents/MacOS/FireTVCast", nil
	}
	ok, why := updatesSupported()
	if ok || !strings.Contains(why, "Applications") {
		t.Fatalf("got %v %q", ok, why)
	}
}

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{{"1.0.10", "1.0.9", true}, {"1.0.9", "1.0.10", false}, {"1.0.4", "1.0.4", false}, {"1.1.0", "1.0.99", true}}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%s,%s)=%v", c.a, c.b, got)
		}
	}
}
