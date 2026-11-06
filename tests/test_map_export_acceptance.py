"""Check map/export values together on a synthetic grid aligned to one map tile."""

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

    zoom, tile_x, tile_y = 12, 2048, 2047
    left, bottom, right, top = tms.get("WebMercatorQuad").xy_bounds(
        tile_x, tile_y, zoom
    )
    size = 16
    pixel = (right - left) / size
    x = left + (np.arange(size) + 0.5) * pixel
    y = top - (np.arange(size) + 0.5) * pixel
    values = (np.arange(size * size).reshape(size, size) * 0.0001).astype("float32")
    values[:2] = np.nan
    values[3, 3] = 0  # valid zero must survive map and export support checks
    values[8, 8] = 0.05  # distinguish the reference point from its local median
    mask = np.ones((size, size), dtype="float32")
    mask[:, :3] = 0
    ds = xr.Dataset(
        {
            "displacement": (
                ("time", "y", "x"),
                np.stack([values * 0, values]),
                {"units": "meters"},
            )
        },
        coords={
            "time": np.array(["2026-01-01", "2026-01-13"], dtype="datetime64[ns]"),
            "x": x,
            "y": y,
        },
    ).rio.write_crs(3857)
    cube = work / "cube.zarr"
    ds.to_zarr(cube, consolidated=False)
    files = []
    for idx, date in enumerate(("20260101", "20260113")):
        path = work / f"displacement_{date}.tif"
        ds.displacement.isel(time=idx).rio.write_nodata(np.nan).rio.to_raster(path)
        files.append(str(path))
    mask_path = work / "custom_mask.tif"
    xr.DataArray(mask, dims=("y", "x"), coords={"y": y, "x": x}).rio.write_crs(
        3857
    ).rio.to_raster(mask_path)
    os.environ["BOWSER_STACK_DATA_FILE"] = str(cube)
    from bowser import main
    from bowser.state import BowserState
    from bowser.titiler import RasterGroup

    md_state = main._default_state
    cog_state = BowserState(
        mode="cog",
        raster_groups={
            "displacement": RasterGroup(
                name="displacement",
                file_list=files,
                uses_spatial_ref=True,
                algorithm="shift",
            )
        },
    )
    lon, lat = Transformer.from_crs(3857, 4326, always_xy=True).transform(x[8], y[8])
    client = TestClient(main.app)
    for mode, state in (("md", md_state), ("cog", cog_state)):
        main._default_state = state
        for buffered in (False, True):
            radius = pixel * 1.1 if buffered else 0
            if buffered:
                response = client.post(
                    "/buffer_timeseries",
                    json={
                        "dataset_name": "displacement",
                        "lon": lon,
                        "lat": lat,
                        "buffer_m": radius,
                        "n_samples": 0,
                    },
                )
                assert response.status_code == 200, response.text
                offset = response.json()["median"][1]["y"]
                expected_offset = float(
                    np.median(values[[7, 8, 8, 8, 9], [8, 7, 8, 9, 8]])
                )
            else:
                response = client.get(
                    "/point",
                    params={
                        "dataset_name": "displacement",
                        "lon": lon,
                        "lat": lat,
                        "time_idx": 1,
                    },
                )
                assert response.status_code == 200, response.text
                offset = response.json()[0]
                expected_offset = float(values[8, 8])
            assert offset == expected_offset, (mode, buffered, offset, expected_offset)
            for masked in (False, True):
                case = (mode, buffered, masked)
                common = {"variable": "displacement", "time_idx": 1}
                tile_params = {
                    **common,
                    "tilesize": 256,
                    "algorithm": "shift",
                    "algorithm_params": json.dumps({"shift": offset}),
                }
                if mode == "cog":
                    tile_params["url"] = files[1]
                if masked:
                    key = "custom_mask_path" if mode == "md" else "custom_mask"
                    tile_params[key] = str(mask_path)
                response = client.get(
                    f"/{mode}/tiles/WebMercatorQuad/{zoom}/{tile_x}/{tile_y}.npy",
                    params=tile_params,
                )
                assert response.status_code == 200, (case, response.text[:200])
                tile = np.load(io.BytesIO(response.content), allow_pickle=False)
                export_params = {
                    **common,
                    "ref_lon": lon,
                    "ref_lat": lat,
                    "ref_buffer_m": radius,
                }
                if masked:
                    export_params["custom_mask_path"] = str(mask_path)
                response = client.get("/export/geotiff", params=export_params)
                assert response.status_code == 200, (case, response.text[:200])
                with rasterio.MemoryFile(response.content) as memory:
                    with memory.open() as src:
                        exported = src.read(1)
                        export_valid = src.read_masks(1) > 0
                        assert src.crs.to_epsg() == 3857
                        assert src.transform == ds.rio.transform()
                        assert src.shape == (size, size)
                        assert src.tags()["units"] == "meters"
                        assert float(src.tags()["BOWSER_REFERENCE_VALUE"]) == offset
                        provenance = json.loads(src.tags()["BOWSER_EXPORT_PROVENANCE"])
                        reference = provenance["reference"]
                        assert reference["mode"] == "interactive"
                        assert float(reference["value"]) == offset
                        assert float(reference["longitude"]) == lon
                        assert float(reference["latitude"]) == lat
                        assert reference["utm"]["crs"].startswith("EPSG:326")
                        utm = reference["utm"]
                        back_lon, back_lat = Transformer.from_crs(
                            utm["crs"], 4326, always_xy=True
                        ).transform(utm["easting_meters"], utm["northing_meters"])
                        np.testing.assert_allclose([back_lon, back_lat], [lon, lat], atol=1e-9)
                        assert reference["method"] == (
                            "circular_median" if buffered
                            else "nearest_pixel" if mode == "md" else "containing_pixel"
                        )
                        assert bool(provenance["masks"]["applied"]) == masked
                expected_valid = np.isfinite(values) & (
                    (mask > 0.5) if masked else True
                )
                np.testing.assert_array_equal(
                    export_valid, expected_valid, err_msg=str(case)
                )
                np.testing.assert_allclose(
                    exported[expected_valid],
                    (values - offset)[expected_valid],
                    rtol=1e-7,
                    atol=1e-9,
                    err_msg=str(case),
                )
                # The native 16x16 grid exactly covers this WebMercator tile;
                # nearest-neighbor display repeats each native pixel 16 times.
                display_values = exported.repeat(16, axis=0).repeat(16, axis=1)
                display_valid = expected_valid.repeat(16, axis=0).repeat(16, axis=1)
                assert tile.shape == (2, 256, 256), (case, tile.shape)
                np.testing.assert_array_equal(
                    tile[-1] > 0, display_valid, err_msg=str(case)
                )
                np.testing.assert_allclose(
                    tile[0][display_valid],
                    display_values[display_valid],
                    rtol=1e-7,
                    atol=1e-9,
                    err_msg=str(case),
                )
    print("Eight MD/COG point/buffer masked/unmasked map-export cases passed")


def test_map_and_export_agree_with_active_reference_and_mask(tmp_path):
    env = {
        key: value for key, value in os.environ.items() if not key.startswith("BOWSER_")
    }
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(tmp_path)],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout[-1000:] + result.stderr[-5000:]
    assert "Eight MD/COG" in result.stdout


if __name__ == "__main__":
    _exercise(Path(sys.argv[1]))
