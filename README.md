# Track Map

A digital, database-backed version of the system track map (`source/System_Map_Print.pdf`).
The map looks the same as the PDF because the base layer *is* the PDF, rendered
into map tiles at up to 16 pixels per point (about 1150 dpi), so it stays sharp
however far you zoom, including on high-density phone screens. Everything
interactive sits on top of it in the same coordinate frame and is driven by
data extracted automatically from the drawing.

## Website

The viewer is deployed to GitHub Pages from `main` by
`.github/workflows/pages.yml`. The workflow renders the map tiles from the PDF
(`pipeline/make_tiles.py`, about 2 minutes) and publishes the `web/` folder:
**https://khouryai.github.io/Track-Plan/**

A static host has no server, so on the website access requests are saved
**in the viewer's browser** (localStorage). Use *Export JSON* / *Import JSON* to
share or back them up. To keep requests in the shared SQLite database, run the
server below; the same page then reads and writes through its API.

## Run locally with the database

```bash
python3 pipeline/make_tiles.py   # once: render web/tiles (needs poppler-utils, Pillow, numpy)
python3 server.py                # http://127.0.0.1:8000  (standard library only)
```

The server creates `db/trackmap.db` from `web/data/map.json` on first run.

## Using the map

- pan and zoom the drawing (mouse wheel, drag, pinch, `+` / `-`); the drawing
  stays sharp at every zoom
- hover (or tap, on a phone) **any** track to identify it: running tracks show
  their exact milepost (`W1 MP 23.500`); crossovers, yard leads, pocket and
  middle tracks show their name and where they meet the running tracks
  (`Crossover SW177/SW377 · between M1 MP 16.29 and M3 MP 16.28`)
- create **track access requests** from any mix of:
  - **Box select**: drag a rectangle over a block of tracks; every piece of
    track inside becomes part of the request, listed by track and milepost
    range (`M1 MP 16.039 – 16.350`, `M3 MP 16.020 – 16.381`) plus the
    crossovers and yard tracks it includes
  - **Draw along track**: click the start, then click along the route through
    any crossover to the end
  - **Add / remove pieces**: click individual crossovers or yard tracks
  - a typed track and milepost range
  - a **location**: any station, its **TCR (train control room)**, a yard or
    platform (e.g. `Colma TCR (Train Control Room)`)
- requests are drawn on the map colour-coded by status; requests that share
  any track or the same location in an overlapping time window are flagged
- go to a milepost or station (Find tab); show all selectable track by type,
  calibrated centrelines, milepost anchors and labels that need review (Layers)

## How the data is extracted

`python3 pipeline/build.py` regenerates everything from the PDF (about 40 s; needs
`pip install -r requirements.txt`, `poppler-utils` and the Liberation fonts).

1. **Base map.** `pipeline/make_tiles.py` renders the PDF with poppler into
   256 px tiles for zoom levels -4 to 4 (1/16 to 16 pixels per point; blank
   tiles are skipped), and the viewer (Leaflet) loads only the tiles on screen.
   `pdftocairo -svg` also writes a vector copy to `web/map.svg`. The
   PDF names Arial and Swiss 721 but doesn't embed them, so `pipeline/fonts.conf`
   maps them to Liberation Sans, which has the same character widths. Compared
   pixel by pixel against Poppler's own render of the PDF, 99.1% of the ink
   matches within 1 px. The rest is anti-aliasing on sub-point dots.
2. **Milepost labels.** The milepost boxes (`24.39W1`) and interface ovals
   (`0.99Y`) are not PDF text. AutoCAD drew them as stroke glyphs. Every
   character is rasterised in reading orientation and matched against 47 glyph
   prototypes (`pipeline/glyph_prototypes.npz`, built once with
   `train_glyphs.py`). This also handles labels drawn upside-down. Result:
   684 labels, lowest match confidence 0.97.
3. **Track network.** Track is drawn as pairs of parallel lines about 3.7 pt apart
   (grade and subway sections) or as filled bars (aerial sections). That
   linework is rasterised, skeletonised and turned back into a graph of
   centrelines. The graph is then tidied: tiny junction edges are merged,
   short spurs are removed, and collinear gaps are bridged.
