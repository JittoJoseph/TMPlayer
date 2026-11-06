#!/bin/bash
# The small test files the end to end tests play (4 s, 320 x 180), one per way a file plays:
# native, repacked, sound converted, decoded by libav.js (AVI), and one that needs the app. Run again after changing a line.
set -e
cd "$(dirname "$0")/media"
SRC="-f lavfi -i testsrc2=size=320x180:rate=25:duration=4 -f lavfi -i sine=frequency=440:duration=4:sample_rate=48000"
H264="-c:v libx264 -preset veryfast -b:v 200k -g 25 -pix_fmt yuv420p"
q="-hide_banner -loglevel error -y"
out="-fflags +bitexact -map_metadata -1"
ffmpeg $q $SRC -map 0 -map 1 $out $H264 -c:a aac -b:a 64k -movflags +faststart h264-aac.mp4
ffmpeg $q $SRC -map 0 -map 1 $out $H264 -c:a aac -b:a 64k tail-index.mp4
ffmpeg $q $SRC -map 0 -map 1 $out $H264 -c:a aac -b:a 64k h264-aac.mkv
ffmpeg $q $SRC -map 0 -map 1 $out $H264 -c:a aac -b:a 64k h264-aac.ts
ffmpeg $q $SRC -map 0 -map 1 $out $H264 -c:a ac3 -b:a 96k h264-ac3.mkv
ffmpeg $q $SRC -map 0 -map 1 $out -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -b:v 200k -g 25 -c:a libopus -b:a 48k vp9-opus.webm
ffmpeg $q $SRC -map 0 -map 1 $out -c:v mpeg4 -b:v 200k -g 25 -c:a ac3 -b:a 96k mpeg4.avi
ffmpeg $q $SRC -map 0 -map 1 -map 1 $out -c:v mpeg4 -vtag XVID -bf 2 -b:v 200k -g 50 -c:a libmp3lame -ar 44100 -b:a 64k xvid-mp3.avi
ffmpeg $q $SRC -map 0 -map 1 $out -c:v msmpeg4 -b:v 200k -g 25 -c:a libmp3lame -ar 44100 -b:a 64k divx3.avi
ffmpeg $q $SRC -map 0 -map 1 $out $H264 -bf 0 -c:a libmp3lame -ar 44100 -b:a 64k h264-mp3.avi
ffmpeg $q $SRC -map 0 -map 1 $out -c:v wmv2 -b:v 200k -c:a wmav2 -b:a 64k wmv2.wmv
# AVIs libav.js cannot finish: a picture it has no decoder for, sound it has none for, a file cut off part way.
ffmpeg $q $SRC -map 0 -map 1 $out -c:v wmv2 -b:v 200k -c:a libmp3lame -ar 44100 -b:a 64k wmv2.avi
ffmpeg $q $SRC -map 0 -map 1 $out -c:v mpeg4 -b:v 200k -g 25 -c:a wmav2 -b:a 64k mpeg4-wma.avi
head -c 143500 xvid-mp3.avi > cut.avi
# 20 s with three chapters (Intro, The Harbour, Credits): the chapter bar, the skip pill and the autoplay tests.
printf ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=5000\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=15000\ntitle=The Harbour\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=15000\nEND=20000\ntitle=Credits\n' > chapters.txt
LONG="-f lavfi -i testsrc2=size=320x180:rate=25:duration=20 -f lavfi -i sine=frequency=440:duration=20:sample_rate=48000 -i chapters.txt -map 0 -map 1 -map_metadata 2"
LOWH264="-c:v libx264 -preset veryfast -b:v 60k -g 25 -pix_fmt yuv420p -c:a aac -b:a 32k"
ffmpeg $q $LONG $out $LOWH264 chapters.mkv
ffmpeg $q $LONG $out $LOWH264 -movflags +faststart chapters.mp4
rm chapters.txt
# 8 s with two sound tracks (Hindi, Tamil) and two subtitle tracks of its own (English SubRip, Spanish ASS):
# the file's own tracks in the Subtitles and Audio menus.
printf '1\n00:00:00,500 --> 00:00:02,000\nFirst test line\n\n2\n00:00:02,500 --> 00:00:04,000\nSecond <i>test</i> line\n\n3\n00:00:05,000 --> 00:00:07,500\nThird test line\n' > tracks-en.srt
printf '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV\nStyle: Default,Arial,20,&H00FFFFFF,0,0,2,10,10,10\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\i1}Primera{\i0} linea\Nde prueba\nDialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Segunda linea\n' > tracks-es.ass
TRACKS="-f lavfi -i testsrc2=size=320x180:rate=25:duration=8 -f lavfi -i sine=frequency=440:duration=8:sample_rate=48000 -f lavfi -i sine=frequency=660:duration=8:sample_rate=48000 -i tracks-en.srt -i tracks-es.ass"
ffmpeg $q $TRACKS -map 0 -map 1 -map 2 -map 3 -map 4 $out $H264 -c:a aac -b:a 48k -c:s copy \
    -metadata:s:a:0 language=hin -metadata:s:a:1 language=tam -metadata:s:s:0 language=eng -metadata:s:s:1 language=spa -metadata:s:s:1 title=Spanish \
    -disposition:s:0 0 -disposition:s:1 0 tracks.mkv
rm tracks-en.srt tracks-es.ass
# An AVI whose header is cut off after the first 4 KiB: FFmpeg cannot read it.
head -c 4096 divx3.avi > broken.avi
ffmpeg $q -f lavfi -i testsrc2=size=160x240:rate=1 -frames:v 1 -q:v 6 $out thumb.jpg
