# Native polygon statistics API

The full server provides `POST /polygon_timeseries` for read-only summaries of
stored GeoZarr or single-band GeoTIFF values inside one WGS84 GeoJSON Polygon
or MultiPolygon. The polygon chart controls use this endpoint with the existing
drawing and importing tools; they do not replace those tools.

## Plot an imported or drawn polygon

1. In **Overlays**, import a geographic file or finish a polygon using **Draw**.
   Points and lines do not appear in the polygon selector.
2. In **Overlays > Layers > Polygon summary**, choose a polygon and pixel
   selection policy, then select **Plot polygon**. No raster work starts merely
   by importing a file. Hidden polygon overlays are available and labeled hidden.
3. The chart shows median, mean (initially hidden), and 10th/90th percentiles
   for the active scalar raster layer's **full stored record**. Click legend
   entries to change visible curves. A static velocity layer gets a spatial
   summary, not a newly fitted displacement history.

**Same pixels at all dates** is the default and keeps a common source/quality
footprint. **Available pixels per date** retains each date's usable pixels;
changes in membership can change the apparent history. Counts and backend
warnings identify limited or empty support. A missing reference epoch can have
zero usable measurements even when common spatial support exists. P10–P90 is
spatial spread, not a confidence interval or an uncertainty estimate. Component
compatibility and reference stability are not established by this chart.

An open chart follows the selected polygon's geometry, active layer, supported
spatial reference, and masks. Reference buffer requests use the selected radius
in meters; the server rejects unsupported grids or units. Direct GeoTIFF mode
forwards its configured primary mask over the full record; explicit layer and
custom masks are forwarded in both storage modes. GeoZarr uses the selected
layer-mask controls rather than guessing a primary mask variable. Exact
grid/axis checks below still apply; no ministack/date mapping is inferred.
Displayed per-date maps and common-support curves can therefore have different
footprints. Source reference pixels are sampled before optional display masks.

Changing the map date, color scale, opacity or display units does not refetch
the record. The chart does not impose the map's date-range filter, a new temporal
zero, interpolation, or a new velocity fit. Null dates remain gaps. Non-date
source labels are categorical. Metric/imperial display uses the viewer's
existing unit helper; CSV and JSON retain native source units.

Chart windows can be moved and resized. Their controls and legends do not add
map points. Closing cancels pending requests. Changed requests clear old curves
immediately, debounce updates, and ignore late obsolete responses even when
transport cancellation fails. Unsupported data, masks or references show an
error, without silently reverting to unmasked or stored-reference values.
**Refresh polygon chart** explicitly repeats the current request.

**CSV (native units)** saves labels, layer, units, counts, mean, median and
percentiles. Missing values remain blank and zeros stay zero. **Values and
details (JSON)** retains the full server result, polygon, support, reference
offsets/coordinates, masks, warnings and catalog identity. A custom mask is
identified by basename rather than its server directory; relink that file
manually before replaying an API request. Text cells are escaped for CSV use.

KML/GeoJSON altitude coordinates are omitted from the 2D selection request;
the imported feature, holes and polygon parts remain unchanged. Unique feature
IDs retain selection through edits/reordering. Anonymous or duplicate-ID
features use object identity, never array position; replacing such a feature
may require selecting it again. A deleted selection never switches silently to
another polygon. This adds no new import format or multi-region batch API.

## API example

```python
import requests

response = requests.post(
    "http://localhost:8000/polygon_timeseries",
    # Add params={"dataset": "catalog-id"} for a catalog entry.
    json={
        "variable": "displacement",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[10.01, 45.01], [10.07, 45.01],
                             [10.07, 45.07], [10.01, 45.07], [10.01, 45.01]]],
        },
        "support": "common",
        "percentiles": [10, 90],
    },
)
response.raise_for_status()
result = response.json()
print(result["labels"], [row["median"] for row in result["statistics"]])
```

## Selection and calculations

- Pixel centers on the native level-zero grid are selected using rasterio's
  standard `all_touched=False` polygon rasterization. Holes are excluded and
  separate polygon parts are retained. No pyramid, interpolation, filtering,
  unwrapping, time-series inversion, motion projection or new velocity fit is
  used. A static velocity layer receives a spatial summary of its saved values.
- `common` is the default: every epoch summarizes the same pixels that are
  source-valid throughout the selected layer's entire record. `per_date`
  summarizes each date's source-valid pixels and explicitly warns that changing
  membership can change the apparent history.
- Each row contains count, unweighted mean, median, population spatial standard
  deviation, minimum, maximum and requested linear percentiles. Calculations
  use Float64. Canonical percentile keys are `"10"`, `"90"`, or, for example,
  `"2.5"`, consistently for default and explicit requests.
- Intrinsic nodata, nonfinite values and explicit undecoded missing-value
  sentinels are excluded. Valid zeros remain measurements. Empty support yields
  count zero and JSON `null` statistics, with a warning. It never creates a
  measured zero or interpolates across an unsupported date.
- Source units and labels are retained. Unknown units remain unknown. Known
  angular fields and complex values are rejected because linear summaries
  would not provide circular statistics or an explicit complex conversion.

The result reports `polygon_pixels`, `valid_per_date` (before a common-support
intersection), `common_pixels`, per-row counts, geometry, grid, labels, units,
and scientific limitations. Source directory paths are not included; mask
provenance may identify basenames. No implicit temporal zero datum is added.

## Explicit masks and references