4. **Which track is which.** The network is split into continuous *rails* by
   following the straightest path through each switch. Each rail is named from
   four sources: the track names written beside the lines (`M3`, `W1`), the
   small track-number tags (`1`, `2`), explicit mileposts (`W1`) and line-level
   mileposts (`4.37C`). Leaders often stop on the first track they meet; a
   milepost that contradicts the written name or tag on that rail is carried
   on along its leader to the next rail (this fixed, for example, M1 / M3 at
   Daly City Yard).
5. **Every other piece of track.** All 692 network segments (running tracks,
   crossovers, yard leads, pocket and middle tracks) are named. Crossovers get
   their two switch numbers: about 300 `SW###` labels are decoded from stroke
   glyphs and matched one-to-one to junctions, scored by distance to the
   junction and its diverging leg. Yard tracks get their written names (DTF01,
   TF5). Each segment records the calibrated milepost where it meets a running
   track.
6. **Linear referencing.** Each label's leader line is traced to the track it
   points at. Line-level mileposts are projected onto every track of their
   line. Anchors that don't run in order along the rail are dropped. Between
   consecutive anchors, the milepost is interpolated by distance along the
   drawn track.

### Accuracy, and what needs a human

- Positions are **exact at every drawn milepost and interpolated between them**.
  The sheet is *not to scale* (it says so), so a long stretch with no labels
  can be squeezed into a few points of drawing. The interpolated position is
  correct in order and approximately right in place.
- 24 tracks are calibrated: A1-2, C1-4, CX3, L1-3, M1-3, R1-2, S1-2, W1-4 and Y1-3.
  `docs/qa_report.md` lists coverage per track and every label that was set
  aside, with its position on the page. The flagged items cluster where the
  geometry is complex, mainly the Oakland Wye zero points, the Y-line junction
  and the Daly City / Millbrae ends.
- The extraction found at least one error in the source drawing: `23.38S` is
  drawn between `25.35S` and `25.52S`. It is excluded in `pipeline/overrides.json`.
- Corrections found during review go in `pipeline/overrides.json`
  (ignore a label, or fix its MP or track). They are reapplied on every rebuild.

## Database

`db/schema.sql` (SQLite):

| table | contents |
|---|---|
| `tracks` | calibrated tracks and their MP range |
| `track_pieces`, `track_legs` | geometry between consecutive milepost anchors, with an MP for every vertex |
| `route_anchors` | the milepost anchor points used for calibration |
| `milepost_labels` | every label read off the drawing, with its status |
| `stations` | station and yard names |
| `track_segments` | every piece of track: name, kind (running / crossover / yard / track), switches, milepost at each end, geometry |
| `locations` | stations, train control rooms (TCR), yards and platforms that requests can name |
| `access_requests` | **your operational data**: track limits (geometry plus the MP ranges and pieces they cover), typed track/MP range, location, time window, work type, requester, status |

Rebuilding the extracted data keeps the existing `access_requests`.

### API

| | |
|---|---|
| `GET /api/tracks` | calibrated tracks |
| `GET /api/locate?track=W1&mp=23.5` | drawing position of a milepost |
| `GET /api/segment?track=W1&from=23&to=24` | polylines covering an MP range |
| `GET/POST /api/requests`, `PUT/DELETE /api/requests/<id>` | access requests |

`/api/segment` is the hook for linking an existing track-access system: send
it a track and MP range and draw what comes back.

## Layout

```
source/   the original PDF
pipeline/ extraction (pdfmap, labels, tracks, linref, build), glyph prototypes, fonts.conf, overrides
web/      viewer (index.html, app.js, style.css, vendor/leaflet), map.svg, data/map.json; tiles/ is generated
db/       schema.sql (trackmap.db is generated, not committed)
docs/     qa_report.md
server.py
```

## Next steps

- Review `docs/qa_report.md` with someone who knows the territory and record
  the fixes in `overrides.json`.
- For multi-user use, move to Postgres/PostGIS. The schema maps directly, and
  `geometry` becomes a `LINESTRING` with `ST_LineSubstring` for MP ranges.
  Add authentication in front of the API.
- Extract interlocking limits (the `W45` dimension arrows) so requests can be
  made by interlocking as well as by MP.
