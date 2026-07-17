use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

pub const FUZZ_RADIUS_NEAR_M: f64 = 300.0;
pub const FUZZ_RADIUS_MID_M: f64 = 1_000.0;
pub const FUZZ_RADIUS_CITY_M: f64 = 5_000.0;

pub const FUZZ_RADIUS_PRESETS_M: [f64; 3] =
    [FUZZ_RADIUS_NEAR_M, FUZZ_RADIUS_MID_M, FUZZ_RADIUS_CITY_M];

const M_PER_DEG_LAT: f64 = 111_320.0;

type HmacSha256 = Hmac<Sha256>;

fn grid_origin_offsets(cell: f64, sharer_id: &str, audience_id: &str, secret: &[u8]) -> (f64, f64) {
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac accepts any key length");
    mac.update(&(sharer_id.len() as u64).to_be_bytes());
    mac.update(sharer_id.as_bytes());
    mac.update(&(audience_id.len() as u64).to_be_bytes());
    mac.update(audience_id.as_bytes());
    let h = mac.finalize().into_bytes();
    let hx = u64::from_be_bytes(h[0..8].try_into().expect("8 bytes"));
    let hy = u64::from_be_bytes(h[8..16].try_into().expect("8 bytes"));
    let ox = (hx as f64 / 2f64.powi(64)) * cell;
    let oy = (hy as f64 / 2f64.powi(64)) * cell;
    (ox, oy)
}

struct Snapped {
    cell_x: i64,
    cell_y: i64,
    lat: f64,
    lon: f64,
}

fn snap(
    true_lat: f64,
    true_lon: f64,
    radius_m: f64,
    sharer_id: &str,
    audience_id: &str,
    secret: &[u8],
) -> Snapped {
    assert!(
        radius_m.is_finite() && radius_m > 0.0,
        "radius_m must be positive and finite"
    );
    assert!(
        true_lat.is_finite() && true_lat.abs() <= 89.0,
        "true_lat out of supported range"
    );
    assert!(
        true_lon.is_finite() && true_lon.abs() <= 180.0,
        "true_lon out of supported range"
    );
    let cell = radius_m;
    let (ox, oy) = grid_origin_offsets(cell, sharer_id, audience_id, secret);
    let y_m = true_lat * M_PER_DEG_LAT;
    let cell_y = ((y_m - oy) / cell).floor() as i64;
    let cy = cell_y as f64 * cell + oy + cell / 2.0;
    let lat = cy / M_PER_DEG_LAT;
    let m_per_deg_lon = M_PER_DEG_LAT * lat.to_radians().cos();
    let x_m = true_lon * m_per_deg_lon;
    let cell_x = ((x_m - ox) / cell).floor() as i64;
    let cx = cell_x as f64 * cell + ox + cell / 2.0;
    let lon = cx / m_per_deg_lon;
    Snapped {
        cell_x,
        cell_y,
        lat,
        lon,
    }
}

pub fn stable_fuzz(
    true_lat: f64,
    true_lon: f64,
    radius_m: f64,
    sharer_id: &str,
    audience_id: &str,
    secret: &[u8],
) -> (f64, f64) {
    let s = snap(true_lat, true_lon, radius_m, sharer_id, audience_id, secret);
    (s.lat, s.lon)
}

