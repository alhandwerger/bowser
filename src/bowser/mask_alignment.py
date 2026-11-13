"""Validate native mask alignment and signed/absolute display thresholds."""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import xarray as xr

MASK_MODES = ("min", "max", "abs_min", "abs_max")


def validate_mask_threshold(mode: str, threshold: float) -> None:
    """Require known modes and finite, nonnegative absolute thresholds."""
    if mode not in MASK_MODES or not np.isfinite(threshold):
        raise ValueError(
            "Masks require a finite threshold and min/max/abs_min/abs_max mode"
        )
    if mode.startswith("abs_") and threshold < 0:
        raise ValueError("Absolute mask thresholds must be nonnegative")


def mask_operator(mode: str, *, inclusive_min: bool = True) -> str:
    """Describe comparisons without changing legacy COG strict-min semantics."""
    if mode not in MASK_MODES:
        raise ValueError("Unknown mask mode")
    return {
        "min": ">=" if inclusive_min else ">",
        "max": "<=",
        "abs_min": "|value| >=",
        "abs_max": "|value| <=",
    }[mode]


def _comparison(values: Any, threshold: float, operator: str) -> Any:
    if not np.isfinite(threshold):
        raise ValueError("Mask thresholds must be finite")
    if operator.startswith("|value|"):
        if threshold < 0:
            raise ValueError("Absolute mask thresholds must be nonnegative")
        # Promote before abs: signed integer minima otherwise wrap around.
        values = np.abs(values.astype("float64"))
        operator = operator.removeprefix("|value| ")
    if operator == ">":
        return values > threshold
    if operator == ">=":
        return values >= threshold
    if operator == "<=":
        return values <= threshold
    raise ValueError("Unsupported mask comparison")


def numpy_mask_condition(
    values: np.ndarray, threshold: float, operator: str
) -> np.ndarray:
    """Compare native numeric masks without reviving masked/nonfinite samples."""
    raw = np.ma.getdata(values)
    valid = ~np.ma.getmaskarray(values) & np.isfinite(raw)
    return valid & _comparison(raw, threshold, operator)


def parse_layer_masks(raw: str | list | None) -> list[dict[str, Any]]:
    """Validate explicit layer names, native thresholds and comparison modes."""
    if raw is None:
        return []
    masks = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(masks, list):
        raise ValueError("layer_masks must be a JSON list")
    result = []
    for mask in masks:
        if not isinstance(mask, dict):
            raise ValueError("Each layer mask must be an object")
        name = mask.get("dataset")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("Each layer mask requires a dataset name")
        try:
            threshold = float(mask.get("threshold", 0.5))
        except (TypeError, ValueError) as exc:
            raise ValueError("Mask thresholds must be finite numbers") from exc
        mode = mask.get("mode", "min")
        validate_mask_threshold(mode, threshold)
        result.append({"dataset": name, "threshold": threshold, "mode": mode})
    return result


def _axis(array: xr.DataArray) -> str | None:
    other = [dim for dim in array.dims if dim not in ("x", "y")]
    if len(other) > 1:
        raise ValueError("Masked layers require at most one non-spatial axis")
    return str(other[0]) if other else None


def align_mask(data: xr.DataArray, mask: xr.DataArray) -> xr.DataArray:
    """Require shared spatial coordinates and an explicit matching dynamic axis.

    Validate complete arrays before selecting a date or spatial window. A 2-D
    mask broadcasts over the data record. A dynamic mask requires the same
    non-spatial dimension and coordinates; unrelated axes are not mapped.
    Raster values remain lazy and input arrays are never modified.
    """
    if mask.dtype.kind not in "biuf":
        raise ValueError("Masks must contain real numeric or Boolean values")
    for dim in ("x", "y"):
        if any(
            dim not in array.dims or dim not in array.coords for array in (data, mask)
        ):
            raise ValueError("Masks require explicit x/y coordinates")
        if any(
            array[dim].dims != (dim,) for array in (data, mask)
        ) or not np.array_equal(data[dim].values, mask[dim].values):
            raise ValueError(
                "Mask spatial coordinates must match the selected grid exactly"
            )
    axis, mask_axis = _axis(data), _axis(mask)
    if mask_axis is not None and (
        axis is None
        or mask_axis != axis
        or axis not in data.coords
        or mask_axis not in mask.coords
        or not np.array_equal(data[axis].values, mask[mask_axis].values)
    ):
        raise ValueError(
            "Dynamic mask axis and coordinates must match the selected layer "
            "exactly; use a static summary for a static layer"
        )
    return mask


def mask_condition(mask: xr.DataArray, threshold: float, operator: str) -> xr.DataArray:
    """Compare finite, non-nodata mask values in native units, preserving zeros."""
    valid = np.isfinite(mask)
    for key in ("_FillValue", "missing_value", "fill_value", "nodata"):
        if key in mask.attrs and mask.attrs[key] is not None:
            for value in np.atleast_1d(mask.attrs[key]):
                valid = valid & (mask != value)
    return valid & _comparison(mask, threshold, operator)
