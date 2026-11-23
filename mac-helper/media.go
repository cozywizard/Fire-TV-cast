package main

// Video files.
//
// "Play a video file" asks the helper to show a native file picker, so we get the real
// path. We probe the file with ffprobe and then either:
//   - serve it untouched (MP4/MOV/WebM with codecs Chrome can play), with full seeking, or
//   - convert it on the fly with ffmpeg into a fragmented MP4 that Chrome can play:
//     video is copied when Chrome can decode it (H.264/HEVC), otherwise re-encoded with the
//     Mac's hardware encoder; audio Chrome can't play (AC3, E-AC3, DTS, TrueHD, …) becomes
//     stereo AAC. Seeking restarts the conversion at the new position.
// Chrome then plays the result in the page, which casts it to the TV as before.

import (
	"context"
	"crypto/rand"
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

type probeStream struct {
	Index       int               `json:"index"`
	CodecType   string            `json:"codec_type"`
	CodecName   string            `json:"codec_name"`
	Profile     string            `json:"profile"`
	PixFmt      string            `json:"pix_fmt"`
	Width       int               `json:"width"`
	Height      int               `json:"height"`
	Channels    int               `json:"channels"`
	Disposition map[string]int    `json:"disposition"`
	Tags        map[string]string `json:"tags"`
}

type probeResult struct {
	Streams []probeStream `json:"streams"`
	Format  struct {
		FormatName string `json:"format_name"`
		Duration   string `json:"duration"`
	} `json:"format"`
}

type mediaItem struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Duration float64 `json:"duration"`
	Mode     string  `json:"mode"` // "direct" or "convert"
	URL      string  `json:"url"`
	Note     string  `json:"note"`
	HasAudio bool    `json:"hasAudio"`

	path       string
	videoIndex int // -1 if none
	audioIndex int // -1 if none
	copyVideo  bool
	copyAudio  bool
	hevc       bool
}

var (
	mediaMu    sync.Mutex
	mediaItems = map[string]*mediaItem{}
)

// toolPath finds ffmpeg/ffprobe: bundled next to our executable, else on PATH.
func toolPath(name string) (string, error) {
	if exe, err := executablePath(); err == nil {
		if p, err := filepath.EvalSymlinks(exe); err == nil {
			exe = p
		}
		cand := filepath.Join(filepath.Dir(exe), name)
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand, nil
		}
	}
	return exec.LookPath(name)
}

func probe(ctx context.Context, path string) (*probeResult, error) {
	ffprobe, err := toolPath("ffprobe")
	if err != nil {
		return nil, errors.New("ffprobe is missing from this build")
	}
	out, err := exec.CommandContext(ctx, ffprobe, "-v", "error", "-print_format", "json",
		"-show_format", "-show_streams", path).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("couldn't read this file: %s", strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, fmt.Errorf("couldn't read this file: %v", err)
	}
	var pr probeResult
	if err := json.Unmarshal(out, &pr); err != nil {
		return nil, err
	}
	return &pr, nil
}

// Codecs Chrome on macOS plays natively.
var (
	chromeVideo = map[string]bool{"h264": true, "hevc": true, "vp8": true, "vp9": true, "av1": true}
	chromeAudio = map[string]bool{"aac": true, "mp3": true, "opus": true, "flac": true, "vorbis": true}
	// Video we can put in MP4 untouched for Chrome.
	copyableVideo = map[string]bool{"h264": true, "hevc": true}
	audioNames    = map[string]string{"ac3": "Dolby Digital (AC3)", "eac3": "Dolby Digital Plus (E-AC3)", "dts": "DTS",
		"truehd": "Dolby TrueHD", "mlp": "MLP", "pcm_s16le": "PCM", "pcm_s24le": "PCM", "wmav2": "WMA", "wmapro": "WMA Pro", "alac": "ALAC", "mp2": "MP2"}
)

