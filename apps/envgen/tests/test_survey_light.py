"""The survey's morning shadows take precedence over older afternoon imagery."""

from datetime import UTC, date, datetime

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from envgen import cover, light, survey_light
from envgen.build import build
from envgen.site import Source

from . import helpers as h


def test_contemporary_shadow_fit_recovers_morning_sun_and_ignores_unobserved_dark_cells():
    ground = np.zeros((96, 96), dtype=np.float32)
    height = ground.copy()
    height[30:36, 25:31] = 9
    height[55:62, 55:61] = 12
    azimuth, elevation = cover.sun_position(38, -92, datetime(2026, 9, 5, 15, 8, tzinfo=UTC))
    shadow = cover.cast_shadow(ground, height, azimuth, elevation, 1)
    brightness = np.where(shadow, 40.0, 150.0)
    valid = np.ones(ground.shape, dtype=bool)
    valid[:10] = False
    brightness[:10] = 0

    result = survey_light.fit_shadow_time(date(2026, 9, 5), 38, -92, 0, ground, height, brightness, valid, 1)

    assert result is not None
    assert result["azimuth_deg"] == pytest.approx(azimuth, abs=3)
    assert result["elevation_deg"] == pytest.approx(elevation, abs=3)
    assert result["fit"]["correlation"] > 0.8
    assert result["fit"]["open_cells"] < valid.size
    assert result["date"] == "2026-09-05"


@pytest.mark.parametrize("with_height", [False, True])
def test_no_shadow_evidence_does_not_replace_the_existing_sun(with_height):
    ground = np.zeros((32, 32), dtype=np.float32)
    height = ground.copy()
    if with_height:
        height[10:14, 12:16] = 8
    assert (
        survey_light.fit_shadow_time(
            date(2026, 9, 5), 38, -92, 0, ground, height, np.ones(ground.shape), np.ones(ground.shape, bool), 1
        )
        is None
    )


def test_survey_rasters_produce_a_dated_fit_with_mosaic_uncertainty(tmp_path):
    ground = np.zeros((96, 96), dtype=np.float32)
    height = ground.copy()
    height[30:36, 25:31] = 9
    height[55:62, 55:61] = 12
    azimuth, elevation = cover.sun_position(38, -92, datetime(2026, 9, 5, 15, 8, tzinfo=UTC))
    shadow = cover.cast_shadow(ground, height, azimuth, elevation, 1)
    photo = np.full((4, 96, 96), 255, dtype=np.uint8)
    photo[:3] = np.where(shadow, 40, 150)
    for name, data in (("photo", photo), ("ground", ground[None]), ("surface", height[None])):
        with rasterio.open(
            tmp_path / f"{name}.tif",
            "w",
            driver="GTiff",
            width=96,
            height=96,
            count=data.shape[0],
            dtype=data.dtype,
            crs="EPSG:32615",
            transform=from_origin(500000, 4200000, 1, 1),
        ) as dst:
            dst.write(data)
    survey = Source(
        "file",
        str(tmp_path / "surface.tif"),
        "test",
        "2026-09-05 and 2026-09-07",
        terrain=str(tmp_path / "ground.tif"),
        orthophoto=str(tmp_path / "photo.tif"),
    )

    result = survey_light.from_survey(survey, 38, -92, 0, "EPSG:32615")

    assert result["grid_azimuth_deg"] == pytest.approx(azimuth, abs=3)
    assert "mosaicked" in " ".join(result["priors"])
    assert result["fit"]["source_date"] == survey.date
    assert survey_light.from_survey(survey, 38, -92, 0, "EPSG:32616") is None


def test_cached_survey_time_follows_the_requested_season_and_preserves_the_acquisition_fit(tmp_path, monkeypatch):
    import json

    h.write_dem(tmp_path / "dem.tif")
    h.write_scene(tmp_path / "imagery.tif", h.GRASS, [])
    site_path = h.write_site(tmp_path)
    site = json.loads(site_path.read_text())
    site["sources"]["survey"] = {
        "kind": "file",
        "path": "dem.tif",
        "terrain": "dem.tif",
        "orthophoto": "imagery.tif",
        "license": "test",
        "date": "2030-09-05",
    }
    site_path.write_text(json.dumps(site))
    calls = []

    def fitted(survey, lat, lon, offset, crs):
        calls.append(survey.date)
        return light.lighting("2030-09-05", "09:55", lat, lon, offset)

    monkeypatch.setattr(survey_light, "from_survey", fitted)
    summer = build(site_path, tmp_path / "out")
    site["target_date"] = "2030-12-15"
    site_path.write_text(json.dumps(site))
    winter = build(site_path, tmp_path / "out")

    assert summer["lighting"]["date"] == "2030-06-15"
    assert winter["lighting"]["date"] == "2030-12-15"
    assert winter["lighting"]["solar_time"] == summer["lighting"]["solar_time"] == "09:55"
    assert winter["lighting"]["elevation_deg"] < summer["lighting"]["elevation_deg"]
    assert winter["lighting"]["survey_fit"]["date"] == "2030-09-05"
    assert calls == ["2030-09-05"]
