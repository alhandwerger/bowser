"""Compare signed upper/lower masks across actual tiles, exports and polygons."""

import os
import subprocess
import sys
from pathlib import Path


def _exercise(work: Path) -> None:
    import io
    import json

    import numpy as np
    import rasterio
    import rioxarray  # noqa: F401
    import xarray as xr
    from fastapi.testclient import TestClient
    from morecantile import tms
    from pyproj import Transformer

    zoom, tile_x, tile_y, size = 12, 2048, 2047, 16
    left, bottom, right, top = tms.get("WebMercatorQuad").xy_bounds(
        tile_x, tile_y, zoom
    )
    spacing = (right - left) / size
    x = left + (np.arange(size) + 0.5) * spacing
    y = top - (np.arange(size) + 0.5) * spacing
    data = np.arange(size * size, dtype="float32").reshape(size, size)
    data[0, 0] = np.nan
    data[3, 3] = 0
    quality = np.tile(
        np.array([-2, -1, 0, 0.5, 1, np.nan, np.inf, -np.inf] * 2, dtype="float32"),
        (size, 1),
    )
    quality[4, 4] = -9999  # intrinsic mask nodata cannot pass an upper bound
    ds = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                np.stack([data * 0, data]),
                {"units": "meters"},
            ),
            "quality": (("time", "y", "x"), np.stack([quality, quality * -1])),
        },
        coords={
            "time": np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]"),
            "x": x,
            "y": y,
        },
    ).rio.write_crs(3857)
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    files = {}
    for name in ("displacement", "quality"):
        files[name] = []
        for index in range(2):
            frame = ds[name].isel(time=index).copy()
            values = frame.values.copy()
            if name == "quality":
                values[4, 4] = -9999
            frame.values = values
            path = work / f"{name}_{index}.tif"
            frame.rio.write_nodata(
                -9999 if name == "quality" else np.nan
            ).rio.to_raster(path)
            files[name].append(str(path))
    os.environ["BOWSER_STACK_DATA_FILE"] = str(work / "cube.zarr")
    from bowser import main
    from bowser.state import BowserState
    from bowser.titiler import RasterGroup

    main._default_state = BowserState(
        mode="cog",
        raster_groups={
            name: RasterGroup(
                name=name,
                file_list=paths,
                uses_spatial_ref=name == "displacement",
                algorithm="shift" if name == "displacement" else None,
            )
            for name, paths in files.items()
        },
    )
    main._default_state.raster_groups["static_quality"] = RasterGroup(
        name="static_quality", file_list=files["quality"][:1]
    )
    client = TestClient(main.app)
    transform = Transformer.from_crs(3857, 4326, always_xy=True)
    ring = [
        list(transform.transform(xx, yy))
        for xx, yy in [
            (left, bottom),
            (right, bottom),
            (right, top),
            (left, top),
            (left, bottom),
        ]
    ]
    geometry = {"type": "Polygon", "coordinates": [ring]}
    cases = [
        [{"dataset": "quality", "mode": mode, "threshold": threshold}]
        for mode in ("max", "min")
        for threshold in (-1, 0, 0.5)
    ] + [
        [{"dataset": "static_quality", "mode": "max", "threshold": 0.5}],
        [
            {"dataset": "quality", "mode": "min", "threshold": -2},
            {"dataset": "quality", "mode": "max", "threshold": 0.5},
        ],
    ]
    for masks in cases:
        expected_frames = []
        expected_validity = []
        for index in range(2):
            expected = ds.displacement.values[index]
            valid = np.isfinite(expected)
            for mask in masks:
                source_index = 0 if mask["dataset"] == "static_quality" else index
                q = ds.quality.values[source_index].copy()
                q[4, 4] = np.nan
                valid &= np.isfinite(q) & (
                    (q <= mask["threshold"])
                    if mask["mode"] == "max"
                    else (q > mask["threshold"])
                )
            expected_frames.append(expected)
            expected_validity.append(valid)
            encoded = json.dumps(masks)
            tile = client.get(
                f"/cog/tiles/WebMercatorQuad/{zoom}/{tile_x}/{tile_y}.npy",
                params={
                    "url": files["displacement"][index],
                    "variable": "displacement",
                    "time_idx": index,
                    "tilesize": 256,
                    "layer_masks": encoded,
                },
            )
            assert tile.status_code == 200, tile.text[:200]
            pixels = np.load(io.BytesIO(tile.content), allow_pickle=False)
            np.testing.assert_array_equal(
                pixels[-1] > 0,
                valid.repeat(16, 0).repeat(16, 1),
                err_msg=f"tile mask ignored: {masks}, date {index}",
            )
            np.testing.assert_array_equal(
                pixels[0][pixels[-1] > 0],
                expected.repeat(16, 0).repeat(16, 1)[pixels[-1] > 0],
            )
            exported = client.get(
                "/export/geotiff",
                params={
                    "variable": "displacement",
                    "time_idx": index,
                    "layer_masks": encoded,
                },
            )
            assert exported.status_code == 200, exported.text[:200]
            with (
                rasterio.MemoryFile(exported.content) as memory,
                memory.open() as source,
            ):
                np.testing.assert_array_equal(source.read_masks(1) > 0, valid)
                np.testing.assert_array_equal(source.read(1)[valid], expected[valid])
                assert source.transform == ds.rio.transform()
                assert source.crs.to_epsg() == 3857
                assert source.tags()["units"] == "meters"
                records = json.loads(source.tags()["BOWSER_EXPORT_PROVENANCE"])[
                    "masks"
                ]["applied"]
                assert [r["operator"] for r in records] == [
                    "<=" if m["mode"] == "max" else ">" for m in masks
                ]
        for support in ("common", "per_date"):
            response = client.post(
                "/polygon_timeseries",
                json={
                    "variable": "displacement",
                    "geometry": geometry,
                    "layer_masks": masks,
                    "support": support,
                },
            )
            assert response.status_code == 200, response.text[:200]
            result = response.json()
            common = np.logical_and.reduce(expected_validity)
            for index, statistics in enumerate(result["statistics"]):
                valid = common if support == "common" else expected_validity[index]
                values = expected_frames[index][valid]
                assert statistics["count"] == values.size
                if values.size:
                    assert statistics["mean"] == float(values.astype("float64").mean())
                    assert statistics["median"] == float(np.median(values))
                else:
                    assert statistics["mean"] is None and statistics["median"] is None
    for invalid in (
        "{broken",
        "{}",
        "[3]",
        '[{"dataset":"missing"}]',
        '[{"dataset":"quality","mode":"invalid"}]',
        '[{"dataset":"quality","threshold":NaN}]',
        '[{"dataset":"quality","threshold":null}]',
    ):
        response = client.get(
            f"/cog/tiles/WebMercatorQuad/{zoom}/{tile_x}/{tile_y}.npy",
            params={"url": files["displacement"][0], "layer_masks": invalid},
        )
        assert response.status_code == 422, response.text[:200]
    print("Eight COG mask networks passed tile/export/polygon parity")


def test_actual_cog_maximum_masks(tmp_path):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(tmp_path)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=75,
    )
    assert result.returncode == 0, result.stdout[-1000:] + result.stderr[-5000:]
    assert "Eight COG" in result.stdout


if __name__ == "__main__":
    _exercise(Path(sys.argv[1]))
