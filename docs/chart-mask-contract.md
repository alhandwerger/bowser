# Point and radius chart masks

In the full server, `/multi_point` and `/buffer_timeseries` accept these optional
JSON fields in addition to existing `layer_masks`:

```json
{
  "primary_mask": true,
  "mask_min_value": 0.5,
  "custom_mask_path": "/tmp/uploaded-mask.tif"
}
```

`primary_mask` explicitly requests a configured GeoTIFF `mask_file_list`.
`mask_min_value` overrides that group's threshold and requires
`primary_mask: true`; otherwise the configured threshold applies. Primary masks
keep finite nonzero values `>= threshold`, matching the configured map mask's
zero-is-invalid rule even when a threshold of zero is requested. Native polygon
summaries and exports now honor that rule too. Uploaded masks keep finite values `> 0.5`
for GeoTIFF data or `> 0` for GeoZarr, matching the existing mode-specific
conventions. Layer-mask operators are unchanged. All requested masks combine
with AND and intrinsic source validity. A valid zero **measurement** remains
valid; zero in an uploaded binary **mask** excludes that location.

Uploaded masks must be single-band, real-valued rasters on the exact native
source grid and CRS. Configured primary masks must be complete, either static
or one file per source slice. Dynamic layer-mask labels must match exactly.
Unknown, missing, unreadable, multiband or misaligned masks fail explicitly;
charts do not silently resample, guess date associations or drop requested masks.
Reads are limited to the selected native point/window and existing sampling
budgets. Source rasters are not changed.

The interface sends configured/uploaded masks for each selected chart layer,
not merely the currently displayed map layer. It refreshes point, radius and
reference-preview charts when masks change, suppresses outdated requests, and
clears failed results. Reference-preview samples are aligned by their API date
labels so masked dates remain gaps. GNSS comparison requests and polygon
requests use the same mask-option builder.

Charts retain their established policy of sampling references using requested
chart masks, including buffered medians. Export/polygon reference offsets
retain their separate raw-source-before-optional-display-mask policy. This
change does not redefine either policy or alter stored displacements, velocity
fits, scientific processing defaults or connected-component acceptance.

The lightweight server does not support external GeoTIFF masks. Its chart
endpoints now return HTTP 501 for these options rather than silently ignoring
them. Use GeoZarr `layer_masks` with lite, or use the full server for uploads.
GeoZarr configured-primary options are rejected by the full chart endpoints;
the interface uses layer masks for that mode. Legacy `/chart_point` and
`/trend_analysis` query APIs are not extended here; the interactive chart uses
the POST APIs above. General cross-grid mask reprojection is outside this repair.

Tests cover known native samples, valid zeros, all-masked points, reference
medians, combined masks, native polygon agreement, bounded reads, invalid inputs
and React request lifecycles. Numerical tolerances and scientific defaults are
unchanged. Automated browser acceptance uses synthetic data only.