The default still summarizes stored values with intrinsic nodata only. Options
are applied only when sent in the request, and reported in `masks`,
`optional_masks_applied`, `reference`, and `reference_details`.

- `layer_masks`: a list of `{dataset, threshold, mode}` objects. Thresholds are
  in the mask layer's native units. `min` retains values at/above the threshold
  in GeoZarr and strictly above it in direct GeoTIFF mode, preserving existing
  viewer/export comparisons. GeoZarr `max` retains values at/below the threshold;
  direct-GeoTIFF `max` remains unsupported and returns 422.
- `primary_mask: true`: explicitly use the primary mask. GeoZarr additionally
  requires `mask_variable`; its default threshold is 0.1 and comparison is `>`.
  Direct GeoTIFF uses the configured primary-mask files, threshold and `>=`.
  `mask_min_value` overrides that threshold. Primary options without the
  explicit flag are rejected, so an ignored setting cannot look applied.
- `custom_mask_path`: use an existing uploaded single-band raster, on the exact
  source grid, retaining `> 0` for GeoZarr or `> 0.5` for direct GeoTIFF.
- `ref_lon`, `ref_lat`: request a point reference in WGS84 decimal degrees.
  `ref_buffer_m` optionally requests a circular source median in meters. Buffer
  references require a projected CRS in meters. A layer must explicitly support
  interactive referencing under the same rules as GeoTIFF export.

References use the same source sampling helper as reference-aware export:
nearest coordinate for GeoZarr, containing pixel for direct GeoTIFF, or a
circular source median. Samples use valid source pixels before optional display
masks. Each source slice is shifted once in its native units, before its
polygon statistics are calculated. There is no unit conversion, new temporal
zero, or change to projection/processing order. Stored downslope fields, for
example, are shifted in their stored units; this does not re-reference LOS and
then recompute a downslope projection.

`reference_details` identifies the requested WGS84 coordinates, method, radius,
per-epoch offsets and valid reference counts. A legitimate zero reference
remains valid. If an otherwise valid reference location has no source support
at one epoch, that epoch has null relative statistics and count zero. Its
absence does not remove otherwise common polygon pixels from all other epochs.
`valid_per_date` and `common_pixels` describe source/quality support, while
per-row counts also reflect reference availability. Invalid coordinates,
outside-grid positions and unsupported settings return 422; there is no
silent fallback to stored values.

All masks must share the exact native data grid/CRS. No silent resampling is
introduced. Dynamic GeoZarr masks must have the same axis length and coordinate
values as the selected layer. Dynamic direct-GeoTIFF layer masks must have
matching configured labels; a single mask file is explicitly treated as static.
Configured primary GeoTIFF mask lists follow the group's supplied slice order;
this does not independently infer acquisition dates from filenames. Mismatched
or ambiguous axes/grids are rejected instead of clamping a mask index or
inventing a ministack-to-date mapping.

Connected-component screening remains unimplemented and explicitly reported
as unverified. Component IDs are not assumed comparable across dates or pairs.
A selected reference is not proof of stable ground or component compatibility;
spatial spread is not measurement uncertainty. Unknown request fields remain
errors. The chart forwards only explicitly selected adjustments.

The full server supports explicit, regular rectilinear GeoZarr x/y coordinate
grids and at most one non-spatial axis. Single-band GeoTIFF groups must share the exact grid, CRS and
identical units, including whether units are missing. Rotated GeoTIFF grids
can use the raster's affine for stored-value summaries; interactive references
require rectilinear grids in either storage mode. Rotated GeoZarr grids are
rejected. Polygons
outside the grid or containing no native pixel centers return 422. Partial
coverage is summarized only on-grid and explicitly warned. Invalid topology,
unclosed rings and antimeridian-spanning polygons are rejected.

To bound memory and work, requests allow at most 10,000 vertices, a bounding
window of 2,000,000 native pixels, and 50,000,000 bounding-window pixel-epochs.
These budgets include requested mask work and are checked before reading raster
values or sampling references. Reference patches have their own bounded
pixel-epoch check. Two spatially bounded passes determine common support and then exact summaries, retaining one frame
at a time. Percentiles use all eligible pixels rather than a sampled preview.
The budget covers each pass; two passes can read the same source window twice.

GeoTIFF reads use a raster window. Lazy GeoZarr reads evaluate only intersecting
native chunks, though compressed chunk/block transfers can be larger than the
polygon window. No claim of arbitrary byte-level subsetting is made.

Bowser-lite explicitly returns 501 and does not import the full-server
geometry/raster stack. No package pins or installed environments change:
Shapely is already required by the full server's existing `opera-utils`
dependency. This module uses it to validate topology rather than repairing or
simplifying a user's geometry.

## Validation

Synthetic tests cover known summaries and support, stationary zero values,
nodata and missing-value sentinels, holes, multiple polygon parts, reversed and
transposed axes, clipping, absent data, mixed units/grids, unsupported fields,
lazy GeoZarr chunk reads, windowed GeoTIFF reads, catalog isolation, actual
HTTP responses and lite dependency isolation. They require no real data.

Frontend tests cover imported/drawn selection (including altitude and holes),
reference/mask/support updates, invalid/deleted selections, zeros and nulls,
catalog routing, cancellation and stale responses, legend state, portal event
isolation, and native-unit CSV/JSON exports. Component tests use jsdom with the
Chart.js canvas renderer mocked; they do not establish graphical rendering or
real map-engine acceptance in a browser. Real-data and browser acceptance
remain separate from synthetic API/DOM regression results.