func planMedia(path string, pr *probeResult) (*mediaItem, error) {
	m := &mediaItem{path: path, Name: filepath.Base(path), videoIndex: -1, audioIndex: -1}
	m.Duration, _ = strconv.ParseFloat(pr.Format.Duration, 64)

	var video, audio *probeStream
	for i := range pr.Streams {
		s := &pr.Streams[i]
		switch s.CodecType {
		case "video":
			if s.Disposition["attached_pic"] == 1 { // cover art
				continue
			}
			if video == nil {
				video = s
			}
		case "audio":
			// Prefer the stream marked default, else the first.
			if audio == nil || (s.Disposition["default"] == 1 && audio.Disposition["default"] != 1) {
				audio = s
			}
		}
	}
	if video == nil && audio == nil {
		return nil, errors.New("this file has no video or sound that can be played")
	}
	if video != nil {
		m.videoIndex = video.Index
	}
	if audio != nil {
		m.audioIndex = audio.Index
		m.HasAudio = true
	}

	formats := pr.Format.FormatName
	isMP4 := strings.Contains(formats, "mp4") || strings.Contains(formats, "mov")
	// ffprobe calls both MKV and WebM "matroska,webm"; Chrome only plays real WebM
	// (VP8/VP9/AV1 video with Opus/Vorbis sound) from that container.
	webmVideo := map[string]bool{"vp8": true, "vp9": true, "av1": true}
	webmAudio := map[string]bool{"opus": true, "vorbis": true}
	isWebM := strings.Contains(formats, "webm") &&
		(video == nil || webmVideo[video.CodecName]) && (audio == nil || webmAudio[audio.CodecName])
	vOK := video == nil || chromeVideo[video.CodecName]
	aOK := audio == nil || chromeAudio[audio.CodecName]
	tenBitH264 := video != nil && video.CodecName == "h264" && strings.Contains(video.PixFmt, "10")
	if (isMP4 || isWebM) && vOK && aOK && !tenBitH264 {
		m.Mode = "direct"
		return m, nil
	}

	m.Mode = "convert"
	var notes []string
	if video != nil {
		m.copyVideo = copyableVideo[video.CodecName] && !tenBitH264
		m.hevc = video.CodecName == "hevc"
		if !m.copyVideo {
			notes = append(notes, fmt.Sprintf("converting %s video to H.264", strings.ToUpper(video.CodecName)))
		}
	}
	if audio != nil {
		m.copyAudio = audio.CodecName == "aac"
		if !m.copyAudio {
			name := audioNames[audio.CodecName]
			if name == "" {
				name = strings.ToUpper(audio.CodecName)
			}
			notes = append(notes, fmt.Sprintf("converting %s sound to stereo AAC", name))
		}
	}
	if len(notes) == 0 {
		notes = append(notes, "repackaging the file for Chrome")
	}
	m.Note = strings.Join(notes, ", ")
	return m, nil
}

func registerMedia(m *mediaItem) {
	b := make([]byte, 8)
	rand.Read(b)
	m.ID = hex.EncodeToString(b)
	if m.Mode == "direct" {
		m.URL = "/media/" + m.ID + "/file"
	} else {
		m.URL = "/media/" + m.ID + "/stream"
	}
	mediaMu.Lock()
	mediaItems[m.ID] = m
	mediaMu.Unlock()
	log.Printf("media %s: %s (%s %s)", m.ID, m.Name, m.Mode, m.Note)
}

func openMedia(ctx context.Context, path string) (*mediaItem, error) {
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		return nil, errors.New("that file couldn't be opened")
	}
	pr, err := probe(ctx, path)
	if err != nil {
		return nil, err
	}
	m, err := planMedia(path, pr)
	if err != nil {
		return nil, err
	}
	registerMedia(m)
	return m, nil
}

var errPickerCancelled = errors.New("cancelled")

// pickFile shows the macOS file picker in front of everything and returns the chosen path.
func pickFile(ctx context.Context) (string, error) {
	if goos != "darwin" {
		return "", errors.New("unsupported")
	}
	cmd := exec.CommandContext(ctx, "osascript",
		"-e", `activate`,
		"-e", `set f to choose file with prompt "Choose a video to play on your TV"`,
		"-e", `POSIX path of f`)
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && strings.Contains(string(ee.Stderr), "-128") {
			return "", errPickerCancelled // user clicked Cancel
		}
		return "", fmt.Errorf("the file picker failed: %v", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// serveMediaAPI handles /api/media/* and /media/*. Only this Mac may use them.
func serveMediaAPI(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/api/media/pick" && r.Method == http.MethodPost:
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancel()
		path, err := pickFile(ctx)
		if errors.Is(err, errPickerCancelled) {
			writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"error": err.Error(), "fallback": true})
			return
		}
		m, err := openMedia(r.Context(), path)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, m)
	case r.URL.Path == "/api/media/open" && r.Method == http.MethodPost:
		var req struct {
			Path string `json:"path"`
		}
		json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req)
		m, err := openMedia(r.Context(), req.Path)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, m)
	case strings.HasPrefix(r.URL.Path, "/media/"):
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/media/"), "/")
		if len(parts) != 2 {
			http.NotFound(w, r)
			return
		}
		mediaMu.Lock()
		m := mediaItems[parts[0]]
		mediaMu.Unlock()
		if m == nil {
			http.NotFound(w, r)
			return
		}
		switch parts[1] {
		case "file":
			f, err := os.Open(m.path)
			if err != nil {
				http.Error(w, "file not available", http.StatusNotFound)
				return
			}
			defer f.Close()
			st, _ := f.Stat()
			http.ServeContent(w, r, m.Name, st.ModTime(), f)
		case "stream":
			start, _ := strconv.ParseFloat(r.URL.Query().Get("start"), 64)
			streamConverted(w, r, m, start)
		default:
			http.NotFound(w, r)
		}
	default:
		http.NotFound(w, r)
	}
}

