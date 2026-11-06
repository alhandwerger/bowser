"""Compare polygon statistics to actual reference-aware GeoTIFF exports."""

import json
import os
import subprocess
import sys

import numpy as np
import pytest
from test_polygon_support import make_inputs


@pytest.fixture(scope="module")
def results(tmp_path_factory):
    work = tmp_path_factory.mktemp("polygon-adjusted-api")
    ds, groups, body, reference = make_inputs(work)
    ds["wrong_time_quality"] = ds.quality.rename(
        {"time": "quality_time"}
    ).assign_coords(quality_time=ds.time.values + np.timedelta64(1, "D"))
    ds.to_zarr(work / "cube.zarr", consolidated=False)
    manifest = {name: group.file_list for name, group in groups.items()}
    (work / "inputs.json").write_text(
        json.dumps({"files": manifest, "body": body, "reference": reference})
    )
    shifted = work / "shifted.tif"
    import rasterio

    with rasterio.open(groups["static_quality"].file_list[0]) as src:
        meta, values = src.profile, src.read(1)
    meta["transform"] = meta["transform"] * meta["transform"].translation(1, 0)
    with rasterio.open(shifted, "w", **meta) as dst:
        dst.write(values, 1)
    script = r"""
import io
import json
from pathlib import Path
import numpy as np
import rasterio
from fastapi.testclient import TestClient
from bowser import main
from bowser.state import BowserState
from bowser.titiler import RasterGroup

work = Path.cwd()
inputs = json.loads((work / "inputs.json").read_text())
body, reference, files = inputs["body"], inputs["reference"], inputs["files"]
md = main._default_state
groups = {
    name: RasterGroup(
        name=name,
        file_list=paths,
        uses_spatial_ref=name == "displacement",
        algorithm="shift" if name == "displacement" else None,
    )
    for name, paths in files.items()
}
# Synthetic COG filenames use configured indices in both data and quality
# groups. No acquisition dates are inferred from these indexed labels.
cog = BowserState(mode="cog", raster_groups=groups)
client = TestClient(main.app)
result = {}
for mode, state in (("md", md), ("cog", cog)):
    main._default_state = state
    variants = {
        "raw": {},
        "point": reference,
        "buffer": {**reference, "ref_buffer_m": 11},
        "layer": {"layer_masks": [{"dataset": "quality", "threshold": 0.5}]},
        "primary": {
            "primary_mask": True,
            "mask_min_value": 0.5,
            **({"mask_variable": "quality"} if mode == "md" else {}),
        },
        "custom": {"custom_mask_path": files["static_quality"][0]},
        "point_layer": {
            **reference,
            "layer_masks": [{"dataset": "quality", "threshold": 0.5}],
        },
        "buffer_layer": {
            **reference,
            "ref_buffer_m": 11,
            "layer_masks": [{"dataset": "quality", "threshold": 0.5}],
        },
    }
    for name, options in variants.items():
        groups["displacement"].mask_file_list = (
            files["quality"] if options.get("primary_mask") else []
        )
        exported, export_tags = [], []
        for index in range(3):
            params = {"variable": "displacement", "time_idx": index}
            for key in (
                "ref_lon",
                "ref_lat",
                "ref_buffer_m",
                "mask_variable",
                "mask_min_value",
                "custom_mask_path",
            ):
                if key in options:
                    params[key] = options[key]
            if options.get("layer_masks"):
                params["layer_masks"] = json.dumps(options["layer_masks"])
            response = client.get("/export/geotiff", params=params)
            assert response.status_code == 200, (mode, name, response.text[:100])
            with rasterio.MemoryFile(response.content) as mem, mem.open() as src:
                exported.append(src.read(1)[1:4, 1:4].astype(float))
                export_tags.append(src.tags())
        for support in ("common", "per_date"):
            response = client.post(
                "/polygon_timeseries", json={**body, **options, "support": support}
            )
            assert response.status_code == 200, (mode, name, response.text[:300])
            result[f"{mode}_{name}_{support}"] = {
                "summary": response.json(),
                "exported": np.nan_to_num(np.array(exported), nan=-9999).tolist(),
                "export_tags": export_tags,
            }
    groups["displacement"].mask_file_list = []
    for name, options in {
        "partial_reference": {"ref_lon": 3},
        "outside_reference": {"ref_lon": 0, "ref_lat": 0},
        "quality_reference": {**reference, "variable": "quality"},
        "unknown_mask": {"layer_masks": [{"dataset": "missing"}]},
        "bad_mode": {"layer_masks": [{"dataset": "quality", "mode": "bogus"}]},
        "missing_custom": {"custom_mask_path": str(work / "absent.tif")},
        "shifted_custom": {"custom_mask_path": str(work / "shifted.tif")},
        "primary_missing": {"primary_mask": True},
    }.items():
        response = client.post("/polygon_timeseries", json={**body, **options})
        result[f"{mode}_invalid_{name}"] = response.status_code
    if mode == "md":
        response = client.post(
            "/polygon_timeseries",
            json={**body, "layer_masks": [{"dataset": "wrong_time_quality"}]},
        )
        result["bad_time"] = response.status_code
    # A single missing reference epoch must not erase common spatial support.
    if mode == "md":
        state.dataset["displacement"] = state.dataset.displacement.load()
        state.dataset.displacement.values[1, 4, 4] = np.nan
    else:
        with rasterio.open(files["displacement"][1], "r+") as src:
            values = src.read(1)
            values[4, 4] = np.nan
            src.write(values, 1)
    response = client.post("/polygon_timeseries", json={**body, **reference})
    assert response.status_code == 200, response.text[:300]
    result[f"{mode}_missing_reference"] = response.json()
(work / "results.json").write_text(json.dumps(result))
"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOWSER_")}
    env.update(
        BOWSER_STACK_DATA_FILE=str(work / "cube.zarr"),
        BOWSER_USE_SPATIAL_REFERENCE_DISP="true",
    )
    run = subprocess.run(
        [sys.executable, "-c", script],
        cwd=work,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert run.returncode == 0, run.stdout[-1000:] + run.stderr[-5000:]
    return json.loads((work / "results.json").read_text())


@pytest.mark.parametrize("mode", ["md", "cog"])
@pytest.mark.parametrize("support", ["common", "per_date"])
@pytest.mark.parametrize(
    "variant",
    [
        "raw",
        "point",
        "buffer",
        "layer",
        "primary",
        "custom",
        "point_layer",
        "buffer_layer",
    ],
)
def test_actual_export_values_and_masks_agree(results, mode, support, variant):
    case = results[f"{mode}_{variant}_{support}"]
    summary = case["summary"]
    frames = np.array(case["exported"], float)
    valid = frames != -9999
    common = valid.all(axis=0)
    assert summary["common_pixels"] == common.sum()
    for index, row in enumerate(summary["statistics"]):
        values = frames[index][common if support == "common" else valid[index]]
        assert row["count"] == len(values)
        assert row["mean"] == pytest.approx(np.mean(values), rel=0, abs=1e-12)
        assert row["median"] == np.median(values)
        assert row["percentiles"] == {
            "10": np.percentile(values, 10),
            "90": np.percentile(values, 90),
        }
        export_info = json.loads(case["export_tags"][index]["BOWSER_EXPORT_PROVENANCE"])
        expected = [
            (m["kind"], m["operator"], m["threshold"])
            for m in export_info["masks"]["applied"]
        ]
        assert [
            (m["kind"], m["operator"], m["threshold"]) for m in summary["masks"]
        ] == expected
        if summary["reference"] == "interactive":
            assert summary["reference_details"]["offsets"][index] == float(
                case["export_tags"][index]["BOWSER_REFERENCE_VALUE"]
            )


@pytest.mark.parametrize("mode", ["md", "cog"])
@pytest.mark.parametrize(
    "case",
    [
        "partial_reference",
        "outside_reference",
        "quality_reference",
        "unknown_mask",
        "bad_mode",
        "missing_custom",
        "shifted_custom",
        "primary_missing",
    ],
)
def test_invalid_requests_fail_explicitly(results, mode, case):
    assert results[f"{mode}_invalid_{case}"] == 422


@pytest.mark.parametrize("mode", ["md", "cog"])
def test_missing_reference_epoch_is_empty_not_global_data_loss(results, mode):
    case = results[f"{mode}_missing_reference"]
    assert case["common_pixels"] == 9
    assert [s["count"] for s in case["statistics"]] == [9, 0, 9]
    assert case["reference_details"]["offsets"] == [0, None, 48]
    assert case["statistics"][0]["mean"] == 0
    assert results["bad_time"] == 422
