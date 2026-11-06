"""Test explicit polygon adjustments independently of their HTTP adapter."""

from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
import rioxarray  # noqa: F401
import xarray as xr
from pyproj import Transformer

from bowser import polygon
from bowser.polygon import PolygonRequest, summarize_rasters, summarize_xarray
from bowser.polygon_support import PolygonSupport


def make_inputs(tmp_path):
    dates = np.array(["2026-01-01", "2026-01-13", "2026-01-25"], dtype="datetime64[ns]")
    field = np.arange(25, dtype="float32").reshape(5, 5)
    field[0, 0] = np.nan
    values = np.stack([field * i for i in range(3)])
    quality = np.ones((3, 5, 5), dtype="float32")
    quality[:, 1, 1] = 0.5
    quality[:, 2, 2] = 0
    quality[:, 4, 4] = 0  # mask the reference; reference sampling must use raw support
    quality[2, 3, 3] = 0
    ds = xr.Dataset(
        {
            "displacement": (("time", "y", "x"), values, {"units": "meters"}),
            "quality": (("time", "y", "x"), quality, {"units": "1"}),
            "static_quality": (("y", "x"), quality[0], {"units": "1"}),
        },
        coords={
            "time": dates,
            "x": 500005 + 10 * np.arange(5),
            "y": 45 - 10 * np.arange(5),
        },
    ).rio.write_crs(32631)
    groups = {}
    labels = ["2026-01-01", "2026-01-13", "2026-01-25"]
    for name in ds.data_vars:
        paths = []
        for i in range(1 if name == "static_quality" else 3):
            da = ds[name] if name == "static_quality" else ds[name].isel(time=i)
            path = tmp_path / f"{name}_{i}.tif"
            da.rio.write_nodata(np.nan).rio.to_raster(path)
            paths.append(str(path))
        groups[name] = SimpleNamespace(
            file_list=paths,
            x_values=labels if len(paths) > 1 else [0],
            nodata=None,
            mask_file_list=[],
            mask_min_value=0.5,
        )
    groups["displacement"].mask_file_list = groups["quality"].file_list
    to_geo = Transformer.from_crs(32631, 4326, always_xy=True)
    ring = [
        list(to_geo.transform(x, y))
        for x, y in [
            (500010, 10),
            (500040, 10),
            (500040, 40),
            (500010, 40),
            (500010, 10),
        ]
    ]
    lon, lat = to_geo.transform(500045, 5)
    body = {
        "variable": "displacement",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }
    return ds, groups, body, {"ref_lon": lon, "ref_lat": lat}


@pytest.fixture
def inputs(tmp_path):
    return make_inputs(tmp_path)


def run(inputs, mode, **options):
    ds, groups, body, _ = inputs
    request = PolygonRequest.model_validate({**body, **options})
    labels = list(groups["displacement"].x_values)
    target = SimpleNamespace(mode=mode, dataset=ds, raster_groups=groups)
    support = PolygonSupport(target, request, labels, reference_allowed=True)
    keywords = {
        "adjust": support.apply if support.masks else None,
        "reference": support.sample_references if request.ref_lon is not None else None,
    }
    result = (
        summarize_xarray(ds.displacement, request, labels, **keywords)
        if mode == "md"
        else summarize_rasters(groups["displacement"], request, **keywords)
    )
    return support.finish(result)


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_point_reference_and_explicit_layer_mask(inputs, mode):
    ds, _, _, reference = inputs
    result = run(
        inputs,
        mode,
        **reference,
        layer_masks=[{"dataset": "quality", "threshold": 0.5}],
    )
    quality = ds.quality.values[:, 1:4, 1:4]
    raw = ds.displacement.values[:, 1:4, 1:4]
    keep = (quality >= 0.5) if mode == "md" else (quality > 0.5)
    common = keep.all(axis=0)
    offsets = [0, 24, 48]
    assert result["reference_details"]["offsets"] == offsets
    assert result["reference_details"]["valid_pixels_per_date"] == [1, 1, 1]
    assert result["common_pixels"] == common.sum()
    assert result["reference"] == "interactive"
    assert result["optional_masks_applied"] is True
    for i, row in enumerate(result["statistics"]):
        expected = raw[i][common] - offsets[i]
        assert row["count"] == len(expected)
        assert row["mean"] == np.mean(expected.astype(float))
        assert row["median"] == np.median(expected)
    assert result["masks"][0]["operator"] == (">=" if mode == "md" else ">")
    assert result["component_compatibility"] == "unverified"


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_missing_reference_does_not_erase_other_common_epochs(inputs, mode):
    ds, groups, _, reference = inputs
    ds.displacement.values[1, 4, 4] = np.nan
    ds.displacement.isel(time=1).rio.write_nodata(np.nan).rio.to_raster(
        groups["displacement"].file_list[1]
    )
    result = run(inputs, mode, **reference)
    assert result["common_pixels"] == 9
    assert result["reference_details"]["offsets"] == [0, None, 48]
    assert result["valid_per_date"] == [9, 9, 9]
    assert [row["count"] for row in result["statistics"]] == [9, 0, 9]
    assert result["statistics"][1]["mean"] is None
    assert result["statistics"][0]["mean"] == 0


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_buffer_reference_uses_valid_source_median(inputs, mode):
    result = run(inputs, mode, **inputs[3], ref_buffer_m=11)
    assert result["reference_details"]["offsets"] == [0, 23, 46]
    assert result["reference_details"]["valid_pixels_per_date"] == [3, 3, 3]
    assert result["reference_details"]["method"] == "circular_median"


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_primary_and_custom_masks_preserve_existing_comparisons(inputs, mode):
    ds, groups, _, _ = inputs
    result = run(
        inputs,
        mode,
        primary_mask=True,
        **({"mask_variable": "quality"} if mode == "md" else {}),
    )
    expected = (
        ds.quality.values[:, 1:4, 1:4] > 0.1
        if mode == "md"
        else ds.quality.values[:, 1:4, 1:4] >= 0.5
    )
    assert result["common_pixels"] == expected.all(axis=0).sum()
    assert result["masks"][0]["operator"] == (">" if mode == "md" else ">=")
    result = run(inputs, mode, custom_mask_path=groups["static_quality"].file_list[0])
    assert result["common_pixels"] == (8 if mode == "md" else 7)
    assert result["reference"] == "stored"


