# Track Plan

A digital, database-backed version of the system track map (`source/System_Map_Print.pdf`),
and the planning that happens on it: the **four-week look-ahead (4WLA)**, each
activity **linked to where it is on the track plan**, and the **track access work
requests (TAWRs)** raised from both, approved by the Track Allocation Manager and
downloaded as BART's own form.

The map looks the same as the PDF because the base layer *is* the PDF, rendered
into map tiles at up to 16 pixels per point (about 1150 dpi), so it stays sharp
however far you zoom, including on high-density phone screens. Everything
interactive sits on top of it in the same coordinate frame and is driven by
data extracted automatically from the drawing.

## The workflow

```
 Look-ahead                   Track plan                    TAWRs
 ──────────                   ──────────                    ─────
 activity, painted by    ──►  hover its Location cell  ──►  one request per place and shift
 shift, BART support          → Link:                       per week, raised by itself ahead
 typed in each day            TCR / station / block of      of the deadline (17 days before
 ("X.WIT")                    track → the Location cell     the Monday), Area from the link
                              and the TAWR's Area           │
                                                            ├─ Requester: review, submit
                                                            └─ Track Allocation Manager:
                                                               consolidate overlaps, approve
                                                               or reject → BART's form (PDF)
```

1. **Fill in the look-ahead** (*Look-ahead* view). The same 4WLA as in Excel:
   Activity ID, Description, Location, SSWP#, Party to Action, Work Hours, then a
   column per day for four or five weeks. Paint a day in its shift colour (Day,
   Swing, Night, Blanket, Cancellation) and type the BART support it needs in the
   cell — `X` an EIC, `WIT` a witness, `TCE`, `ROC`, `X.WIT` both, `~WIT` a
   witness cancelled. A Resource row under an activity names the crew. It
   behaves like a spreadsheet: drag to select, Alt+1…5 to paint, Enter to edit,
   Delete, Ctrl+Z / Ctrl+Y, copy and paste. A copy carries each day's shift
   colour as well as its text — within the calendar, and into Excel — and one
   day copied onto several fills them all. An existing 4WLA workbook can be
   imported (*Import 4WLA (.xlsx)*): the calendar sheet is found by its row of
   weekday letters, the workbook's own colour key is read, and a colour nobody has
   named is asked about, never guessed.
2. **Link each activity's location** — hover its Location cell and press *Link*
   (or right-click it → *Select on track plan…*). Once linked, *Map* shows it on
   the track plan, and the cell's *#21* opens the TAWR made from it. After any
   jump to the map, *← Back* returns to where you were. The map opens on that
   activity, in two steps: **1** its **TCR (train control room)**, station, yard
   or platform, if it has one — type to find it, or click a blue pin — and **2**
   its **block of track**, if it is on the track: clicking along the track is on
   from the start (click where the work starts, then where it ends, through
   crossovers too); box select, adding pieces and typing a track and milepost
   range are there as other ways. Choosing a TCR and track says it will make two
   TAWRs. **Only the limits
   matter on the track**: however it was picked, the selection reads as the
   leftmost and rightmost milepost on each line with every track between —
   `W1+W2+W3 MP 23.747–24.446` — and the crossovers inside are not listed.
   *Use this location* writes it into the Location cell
   (`Colma TCR · W2 MP 16.600–16.900`). A location typed exactly as a station
   or TCR is recognised; anything else is marked, and its TAWR cannot be
   submitted until it is linked.
