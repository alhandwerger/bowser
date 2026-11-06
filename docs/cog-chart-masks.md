# GeoTIFF point and radius charts with layer masks

Direct-GeoTIFF (`cog`) point and radius charts previously accepted
`layer_masks` but ignored them. A positive `ref_buffer_m` also silently used a
single reference pixel. The full server now honors those existing requests.
Synthetic API tests reproduce both failures before the repair.

## Selected layer support

Mask-aware `/multi_point` charts and `/buffer_timeseries` use native band-one
values, excluding intrinsic masks/nodata and nonfinite samples. A configured
nodata override is an additional exclusion, including when its value is zero;
otherwise legitimate zero measurements remain valid. Layer masks combine with
AND, using the established direct-GeoTIFF operators:

- `min`: keep finite, mask-valid values **strictly greater than** the threshold.
- `max`: keep finite, mask-valid values **at or below** the threshold.

Thresholds are in native mask units. There is no absolute-value operation,
filtering, time-series inversion, rebaselining or new velocity fit. Labels and
units stay in the supplied data's reference frame. The existing median,
deterministic sample selection and chart response formats are retained.

A single mask file is explicitly static and reused. Dynamic mask file counts
and configured labels/order must match the data stack exactly; indices are not
independently clamped onto an unrelated date list. These are configured labels,
not independent verification of acquisition dates. All read data/mask slices
must share the same native CRS, affine transform and dimensions. Shifted grids,
different CRSs, unknown layers and incompatible dates fail rather than being
silently resampled or ignored. Masks must be real, scalar single-band rasters.

Point sampling uses the containing native pixel. A single-date request reads
only that date's one-pixel data/mask windows. Radius selection uses native pixel
centers inside a circle, including on reversed/rotated affine grids. Radius
units must be meters on a projected metric CRS; geographic degrees or feet are
not silently interpreted as meters. Outside/no-center selections return 404;
invalid configuration, unreadable files and unsupported radii/units return 422.

Only a bounding raster window is read, one data slice at a time. The existing
native-analysis limits are reused: two million window pixels and fifty million
window-pixel-epochs, including mask work, checked before sampling values.
This does not guarantee byte-level subsetting of compressed raster blocks.

## Reference requests

Zero reference radius retains the existing point reference. A positive radius
now uses the requested circular median, in meters, instead of silently falling
back to one pixel. Requested layer masks also apply to the legacy chart's
reference samples. An unsupported reference date remains missing; no measured
zero or substitute point is invented. Exports and native polygon summaries
retain their separate raw-source-before-display-mask reference policy.

Unmasked point requests retain their existing reader path. Radius reads now
honor intrinsic GDAL validity masks as well as nodata. Buffers count the union
of supported sample locations over time, as before; this is not a guarantee of
common temporal support or shared unwrapping components.

## Scope and validation

This repairs the existing **layer-mask** chart parameters. It does not add
primary/custom-mask fields to chart requests, change GeoZarr/lite behavior,
alter map/export algorithms, or establish physical reference stability.
Primary/custom-mask chart parity and graphical error feedback remain separate
work. Real-valued band-one samples are used; no complex or circular-statistics
conversion is invented.

Synthetic HTTP tests compare point/radius histories with known values and
actual masked GeoTIFF exports. Unit checks cover dynamic/static masks, zero
measurements, GDAL masks and nodata overrides, nonfinite values, mismatched
grids/dates, single-date read windows, circular geometry, projected-meter
requirements and read budgets. The complete regression suite also retains
the existing map/export and full/lite checks. No research data, installed
packages, processing defaults or production viewers are modified. Manual
graphical-browser, real-data and Linux acceptance remain separate.
