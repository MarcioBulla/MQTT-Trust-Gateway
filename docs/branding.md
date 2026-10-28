# Gateway icon

`admin-web/frontend/public/MyMosquitto.svg` combines the owner's geometric
four-part M from MyLogo.svg with symmetrical signal arcs and an antenna dot.
The original monogram file is preserved.

The palette was sampled from the Mosquitto image on the
[provided reference page](https://www.woellsdorf-wetter.de/software/mosquitto.html):
navy `#344364` and orange `#F48F31`. Translucent navy overlays preserve the M's
folded geometry. The rounded tile has transparent outer corners. This is a
custom gateway mark and does not claim Eclipse endorsement.

Files served by the admin application:

- `MyMosquitto.svg`: editable vector master and browser favicon.
- `MyMosquitto.png`: 512 × 512 transparent PNG.
- `favicon.ico`: 16, 32 and 48 pixel browser fallback.
- `apple-touch-icon.png`: 180 × 180 touch icon.

The vector master is also saved alongside the owner's original as
`MyMosquitto.svg`. The console displays it beside Gateway console in the sidebar
and in the header when the sidebar is hidden.

To regenerate raster exports with librsvg and ImageMagick:

```sh
rsvg-convert -w 512 -h 512 admin-web/frontend/public/MyMosquitto.svg \
  -o admin-web/frontend/public/MyMosquitto.png
rsvg-convert -w 180 -h 180 admin-web/frontend/public/MyMosquitto.svg \
  -o admin-web/frontend/public/apple-touch-icon.png
magick admin-web/frontend/public/MyMosquitto.png \
  -define icon:auto-resize=48,32,16 admin-web/frontend/public/favicon.ico
```