3. **The TAWRs raise themselves.** The week whose requests are due next is
   highlighted on the look-ahead (*TAWR week*). Every week due within the lead
   time (Setup, default 7 days before the deadline) gets its drafts without
   anybody asking: one per place and shift, its days, combined hours (or the
   shift's), the BART support on its busiest day, SSWP numbers and the work
   description. **A TCR and track are never one request** — they are different
   categories of work — so an activity linked to both raises two: `Colma TCR`,
   and `W2 MP 16.600-16.900`. Its BART support is asked for once, on the track
   request, and the TCR request says so. A track request is marked as work in the
   track zone, and each kind takes its own Category of Work from Setup. Drafts
   follow the look-ahead as it changes and keep anything typed into them by hand.
4. **The requester reviews and submits** (*TAWRs* view). The week's requests
   are a table, one row each: where, when, the work and its party, BART support,
   and its status with **the next step in words** — *Your turn: review and submit
   by Fri 23 Oct*, *Waiting for the Track Allocation Manager*, *Approved: download
   BART's form*. *Details* opens the rest under the row: what needs attention
   (in red), notes (folded away), history and the less common actions. A TCR
   request names the track request made from the same activity. Every field of
   BART's form can be checked in *Review*, which says what BART usually needs that
   is still blank; *Submit* (one, or several picked at once).
5. **The Track Allocation Manager decides.** Requests whose places **overlap** on
   the drawing — the same TCR, or track in common — in the same week and shift are
   named to each other; *Consolidate* makes them one request (the limits
   accumulated, support recounted, hand edits kept), and *Split back up* undoes
   it. A TCR request and a track request are never consolidated. Requests that want
   the same track (or room) **at the same time** — whatever their shift: a Blanket
   from midnight meets the night shift before it — are marked as conflicts in their
   rows and on the track plan. Then *Approve* or
   *Reject* (with a reason the requester sees), one by one or in bulk. An approved
   request is final: changing it is a *Revise*, which keeps the approved version
   as superseded. If two approved requests still repeat each other, the page says
   so before anything is downloaded.
6. **Submittal**: *Download PDF* fills BART's own fillable form (uploaded once in
   Setup, never committed or published) and signs it with the requester's
   signature; *Download approved* puts the week's forms in one .zip, and the
   *Submittal register (CSV)* lists them.

**Sample data.** *Look-ahead → Sample data…* loads four weeks of W and M line
work from the coming Monday — cable trough and signal cable on the W line,
foundations, rail and tie replacement, ATC loop cable, trench and conduit;
IXL simulation and DCS checks in the San Bruno, Millbrae, Daly City and Balboa
Park TCRs, track circuit, switch machine, CBTC radio and integrated system
testing — every location linked to the track plan, and the TAWRs raised from it.
Five conflicts are planted in it (`web/js/sample.js` says where): two on one
shift that can be consolidated, a day shift and a swing shift on W1, two
shifts in the Daly City TCR at once, and a night shift running into a Blanket
on M2. On the static site it can clear the browser's TAWRs for a clean start.
The weeks whose deadline has already passed come as they would be by now: a
week past its deadline is submitted, and approved once the deadline is a week
gone — except the requests in a conflict, which wait for the Track Allocation
Manager. On a server, only the steps the signed-in account may take are taken.

The *Track plan* view opens fitted to the whole sheet and shows the week's
TAWRs drawn where they are, coloured by status, with every linked activity.
Every track request carries its number on its line (a TCR request is pinned at
the room), so each can be found even when the sheet is fitted. Hovering a
request or an activity shows its party to action, description, limits and days.
The sidebar's *TAWRs* tab picks the week, filters by status (with the week's
counts) or to the requests in a conflict, and has a key to the marks. Each
conflict is said in words — *#18 and #19 want the same track at the same time*,
the work and hours of each, and where and when they meet — and marked on the
map; the request, or both sides of a conflict, picked from the list or the map
glows. *Open TAWR* goes to it in the TAWRs view.

### Roles

| | Requester | Track Allocation Manager | Viewer |
|---|---|---|---|
| Edit the look-ahead, link locations, Setup | yes | yes | — |
| Raise, review and submit drafts; withdraw; reopen a rejected one; revise | yes | yes | — |
| Approve, reject, consolidate, split | — | yes | — |
| Add and change accounts (server) | — | yes | — |
| Read everything | yes | yes | yes |

Who may do what is one table, `web/data/tawr_workflow.json`. The page only offers
what it allows; **`server.py` enforces it** (`operations.py`) — a requester
cannot approve however the request is made, an approved request cannot be
changed, a viewer cannot write.

## Website

The viewer is deployed to GitHub Pages from `main` by
`.github/workflows/pages.yml`. The workflow renders the map tiles from the PDF
(`pipeline/make_tiles.py`, about 2 minutes) and publishes the `web/` folder:
**https://khouryai.github.io/Track-Plan/**