pub fn fuzz_cell_id(
    true_lat: f64,
    true_lon: f64,
    radius_m: f64,
    sharer_id: &str,
    audience_id: &str,
    secret: &[u8],
) -> (i64, i64) {
    let s = snap(true_lat, true_lon, radius_m, sharer_id, audience_id, secret);
    (s.cell_x, s.cell_y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::{RngExt, SeedableRng};

    const SECRET: &[u8] = b"unit-test-sharer-secret-32bytes!";
    const SHARER: &str = "alice@point.dev";
    const AUDIENCE: &str = "grp:family";

    fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
        let r = 6_371_000.0_f64;
        let p1 = lat1.to_radians();
        let p2 = lat2.to_radians();
        let dp = (lat2 - lat1).to_radians();
        let dl = (lon2 - lon1).to_radians();
        let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
        2.0 * r * a.sqrt().asin()
    }

    fn bits(p: (f64, f64)) -> (u64, u64) {
        (p.0.to_bits(), p.1.to_bits())
    }

    #[test]
    fn repeated_calls_are_byte_identical() {
        let a = stable_fuzz(38.6270, -90.1994, 1000.0, SHARER, AUDIENCE, SECRET);
        for _ in 0..100 {
            let b = stable_fuzz(38.6270, -90.1994, 1000.0, SHARER, AUDIENCE, SECRET);
            assert_eq!(bits(a), bits(b));
        }
    }

    #[test]
    fn determinism_within_a_cell() {
        let mut rng = StdRng::seed_from_u64(1);
        for radius in FUZZ_RADIUS_PRESETS_M {
            for _ in 0..200 {
                let lat = rng.random_range(-70.0..70.0);
                let lon = rng.random_range(-179.0..179.0);
                let cell = fuzz_cell_id(lat, lon, radius, SHARER, AUDIENCE, SECRET);
                let center = stable_fuzz(lat, lon, radius, SHARER, AUDIENCE, SECRET);
                let deg = radius / M_PER_DEG_LAT;
                let mut same_cell_samples = 0;
                for _ in 0..50 {
                    let jlat = lat + rng.random_range(-deg..deg);
                    let jlon = lon + rng.random_range(-deg..deg);
                    if fuzz_cell_id(jlat, jlon, radius, SHARER, AUDIENCE, SECRET) == cell {
                        same_cell_samples += 1;
                        let jcenter = stable_fuzz(jlat, jlon, radius, SHARER, AUDIENCE, SECRET);
                        assert_eq!(bits(center), bits(jcenter));
                    }
                }
                assert!(same_cell_samples > 0);
            }
        }
    }

    #[test]
    fn averaging_many_fixes_in_a_cell_reveals_nothing_beyond_the_center() {
        let mut rng = StdRng::seed_from_u64(2);
        let radius = 1000.0;
        let base = (48.8566, 2.3522);
        let cell = fuzz_cell_id(base.0, base.1, radius, SHARER, AUDIENCE, SECRET);
        let mut outputs = std::collections::HashSet::new();
        let deg = radius / M_PER_DEG_LAT;
        let mut samples = 0;
        while samples < 500 {
            let jlat = base.0 + rng.random_range(-deg..deg);
            let jlon = base.1 + rng.random_range(-deg..deg);
            if fuzz_cell_id(jlat, jlon, radius, SHARER, AUDIENCE, SECRET) == cell {
                outputs.insert(bits(stable_fuzz(
                    jlat, jlon, radius, SHARER, AUDIENCE, SECRET,
                )));
                samples += 1;
            }
        }
        assert_eq!(outputs.len(), 1);
    }

    #[test]
    fn cell_crossing_changes_center_and_cell_id() {
        let radius = 300.0;
        let start = (51.5074, -0.1278);
        let start_cell = fuzz_cell_id(start.0, start.1, radius, SHARER, AUDIENCE, SECRET);
        let start_center = stable_fuzz(start.0, start.1, radius, SHARER, AUDIENCE, SECRET);
        let step = radius / M_PER_DEG_LAT / 50.0;
        let mut lon = start.1;
        let mut crossed = false;
        for _ in 0..200 {
            lon += step;
            let cell = fuzz_cell_id(start.0, lon, radius, SHARER, AUDIENCE, SECRET);
            let center = stable_fuzz(start.0, lon, radius, SHARER, AUDIENCE, SECRET);
            if cell == start_cell {
                assert_eq!(bits(start_center), bits(center));
            } else {
                assert_eq!(cell.1, start_cell.1);
                assert_eq!(cell.0, start_cell.0 + 1);
                assert_ne!(bits(start_center), bits(center));
                crossed = true;
                break;
            }
        }
        assert!(crossed);

        let mut lat = start.0;
        let mut crossed_y = false;
        for _ in 0..200 {
            lat += step;
            let cell = fuzz_cell_id(lat, start.1, radius, SHARER, AUDIENCE, SECRET);
            if cell != start_cell {
                assert_eq!(cell.0, start_cell.0);
                assert_eq!(cell.1, start_cell.1 + 1);
                let center = stable_fuzz(lat, start.1, radius, SHARER, AUDIENCE, SECRET);
                assert_ne!(bits(start_center), bits(center));
                crossed_y = true;
                break;
            }
        }
        assert!(crossed_y);
    }

    #[test]
    fn distinct_grids_per_audience() {
        let mut rng = StdRng::seed_from_u64(3);
        let mut differing = 0;
        let total = 100;
        for _ in 0..total {
            let lat = rng.random_range(-70.0..70.0);
            let lon = rng.random_range(-179.0..179.0);
            let a = stable_fuzz(lat, lon, 1000.0, SHARER, "grp:family", SECRET);
            let b = stable_fuzz(lat, lon, 1000.0, SHARER, "grp:friends", SECRET);
            if bits(a) != bits(b) {
                differing += 1;
                assert!(haversine_m(lat, lon, a.0, a.1) <= 1000.0);
                assert!(haversine_m(lat, lon, b.0, b.1) <= 1000.0);
            }
        }
        assert!(differing >= total * 9 / 10);
    }

    #[test]
    fn cross_referencing_two_audiences_does_not_narrow_below_a_cell() {
        let (ox_a, oy_a) = grid_origin_offsets(1000.0, SHARER, "grp:family", SECRET);
        let (ox_b, oy_b) = grid_origin_offsets(1000.0, SHARER, "grp:friends", SECRET);
        assert!((ox_a - ox_b).abs() > 1.0 || (oy_a - oy_b).abs() > 1.0);
        let mut rng = StdRng::seed_from_u64(4);
        let lat = 40.7128;
        let lon = -74.0060;
        let a = stable_fuzz(lat, lon, 1000.0, SHARER, "grp:family", SECRET);
        let b = stable_fuzz(lat, lon, 1000.0, SHARER, "grp:friends", SECRET);
        let deg = 1000.0 / M_PER_DEG_LAT;
        let mut consistent = 0;
        for _ in 0..5000 {
            let clat = lat + rng.random_range(-deg..deg);
            let clon = lon + rng.random_range(-deg..deg);
            let ca = stable_fuzz(clat, clon, 1000.0, SHARER, "grp:family", SECRET);
            let cb = stable_fuzz(clat, clon, 1000.0, SHARER, "grp:friends", SECRET);
            if bits(ca) == bits(a) && bits(cb) == bits(b) {
                consistent += 1;
            }
        }
        assert!(consistent > 100);
    }

    #[test]
    fn distinct_grids_per_sharer_and_secret() {
        let lat = 35.6762;
        let lon = 139.6503;
        let a = stable_fuzz(lat, lon, 1000.0, "alice@point.dev", AUDIENCE, SECRET);
        let b = stable_fuzz(lat, lon, 1000.0, "bob@point.dev", AUDIENCE, SECRET);
        let c = stable_fuzz(
            lat,
            lon,
            1000.0,
            "alice@point.dev",
            AUDIENCE,
            b"other-secret",
        );
        assert_ne!(bits(a), bits(b));
        assert_ne!(bits(a), bits(c));
    }

    #[test]
    fn sharer_audience_boundary_is_domain_separated() {
        let (ox_a, oy_a) = grid_origin_offsets(1000.0, "ab", "c", SECRET);
        let (ox_b, oy_b) = grid_origin_offsets(1000.0, "a", "bc", SECRET);
        assert!((ox_a - ox_b).abs() > f64::EPSILON || (oy_a - oy_b).abs() > f64::EPSILON);
    }

    #[test]
    fn true_point_always_within_drawn_circle() {
        let mut rng = StdRng::seed_from_u64(5);
        for _ in 0..2000 {
            let lat = rng.random_range(-70.0..70.0);
            let lon = rng.random_range(-179.0..179.0);
            let radius = if rng.random_range(0..2) == 0 {
                FUZZ_RADIUS_PRESETS_M[rng.random_range(0..3)]
            } else {
                rng.random_range(100.0..10_000.0)
            };
            let audience = format!("aud:{}", rng.random_range(0..50));
            let (flat, flon) = stable_fuzz(lat, lon, radius, SHARER, &audience, SECRET);
            let d = haversine_m(lat, lon, flat, flon);
            assert!(
                d <= radius,
                "true point {d:.1} m from center exceeds radius {radius} at ({lat},{lon})"
            );
        }
    }

    #[test]
    fn snapped_center_offset_is_bounded_but_nonzero_in_general() {
        let mut rng = StdRng::seed_from_u64(6);
        let mut max_d = 0.0_f64;
        for _ in 0..500 {
            let lat = rng.random_range(-70.0..70.0);
            let lon = rng.random_range(-179.0..179.0);
            let (flat, flon) = stable_fuzz(lat, lon, 1000.0, SHARER, AUDIENCE, SECRET);
            max_d = max_d.max(haversine_m(lat, lon, flat, flon));
        }
        assert!(max_d > 500.0);
        assert!(max_d <= 1000.0);
    }

    #[test]
    fn presets_are_ordered_and_positive() {
        let presets = FUZZ_RADIUS_PRESETS_M.to_vec();
        assert!(presets.iter().all(|r| *r > 0.0));
        assert!(presets.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(presets, vec![300.0, 1_000.0, 5_000.0]);
    }
}
