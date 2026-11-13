# Configured and uploaded point/radius chart masks

The full server's `POST /multi_point` and `POST /buffer_timeseries` accept:

- `primary_mask: true`: apply the selected GeoTIFF group's configured mask;
- `mask_min_value`: a finite override, only with `primary_mask: true`;
- `custom_mask_path`: an uploaded, native-grid, single-band GeoTIFF mask.

The data-chart client forwards the configured mask and threshold per layer,
and an active uploaded mask. Zero thresholds are retained. Mask changes clear
old curves and refresh point/radius requests. Failed/unsupported requests clear
old data and show a message. Existing request revisions prevent old replies
from restoring earlier settings. Reference previews/values do not silently
inherit these additional display masks.

## Validity and references

Configured GeoTIFF masks keep finite, nonzero values `>=` their threshold,
matching the existing map rule, including at a zero threshold. Native exports
now also reject configured-mask zero at that threshold. This is separate from
valid zero **displacement**, which remains a measurement.

Uploaded masks preserve existing conventions: GeoTIFF keeps values `> 0.5`,
full GeoZarr keeps `> 0`. Normal binary masks agree. Nodata, intrinsic validity
and nonfinite mask samples are excluded. All active masks combine with source
validity and named quality masks. A single configured mask is reused for every
GeoTIFF date on both maps and charts. Incomplete configured lists are rejected
by charts rather than guessing associations.

Additional display masks do not redefine the reference datum. The existing
GeoTIFF stored-before-mask policy and existing GeoZarr named-mask reference
behavior are retained; uploaded/configured display masks are not silently
applied to the reference. No scientific parameters, estimates or inputs change.

## Bounds and limitations

Mask windows are read only for the native point or selected buffer window.
Source and mask must have exactly matching CRS, shape and affine grid;
misaligned, missing or multiband masks fail explicitly. GeoZarr uploaded masks
require explicit regular rectilinear coordinates (the existing native-grid
validation precision) and existing buffer-window geometry. There is no new
resampling, geocoding or temporal mapping. Cross-grid masks that render on a
map may require native alignment before charts can accept them.

The lightweight server explicitly returns 501 for these external/configured
options, while keeping its supported named GeoZarr masks. Polygon statistics
still reject uploaded/configured masks; this does not extend that API. Legacy
GET chart/trend routes, GNSS analysis and reference-preview enhancements remain
separate. Arbitrary GeoZarr temporal axes and general geographic-CRS metric
buffers are not validated by this extension.

Synthetic tests cover native support, zeros, signed/primary/upload combinations,
reference invariance, read windows/budgets, unsupported modes and invalid masks.
Actual browser tests upload an all-zero GeoTIFF, check empty point/radius data,
then clear it and verify restoration. No stored raster or processing default is
modified. This is viewer validity/compatibility work, not scientific validation
of the underlying displacement measurements.