A static host has no server, so on the website the look-ahead and the TAWRs are
kept **in the viewer's browser** (localStorage, and IndexedDB for BART's form),
and the person says which role they are acting in. Nothing on a static site can
check that choice — use it to try the workflow, or for one person. *TAWRs → Setup
→ Back up* moves the browser's copy elsewhere. For a requester and a Track
Allocation Manager working together, run the server.

## Run with the server (accounts, shared data)

```bash
python3 pipeline/make_tiles.py   # once: render web/tiles (needs poppler-utils, Pillow, numpy)
python3 server.py                # http://127.0.0.1:8000  (standard library only)
```

Without tiles the viewer falls back to the vector copy of the drawing
(`web/map.svg`), softer when zoomed but fine for development.

The first visit makes the first account, which is the **Track Allocation
Manager**; the manager adds the requester (and any viewers) under *Accounts*, or:

```bash
python3 server.py --add-user rae --name "Rae Requester" --role requester
```

Passwords are stored as PBKDF2 hashes, sessions as hashed tokens in an
HttpOnly cookie, and every change must carry `X-Requested-With: trackplan`, so
a page on another site cannot act for a signed-in browser. Put the server behind
HTTPS (a reverse proxy) for use beyond one machine.

The server creates `db/trackmap.db` (the map) from `web/data/map.json` and
`db/operations.db` (accounts, look-ahead, TAWRs) on first run. The map database
is rebuilt by the extraction; the operations database never is. BART's blank form
is kept at `db/tawr_template.pdf` — outside `web/`, ignored by git.

## Using the map

- pan and zoom the drawing (mouse wheel, drag, pinch, `+` / `-`); the drawing
  stays sharp at every zoom
- hover (or tap, on a phone) **any** track to identify it: running tracks show
  their exact milepost (`W1 MP 23.500`); crossovers, yard leads, pocket and
  middle tracks show their name and where they meet the running tracks
  (`Crossover SW177/SW377 · between M1 MP 16.29 and M3 MP 16.28`)
- when linking an activity's location, pick any mix of:
  - a **place**: a station, its **TCR (train control room)**, a yard or platform
    (the list, or a blue pin on the map)
  - **Box select**: drag a rectangle over a block of tracks; every piece of
    track inside becomes part of the location, listed by track and milepost
    range (`M1 MP 16.039 – 16.350`, `M3 MP 16.020 – 16.381`) plus the
    crossovers and yard tracks it includes
  - **Draw along track**: click the start, then click along the route through
    any crossover to the end
  - **Add / remove pieces**: click individual crossovers or yard tracks
  - a typed track and milepost range
- the week's TAWRs are drawn colour-coded by status, with the linked activities;
  hover any of them for the party to action, description, limits and days;
  filter by status; conflicts are listed and marked with a red pin; whatever is
  picked glows. Entering the track plan fits the whole sheet.
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

`db/schema.sql` (SQLite, `db/trackmap.db`, regenerated by the extraction):

| table | contents |
|---|---|
| `tracks` | calibrated tracks and their MP range |
| `track_pieces`, `track_legs` | geometry between consecutive milepost anchors, with an MP for every vertex |
| `route_anchors` | the milepost anchor points used for calibration |
| `milepost_labels` | every label read off the drawing, with its status |
| `stations` | station and yard names |
| `track_segments` | every piece of track: name, kind (running / crossover / yard / track), switches, milepost at each end, geometry |
| `locations` | stations, train control rooms (TCR), yards and platforms that a location can name |
| `access_requests` | the earlier, hand-drawn access requests (kept across rebuilds; superseded by TAWRs, still served by the API) |

`db/operations.sql` (SQLite, `db/operations.db`, never regenerated):

| table | contents |
|---|---|
| `users`, `sessions` | accounts (requester, manager, viewer) and signed-in sessions |
| `la_rows`, `la_cells` | the look-ahead: sections, activities (with their track plan `link`) and Resource rows; a colour and text per day |
| `meta` | the legend (shift colours), the support code register, the look-ahead's version |
| `tawrs` | the requests: week, place and shift, status, the form's fields as generated and as edited, what they were read from, who did what and when |
| `tawr_merges` | consolidations: which requests the manager made one |
| `tawr_settings`, `tawr_descriptions` | Setup: contacts, the requester's name, phone and signature, shift hours, lead time; expanded wording for activities |

