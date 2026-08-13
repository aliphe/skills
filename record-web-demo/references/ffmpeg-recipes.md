# ffmpeg recipes

Recipes beyond what `scripts/render.sh` covers (plain mp4, uniform `--speed`, plain `--gif`). INPUT is the webm from the demo run; every command works on the rendered mp4 too.

## Trim

Cut to the segment between 2.5s and 18s:

```bash
ffmpeg -y -i in.webm -ss 2.5 -to 18 -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart out.mp4
```

Keep `-ss` after `-i` for frame-accurate cuts on short clips.

## Speed up one section only

Concatenate normal → fast → normal segments with `trim` + `setpts`:

```bash
ffmpeg -y -i in.webm -filter_complex "\
[0:v]trim=0:8,setpts=PTS-STARTPTS[a];\
[0:v]trim=8:20,setpts=(PTS-STARTPTS)/3[b];\
[0:v]trim=20,setpts=PTS-STARTPTS[c];\
[a][b][c]concat=n=3:v=1" -c:v libx264 -crf 18 -pix_fmt yuv420p out.mp4
```

Useful when a long form-fill should fly by but the reveal must stay slow.

## Zoom on a point of interest

Smooth push-in toward a click at (x=450, y=240) in a 1280x720 recording, starting at frame 100:

```bash
ffmpeg -y -i in.webm -vf "zoompan=\
z='if(between(in,100,200),min(zoom+0.01,1.5),max(zoom-0.03,1))':\
x='450-(450/zoom)':y='240-(240/zoom)':d=1:s=1280x720:fps=25" \
-c:v libx264 -crf 18 -pix_fmt yuv420p out.mp4
```

`in` is the frame number (25fps); tune the `between()` window to the click timestamp × 25.

## Gif size tuning

- Lower `fps` (12 → 8) and `scale` width (960 → 720) are the two biggest levers.
- Add `=stats_mode=diff` to `palettegen` and `:dither=bayer` to `paletteuse` for UI captures — flat colors compress much better:

```bash
ffmpeg -y -i in.webm -filter_complex "fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer" out.gif
```
