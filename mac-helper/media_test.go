package main

import (
	"strings"
	"testing"
)

func pr(format string, streams ...probeStream) *probeResult {
	p := &probeResult{Streams: streams}
	p.Format.FormatName = format
	p.Format.Duration = "5400.0"
	for i := range p.Streams {
		p.Streams[i].Index = i
	}
	return p
}

func v(codec, pix string) probeStream {
	return probeStream{CodecType: "video", CodecName: codec, PixFmt: pix}
}
func a(codec string) probeStream { return probeStream{CodecType: "audio", CodecName: codec} }

func TestPlanMedia(t *testing.T) {
	cases := []struct {
		name                 string
		in                   *probeResult
		mode                 string
		copyVideo, copyAudio bool
		note                 string
	}{
		{"mp4 h264 aac", pr("mov,mp4,m4a,3gp,3g2,mj2", v("h264", "yuv420p"), a("aac")), "direct", false, false, ""},
		{"webm vp9 opus", pr("matroska,webm", v("vp9", "yuv420p"), a("opus")), "direct", false, false, ""},
		{"mkv h264 ac3", pr("matroska,webm", v("h264", "yuv420p"), a("ac3")), "convert", true, false, "Dolby Digital (AC3)"},
		{"mkv hevc dts", pr("matroska,webm", v("hevc", "yuv420p10le"), a("dts")), "convert", true, false, "DTS"},
		{"mkv h264 aac", pr("matroska,webm", v("h264", "yuv420p"), a("aac")), "convert", true, true, "repackaging"},
		{"mkv eac3", pr("matroska,webm", v("h264", "yuv420p"), a("eac3")), "convert", true, false, "E-AC3"},
		{"avi xvid mp3", pr("avi", v("mpeg4", "yuv420p"), a("mp3")), "convert", false, false, "MPEG4 video"},
		{"mp4 10-bit h264", pr("mov,mp4,m4a,3gp,3g2,mj2", v("h264", "yuv420p10le"), a("aac")), "convert", false, true, "H264 video"},
		{"mp4 with ac3", pr("mov,mp4,m4a,3gp,3g2,mj2", v("h264", "yuv420p"), a("ac3")), "convert", true, false, "AC3"},
	}
	for _, c := range cases {
		m, err := planMedia("/x/"+c.name, c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if m.Mode != c.mode || (c.mode == "convert" && (m.copyVideo != c.copyVideo || m.copyAudio != c.copyAudio)) {
			t.Errorf("%s: mode=%s copyVideo=%v copyAudio=%v", c.name, m.Mode, m.copyVideo, m.copyAudio)
		}
		if !strings.Contains(m.Note, c.note) {
			t.Errorf("%s: note %q should mention %q", c.name, m.Note, c.note)
		}
	}
}

func TestPlanPrefersDefaultAudioAndSkipsCoverArt(t *testing.T) {
	cover := v("mjpeg", "yuvj420p")
	cover.Disposition = map[string]int{"attached_pic": 1}
	commentary := a("ac3")
	main := a("dts")
	main.Disposition = map[string]int{"default": 1}
	m, err := planMedia("/x", pr("matroska,webm", cover, v("h264", "yuv420p"), commentary, main))
	if err != nil {
		t.Fatal(err)
	}
	if m.videoIndex != 1 || m.audioIndex != 3 {
		t.Fatalf("picked video %d audio %d", m.videoIndex, m.audioIndex)
	}
}

func TestFFmpegArgsHEVCTagAndSeek(t *testing.T) {
	m, _ := planMedia("/movie.mkv", pr("matroska,webm", v("hevc", "yuv420p"), a("truehd")))
	args := strings.Join(ffmpegArgs(m, 754.5, ""), " ")
	for _, want := range []string{"-ss 754.500", "-c:v copy", "-tag:v hvc1", "-c:a aac", "-ac 2", "frag_keyframe"} {
		if !strings.Contains(args, want) {
			t.Errorf("args missing %q: %s", want, args)
		}
	}
}