### API

| | |
|---|---|
| `GET /api/tracks` | calibrated tracks |
| `GET /api/locate?track=W1&mp=23.5` | drawing position of a milepost |
| `GET /api/segment?track=W1&from=23&to=24` | polylines covering an MP range |
| `GET /api/me`, `POST /api/setup`, `/api/login`, `/api/logout`, `/api/users` | accounts |
| `GET /api/lookahead`, `POST /api/lookahead/ops`, `/api/lookahead/replace`, `PUT /api/lookahead/legend`, `/codes` | the look-ahead |
| `GET/POST /api/tawrs`, `PUT /api/tawrs/<id>`, `POST /api/tawrs/<id>/<action>`, `/api/tawrs/consolidate`, `/api/tawrs/<id>/split` | TAWRs and their workflow |
| `GET/PUT /api/tawr/settings`, `/api/tawr/template`, `/api/tawr/descriptions` | Setup |
| `GET/POST /api/requests`, `PUT/DELETE /api/requests/<id>` | the earlier access requests |

`server.py`'s docstring lists every route and who may call it.

## Layout

```
source/   the original PDF
pipeline/ extraction (pdfmap, labels, tracks, linref, build), glyph prototypes, fonts.conf, overrides
web/      the application: index.html, style.css, js/ (ES modules, no build step), data/map.json,
          data/tawr_workflow.json, map.svg, vendor/leaflet; tiles/ is generated
db/       schema.sql (the map), operations.sql (accounts, look-ahead, TAWRs); the .db files are generated
tests/    test_tawr.mjs (Node), test_server.py (Python), smoke.mjs (Playwright), fixtures/
docs/     qa_report.md
server.py, operations.py
```

`web/js`:

| module | |
|---|---|
| `main.js` | loads everything, switches between the three views |
| `lookahead.js` | the look-ahead's rows, cells and ops (undo), the legend and support codes, the workbook import |
| `links.js` | a track plan link: its label, Area, key, and whether two overlap |
| `tawr.js` | a week of the look-ahead read into TAWRs; conflicts; the form's values; the workflow table's rules |
| `sample.js` | four weeks of sample W and M line work, conflicts included |
| `tawr_sync.js` | drafts raised and kept in step with the look-ahead; consolidations |
| `store.js` | the server's API, or this browser's storage, behind one interface |
| `map.js` | the map, Select on track plan, TAWRs drawn on it |
| `lookahead_view.js`, `tawr_view.js` | the two planning views |
| `tawr_pdf.js`, `pdf_metrics.js`, `xlsx.js`, `la_read.js`, `inflate.js`, `zip.js` | BART's form filled; the workbook read; zip |

The four-week look-ahead, the TAWR rules and BART's form filler are rebuilt from
**cx-timeline** (its `core/la_edit.js`, `core/tawr.js`, `io/tawr_pdf.js`,
`io/lookahead.js`), with the track plan link in place of its location register.
The readers and the form filler are copied unchanged; each file says where it
came from.

## Tests

```bash
npm install                 # once: Playwright, for the browser test
npm test                    # all three suites
node tests/test_tawr.mjs    # look-ahead, links, TAWR reading, consolidation, workflow table, workbook import, the form filled (Node)
python3 -m unittest tests/test_server.py   # what the server allows and refuses (Python)
node tests/smoke.mjs        # the whole flow in Chromium, on the static site and against server.py
```

The browser test runs as though it were Friday 16 October 2026, so the week of
2 November is the one due. Any console error fails it. `.github/workflows/checks.yml`
runs all three on every push.

## Next steps

- Review `docs/qa_report.md` with someone who knows the territory and record
  the fixes in `overrides.json`.
- For many users, move to Postgres/PostGIS. The schema maps directly, and
  `geometry` becomes a `LINESTRING` with `ST_LineSubstring` for MP ranges.
- Extract interlocking limits (the `W45` dimension arrows) so requests can be
  made by interlocking as well as by MP.
