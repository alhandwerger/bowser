# Direct GeoTIFF upper-bound masks

The existing layer-mask menu offers both lower and upper thresholds. Previously,
direct-GeoTIFF (`cog`) tiles silently ignored `mode: "max"`; export and native
polygon statistics explicitly rejected it. The same upper threshold now
retains finite, mask-valid values **at or below** the threshold in tiles,
GeoTIFF exports and polygon summaries. Export/polygon provenance records `<=`.
This is a display/data-selection repair; it does not change stored rasters,
scientific algorithms, reference sampling, processing defaults or native units.

For example, a mask `{dataset: "quality", mode: "max", threshold: 0.5}` retains
0 and 0.5 and excludes 0.8. Negative thresholds work on signed layers as well;
no absolute value is implied. Multiple masks combine with AND. Intrinsic source
nodata and per-band masks remain invalid regardless of the comparison result.
Mask nodata, NaN and infinity do not become usable observations just because
they fall below a bound after filling. A valid zero measurement remains valid
when its mask sample passes.

Lower-bound behavior is preserved: direct-GeoTIFF layer `min` uses strict `>`,
while GeoZarr uses `>=`. Primary/custom mask operators retain their existing
definitions. Legacy two-item internal extra-mask tuples retain strict lower
bounds; explicit three-item tuples carry `min` or `max`.

Malformed direct-GeoTIFF layer-mask JSON, unknown/empty mask layers, unsupported
modes and nonfinite thresholds return HTTP 422 rather than silently dropping
the requested mask. If an extra mask has no coverage of a requested tile, all
data pixels in that tile are hidden. Other mask read failures propagate as
failed requests rather than returning apparently unmasked observations.

## Scope and limitations

This contribution covers direct-GeoTIFF **map tiles, export and native polygon
summaries**. It does not repair the existing point/radius chart mask handling,
temporal index clamping, map error feedback, or change GeoZarr alignment rules.
Those require separate audits. A configured static mask uses its single file;
dynamic tile/export masks still follow the existing configured index selection.
Polygon summaries retain stricter exact-grid and matching-axis requirements.
No acquisition/ministack mapping is inferred here.

Grid reprojection/resampling behavior is unchanged. Tiles may resample for
display, exports remain on the selected raster's grid, and polygon summaries
use native pixel centers. Exact equality in tests is established on an aligned
synthetic grid; it does not prove agreement for every mismatched input grid.

## Validation

A synthetic HTTP regression first reproduces the ignored upper-bound mask on
the unmodified implementation. The correction is checked through actual
numeric `.npy` tiles, GeoTIFF bytes/metadata and polygon JSON on the same grid.
Eight mask configurations exercise signed thresholds, exact equality, multiple
AND masks, static and date-varying layers, both acquisition indices and
common/per-date polygon support. Separate tests cover source and mask nodata,
NaN/infinity, integer/float and multiband data, legitimate zeros, missing tile
coverage, unreadable masks and legacy extra-mask entries. No real datasets are needed.