def test_md_max_and_cog_rejection(inputs):
    result = run(
        inputs,
        "md",
        layer_masks=[{"dataset": "quality", "threshold": 0.5, "mode": "max"}],
    )
    assert result["common_pixels"] == 2
    with pytest.raises(ValueError, match="only min"):
        run(inputs, "cog", layer_masks=[{"dataset": "quality", "mode": "max"}])


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_bad_dynamic_axes_rejected(inputs, mode):
    ds, groups, _, _ = inputs
    ds["other_quality"] = ds.quality.rename({"time": "quality_time"}).assign_coords(
        quality_time=ds.time.values + np.timedelta64(1, "D")
    )
    groups["other_quality"] = SimpleNamespace(
        file_list=groups["quality"].file_list, x_values=["wrong"] * 3
    )
    with pytest.raises(ValueError, match="must match"):
        run(inputs, mode, layer_masks=[{"dataset": "other_quality"}])


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_shifted_custom_mask_is_rejected_without_resampling(inputs, mode):
    path = inputs[1]["static_quality"].file_list[0]
    with rasterio.open(path, "r+") as src:
        src.transform = src.transform * src.transform.translation(1, 0)
    with pytest.raises(ValueError, match="exact native"):
        run(inputs, mode, custom_mask_path=path)


def test_polygon_budget_checked_before_reference_reads(inputs, monkeypatch):
    import bowser.polygon_support as module

    monkeypatch.setattr(polygon, "MAX_WINDOW_PIXELS", 1)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Reference sampled before polygon read budget")

    monkeypatch.setattr(module, "reference_offset", forbidden)
    with pytest.raises(ValueError, match="budget"):
        run(inputs, "md", **inputs[3])


def test_mask_reads_are_included_in_polygon_work_budget(inputs, monkeypatch):
    monkeypatch.setattr(polygon, "MAX_PIXEL_EPOCHS", 30)
    # Nine pixels and three epochs fit for raw data, but not data plus a mask.
    assert run(inputs, "md")["polygon_pixels"] == 9
    with pytest.raises(ValueError, match="budget"):
        run(inputs, "md", layer_masks=[{"dataset": "quality"}])


def test_reference_patch_has_its_own_bounded_read_budget(inputs, monkeypatch):
    import bowser.polygon_support as module

    monkeypatch.setattr(polygon, "MAX_PIXEL_EPOCHS", 20)
    ds, groups, body, reference = inputs
    transform = Transformer.from_crs(32631, 4326, always_xy=True)
    ring = [
        list(transform.transform(x, y))
        for x, y in [
            (500014, 24),
            (500016, 24),
            (500016, 26),
            (500014, 26),
            (500014, 24),
        ]
    ]
    small = (
        ds,
        groups,
        {**body, "geometry": {"type": "Polygon", "coordinates": [ring]}},
        reference,
    )

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Reference values read before patch budget validation")

    monkeypatch.setattr(module, "reference_offset", forbidden)
    with pytest.raises(ValueError, match="Reference exceeds"):
        run(small, "md", **reference, ref_buffer_m=100)


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_adjustments_do_not_modify_sources(inputs, mode):
    from hashlib import sha256
    from pathlib import Path

    before = inputs[0].copy(deep=True)
    paths = [p for group in inputs[1].values() for p in group.file_list]
    hashes = {p: sha256(Path(p).read_bytes()).hexdigest() for p in paths}
    run(
        inputs,
        mode,
        **inputs[3],
        layer_masks=[{"dataset": "quality", "threshold": 0.5}],
    )
    xr.testing.assert_identical(inputs[0], before)
    assert {p: sha256(Path(p).read_bytes()).hexdigest() for p in paths} == hashes


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_reference_outside_grid_is_rejected(inputs, mode):
    with pytest.raises(ValueError, match="outside"):
        run(inputs, mode, ref_lon=0, ref_lat=0)