var (
	encoderOnce sync.Once
	h264Encoder string
)

// videoEncoder picks the Mac's hardware H.264 encoder (or libx264 elsewhere, for testing).
func videoEncoder(ffmpeg string) string {
	encoderOnce.Do(func() {
		out, _ := exec.Command(ffmpeg, "-hide_banner", "-encoders").Output()
		s := string(out)
		switch {
		case strings.Contains(s, "h264_videotoolbox"):
			h264Encoder = "h264_videotoolbox"
		case strings.Contains(s, "libx264"):
			h264Encoder = "libx264"
		default:
			h264Encoder = ""
		}
	})
	return h264Encoder
}

func ffmpegArgs(m *mediaItem, start float64, encoder string) []string {
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error"}
	if start > 0 {
		args = append(args, "-ss", strconv.FormatFloat(start, 'f', 3, 64))
	}
	args = append(args, "-i", m.path)
	if m.videoIndex >= 0 {
		args = append(args, "-map", "0:"+strconv.Itoa(m.videoIndex))
		if m.copyVideo {
			args = append(args, "-c:v", "copy")
			if m.hevc {
				args = append(args, "-tag:v", "hvc1")
			}
		} else {
			args = append(args, "-c:v", encoder, "-b:v", "10M", "-maxrate", "14M", "-bufsize", "20M",
				"-pix_fmt", "yuv420p", "-g", "60")
			if encoder == "libx264" {
				args = append(args, "-preset", "veryfast")
			} else {
				// Falls back to Apple's software encoder if the hardware one is busy/unavailable.
				args = append(args, "-realtime", "1", "-allow_sw", "1")
			}
		}
	}
	if m.audioIndex >= 0 {
		args = append(args, "-map", "0:"+strconv.Itoa(m.audioIndex))
		if m.copyAudio {
			args = append(args, "-c:a", "copy")
		} else {
			args = append(args, "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000")
		}
	}
	args = append(args, "-sn", "-dn", "-map_chapters", "-1", "-map_metadata", "-1",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000",
		"-f", "mp4", "pipe:1")
	return args
}

func streamConverted(w http.ResponseWriter, r *http.Request, m *mediaItem, start float64) {
	ffmpeg, err := toolPath("ffmpeg")
	if err != nil {
		http.Error(w, "ffmpeg is missing from this build", http.StatusInternalServerError)
		return
	}
	enc := ""
	if !m.copyVideo && m.videoIndex >= 0 {
		if enc = videoEncoder(ffmpeg); enc == "" {
			http.Error(w, "no H.264 encoder available", http.StatusInternalServerError)
			return
		}
	}
	// Stops ffmpeg as soon as Chrome drops the connection (seek, stop, new file).
	cmd := exec.CommandContext(r.Context(), ffmpeg, ffmpegArgs(m, start, enc)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	if err := cmd.Start(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("media %s: converting from %.1fs", m.ID, start)
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 256<<10)
	for {
		n, rerr := stdout.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				break
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			break
		}
	}
	err = cmd.Wait()
	if err != nil && r.Context().Err() == nil {
		log.Printf("media %s: ffmpeg failed: %v %s", m.ID, err, stderr.String())
	}
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := len(p)
		if k > l.n {
			k = l.n
		}
		l.w.Write(p[:k])
		l.n -= k
	}
	return len(p), nil
}

// nativePickerAvailable tells the page whether to use our picker or the browser's.
func nativePickerAvailable() bool {
	_, err := toolPath("ffprobe")
	return runtime.GOOS == "darwin" && goos == "darwin" && err == nil
}
