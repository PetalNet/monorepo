use flutter_rust_bridge::frb;

pub struct FuzzedPoint {
    pub lat: f64,
    pub lon: f64,
    pub cell_x: i64,
    pub cell_y: i64,
}

#[frb(sync)]
pub fn stable_fuzz(
    true_lat: f64,
    true_lon: f64,
    radius_m: f64,
    sharer_id: String,
    audience_id: String,
    secret: Vec<u8>,
) -> FuzzedPoint {
    let (lat, lon) = point_core::fuzz::stable_fuzz(
        true_lat,
        true_lon,
        radius_m,
        &sharer_id,
        &audience_id,
        &secret,
    );
    let (cell_x, cell_y) = point_core::fuzz::fuzz_cell_id(
        true_lat,
        true_lon,
        radius_m,
        &sharer_id,
        &audience_id,
        &secret,
    );
    FuzzedPoint {
        lat,
        lon,
        cell_x,
        cell_y,
    }
}

#[frb(sync)]
pub fn fuzz_radius_presets_m() -> Vec<f64> {
    point_core::fuzz::FUZZ_RADIUS_PRESETS_M.to_vec()
}
