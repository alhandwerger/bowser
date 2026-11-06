"""Apply explicitly aligned masks and source references to polygon summaries."""

from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
from typing import Any, Callable

import numpy as np
import rasterio
import rioxarray
from pyproj import CRS, Transformer

from . import polygon
from .export import NoValidReferenceError, reference_offset
from .polygon import NativeGrid, PolygonRequest, _linear, _values


def _axis(source: Any) -> str | None:
    extra = [dim for dim in source.dims if dim not in ("x", "y")]
    if len(extra) > 1:
        raise ValueError("Mask supports at most one non-spatial axis")
    return extra[0] if extra else None


class PolygonSupport:
    """Prepare masks and references without changing stored data or defaults."""

    def __init__(
        self,
        target: Any,
        request: PolygonRequest,
        labels: list[str],
        *,
        reference_allowed: bool,
    ) -> None:
        """Validate explicit options and prepare bounded per-request readers."""
        self.target = target
        self.request = request
        self.labels = labels
        self.masks: list[tuple[Callable, str, float]] = []
        self.records: list[dict] = []
        self.offsets: list[float] | None = None
        self.reference_details: dict = {"applied": False}
        if request.ref_lon is not None and not reference_allowed:
            raise ValueError("This layer does not use an interactive spatial reference")

        if request.primary_mask:
            if target.mode == "md":
                if not request.mask_variable:
                    raise ValueError("A GeoZarr primary mask requires mask_variable")
                self._add_md(
                    request.mask_variable, ">", self._threshold(0.1), "primary"
                )
            else:
                if request.mask_variable:
                    raise ValueError("mask_variable is only supported for GeoZarr")
                group = target.raster_groups[request.variable]
                if not group.mask_file_list or any(not p for p in group.mask_file_list):
                    raise ValueError("No complete primary mask is configured")
                self._add_rasters(
                    group.mask_file_list,
                    ">=",
                    self._threshold(group.mask_min_value),
                    "primary",
                )
        for mask in request.layer_masks:
            if target.mode == "md":
                self._add_md(
                    mask.dataset,
                    ">=" if mask.mode == "min" else "<=",
                    mask.threshold,
                    "layer",
                )
            else:
                groups = target.raster_groups
                if mask.dataset not in groups:
                    raise ValueError(f"Unknown mask layer: {mask.dataset}")
                group = groups[mask.dataset]
                if (
                    len(group.file_list) > 1
                    and list(map(str, group.x_values)) != labels
                ):
                    raise ValueError(
                        "Dynamic mask labels must match the selected layer exactly"
                    )
                self._add_rasters(
                    group.file_list,
                    ">" if mask.mode == "min" else "<=",
                    mask.threshold,
                    "layer",
                    mask.dataset,
                )
        if request.custom_mask_path:
            self._add_rasters(
                [request.custom_mask_path],
                ">",
                0 if target.mode == "md" else 0.5,
                "custom",
            )

    def _threshold(self, default: float) -> float:
        value = (
            default
            if self.request.mask_min_value is None
            else self.request.mask_min_value
        )
        if not np.isfinite(value):
            raise ValueError("Primary mask threshold must be finite")
        return value

    def _add_md(self, name: str, operator: str, threshold: float, kind: str) -> None:
        ds = self.target.dataset
        if name not in ds.data_vars:
            raise ValueError(f"Unknown mask layer: {name}")
        mask = ds[name]
        data = ds[self.request.variable]
        dim, data_dim = _axis(mask), _axis(data)
        if not {"x", "y"}.issubset(mask.coords):
            raise ValueError("Mask requires explicit x/y pixel-center coordinates")
        _linear(mask.dtype, None)
        if dim is not None and (
            data_dim is None
            or mask.sizes[dim] != len(self.labels)
            or not np.array_equal(mask[dim].values, data[data_dim].values)
        ):
            raise ValueError(
                "Dynamic mask coordinates must match the selected layer exactly"
            )
        record = {
            "kind": kind,
            "layer": name,
            "operator": operator,
            "threshold": threshold,
            "temporal_support": "static" if dim is None else "matching_axis",
        }

        def load(index, window, grid):
            actual = NativeGrid(
                mask.rio.crs,
                mask.rio.transform(recalc=True),
                mask.sizes["x"],
                mask.sizes["y"],
            )
            if actual != grid:
                raise ValueError("Masks must share the exact native data grid and CRS")
            frame = mask.isel({dim: index}) if dim else mask
            frame = frame.isel(
                y=slice(int(window.row_off), int(window.row_off + window.height)),
                x=slice(int(window.col_off), int(window.col_off + window.width)),
            )
            return _values(frame.transpose("y", "x").values, mask.attrs)

        self.masks.append((load, operator, threshold))
        self.records.append(record)

    def _add_rasters(
        self,
        paths: list,
        operator: str,
        threshold: float,
        kind: str,
        name: str | None = None,
    ) -> None:
        if len(paths) not in (1, len(self.labels)):
            raise ValueError("Masks must be static or have one file per data slice")
        record = {
            "kind": kind,
            "operator": operator,
            "threshold": threshold,
            "temporal_support": "static" if len(paths) == 1 else "configured_axis",
        }
        if name:
            record["layer"] = name
        else:
            record["files"] = [Path(path).name for path in paths]

        def load(index, window, grid):
            with rasterio.open(paths[0 if len(paths) == 1 else index]) as source:
                actual = NativeGrid(
                    source.crs, source.transform, source.width, source.height
                )
                if actual != grid:
                    raise ValueError(
                        "Masks must share the exact native data grid and CRS"
                    )
                if source.count != 1:
                    raise ValueError("Masks must be single-band scalar rasters")
                _linear(source.dtypes[0], None)
                values = _values(source.read(1, window=window, masked=True))
                # Match configured COG map masks even if the threshold is zero.
                return (
                    np.where(values == 0, np.nan, values)
                    if kind == "primary"
                    else values
                )

        self.masks.append((load, operator, threshold))
        self.records.append(record)

    def apply(
        self, index: int, window: Any, grid: NativeGrid, values: np.ndarray
    ) -> np.ndarray:
        """Apply the established mode-specific comparisons on a native window."""
        keep = np.isfinite(values)
        for load, operator, threshold in self.masks:
            mask = load(index, window, grid)
            comparison = {">": np.greater, ">=": np.greater_equal, "<=": np.less_equal}[
                operator
            ]
            keep &= np.isfinite(mask) & comparison(mask, threshold)
        return np.where(keep, values, np.nan)

    def sample_references(self) -> list[float]:
        """Sample once after the polygon's native read budget has been checked."""
        if self.request.ref_lon is None:
            raise ValueError("Reference coordinates are required")
        if self.offsets is None:
            self._references()
        assert self.offsets is not None
        return self.offsets

    def _references(self) -> None:
        offsets, counts = [], []
        method = None
        for index in range(len(self.labels)):
            if self.target.mode == "md":
                source = self.target.dataset[self.request.variable]
                dim = _axis(source)
                frame = source.isel({dim: index}) if dim else source
                context = nullcontext(frame)
            else:
                group = self.target.raster_groups[self.request.variable]
                context = rioxarray.open_rasterio(group.file_list[index], masked=True)
            with context as source:
                if "band" in source.dims:
                    source = source.squeeze("band", drop=True)
                self._reference_budget(source)
                try:
                    offset, tags = reference_offset(
                        source,
                        self.request.ref_lon,
                        self.request.ref_lat,
                        self.request.ref_buffer_m,
                        point_method="nearest"
                        if self.target.mode == "md"
                        else "containing",
                    )
                    counts.append(int(tags["BOWSER_REFERENCE_VALID_PIXELS"]))
                    method = tags["BOWSER_REFERENCE_METHOD"]
                except NoValidReferenceError:
                    offset = np.nan
                    counts.append(0)
                offsets.append(offset)
        self.offsets = offsets
        self.reference_details = {
            "applied": True,
            "longitude": self.request.ref_lon,
            "latitude": self.request.ref_lat,
            "coordinate_crs": "EPSG:4326",
            "buffer_meters": self.request.ref_buffer_m,
            "method": method,
            "offsets": [float(v) if np.isfinite(v) else None for v in offsets],
            "valid_pixels_per_date": counts,
            "valid_per_date": np.isfinite(offsets).tolist(),
            "support": "valid source pixels before optional display masks",
            "operation": "summary values = stored values - per-epoch reference offset",
        }

    def _reference_budget(self, source: Any) -> None:
        transform = source.rio.transform()
        if transform.b or transform.d:
            raise ValueError(
                "Interactive polygon references require a rectilinear grid"
            )
        if not self.request.ref_buffer_m:
            return
        crs = CRS.from_user_input(source.rio.crs)
        if not crs.is_projected or any(
            axis.unit_conversion_factor != 1 for axis in crs.axis_info[:2]
        ):
            raise ValueError(
                "Median reference buffers require a projected CRS in meters"
            )
        x, y = Transformer.from_crs(4326, crs, always_xy=True).transform(
            self.request.ref_lon, self.request.ref_lat
        )
        radius = self.request.ref_buffer_m
        pixels = int(np.count_nonzero(abs(source.x.values - x) <= radius)) * int(
            np.count_nonzero(abs(source.y.values - y) <= radius)
        )
        if (
            pixels > polygon.MAX_WINDOW_PIXELS
            or pixels * len(self.labels) > polygon.MAX_PIXEL_EPOCHS
        ):
            raise ValueError("Reference exceeds the bounded native pixel-epoch budget")

    def finish(self, result: dict) -> dict:
        """Attach applied options without claiming component connectivity."""
        result["reference"] = "interactive" if self.offsets is not None else "stored"
        result["reference_details"] = self.reference_details
        result["optional_masks_applied"] = bool(self.masks)
        result["masks"] = self.records
        if self.offsets is not None or self.masks:
            result["warnings"][0] = (
                "Explicit masks applied; reference is " + result["reference"]
                if self.masks
                else "Interactive reference applied; no optional masks applied."
            )
        if self.offsets is not None and not np.isfinite(self.offsets).all():
            result["warnings"].append(
                "Reference has no source support at some epochs; "
                "those epochs have null relative statistics."
            )
        return result
