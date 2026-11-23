#!/usr/bin/env bash
# Builds a small, LGPL-only FFmpeg (ffmpeg + ffprobe) for macOS as universal
# (Apple Silicon + Intel) binaries, with just what Fire TV Cast needs to convert
# video files for Chrome: common demuxers and decoders, the AAC encoder, the
# Mac's hardware H.264 encoder (VideoToolbox) and the MP4 muxer.
#
# Usage: build-ffmpeg.sh <output-dir>
set -euo pipefail

VERSION=7.1.1
OUT_DIR="$1"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
WORK="$(mktemp -d)"
cd "$WORK"

curl -fsSL -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz"
tar xf ffmpeg.tar.xz

DEMUXERS=matroska,mov,avi,mpegts,mpegps,flv,asf,ogg,wav,mp3,aac,ac3,eac3,dts,truehd,flac,h264,hevc,m4v,mpegvideo
DECODERS=aac,aac_fixed,aac_latm,ac3,ac3_fixed,eac3,dca,truehd,mlp,mp3,mp3float,mp2,mp2float,mp1,flac,alac,opus,vorbis,wmav1,wmav2,wmapro,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_u8,pcm_bluray,pcm_dvd,h264,hevc,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,h263,flv,mpeg1video,mpeg2video,vc1,wmv1,wmv2,wmv3,vp8,vp9,theora,mjpeg
PARSERS=h264,hevc,aac,aac_latm,ac3,dca,mlp,mpegaudio,mpeg4video,mpegvideo,vc1,vp8,vp9,opus,vorbis,flac,h263
BSFS=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,vp9_superframe,mpeg4_unpack_bframes,null
FILTERS=aresample,aformat,anull,null,format,scale,pan,volume,buffer,buffersink,abuffer,abuffersink,trim,atrim

for ARCH in arm64 x86_64; do
  rm -rf "build-$ARCH"
  cp -R "ffmpeg-${VERSION}" "build-$ARCH"
  pushd "build-$ARCH" >/dev/null
  EXTRA=()
  if [ "$ARCH" != "$(uname -m)" ]; then
    EXTRA+=(--enable-cross-compile)
  fi
  if [ "$ARCH" = x86_64 ]; then
    EXTRA+=(--disable-x86asm)   # no nasm on the build machine; not needed for our light work
  fi
  ./configure \
    --arch="$ARCH" --target-os=darwin --cc="clang -arch $ARCH" \
    --extra-cflags="-mmacosx-version-min=11.0" --extra-ldflags="-arch $ARCH -mmacosx-version-min=11.0" \
    "${EXTRA[@]}" \
    --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-network \
    --disable-ffplay --enable-ffmpeg --enable-ffprobe \
    --enable-videotoolbox --enable-zlib \
    --enable-protocol=file,pipe \
    --enable-demuxer="$DEMUXERS" \
    --enable-muxer=mp4 \
    --enable-decoder="$DECODERS" \
    --enable-encoder=aac,h264_videotoolbox \
    --enable-parser="$PARSERS" \
    --enable-bsf="$BSFS" \
    --enable-filter="$FILTERS"
  make -j"$(sysctl -n hw.ncpu)" ffmpeg ffprobe
  mkdir -p "../out-$ARCH"
  cp ffmpeg ffprobe "../out-$ARCH/"
  popd >/dev/null
done

lipo -create -output "$OUT_DIR/ffmpeg" out-arm64/ffmpeg out-x86_64/ffmpeg
lipo -create -output "$OUT_DIR/ffprobe" out-arm64/ffprobe out-x86_64/ffprobe
cp "ffmpeg-${VERSION}/COPYING.LGPLv2.1" "$OUT_DIR/FFMPEG-LICENSE.txt"
echo "FFmpeg ${VERSION}, built from https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz with build-ffmpeg.sh (LGPL v2.1+)." > "$OUT_DIR/FFMPEG-SOURCE.txt"

lipo -info "$OUT_DIR/ffmpeg"
"$OUT_DIR/ffmpeg" -hide_banner -encoders | grep -E "aac|videotoolbox"
"$OUT_DIR/ffmpeg" -hide_banner -decoders | grep -cE "^ [VA]" | sed 's/^/decoders: /'
