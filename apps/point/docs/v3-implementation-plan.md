# V3 Location Engine — Implementation Plan

## Audit Summary

**22 files affected** (14 modified, 4 new Flutter, 1 new server, 3 models updated)
**All changes backward compatible** — single-position relay still works alongside batched.

---

## Phase 1: Accelerometer Gate (P0)
**Impact: Eliminates 80% of GPS wakes. Biggest battery win.**

### Files:
- **MODIFY** `location_service.dart` — Add accelerometer listener, gate GPS behind motion detection
- **MODIFY** `AndroidManifest.xml` — Add `BODY_SENSORS` and `ACTIVITY_RECOGNITION` permissions
- **MODIFY** `pubspec.yaml` — Add `sensors_plus` package for accelerometer access

### Implementation:
1. Add `_accelerometerSubscription` to LocationService
2. On service init, start listening to `TYPE_SIGNIFICANT_MOTION` (Android) or accelerometer stream
3. Gate `_startContinuousGps()` — only call if accelerometer confirms motion
4. In SLEEPING state: GPS OFF, accel watching. On accel trigger → wake GPS → enter ACTIVE
5. In ACTIVE state: if no accel movement for 10s AND no GPS movement for 30s → kill GPS → SLEEPING
6. Hysteresis: require 10s sustained motion before wake, 30s sustained stillness before sleep

### Tests:
- Verify GPS stays OFF when phone is on desk
- Verify GPS wakes within 3s of picking up phone and walking
- Verify no false wakes from pocket vibration

### Dependencies: None (standalone layer)

---

## Phase 2: Auto Hidden Zones (P1)
**Impact: GPS off at home/work/school — 80% of user's day.**

### New Files:
- **CREATE** `lib/services/zone_learning_service.dart` — Dwell detection, clustering, zone management
- **CREATE** `lib/models/learned_zone.dart` — Zone data model with confidence, radius, WiFi fingerprint

### Modified Files:
- **MODIFY** `location_provider.dart` — Check zones before relay, suppress GPS in-zone
- **MODIFY** `location_service.dart` — Register OS geofences for top zones, zone exit → wake GPS
- **MODIFY** `providers.dart` — Add zoneLearningServiceProvider
- **MODIFY** `home_screen.dart` — Initialize zone service on startup
- **MODIFY** `profile_tab.dart` — Add "Learned Places" settings section (view/delete zones)
- **MODIFY** `config.dart` — Add zone learning enable/disable toggle

### Implementation:
1. **ZoneLearningService** class:
   - `_dwellEvents: List<DwellEvent>` — timestamped location+duration records
   - `_learnedZones: List<LearnedZone>` — promoted clusters
   - `onPositionUpdate(lat, lon)` — called from location provider on every fix
   - If same location (100m) for 30+ min → record dwell event
   - If 3+ dwells at same cluster → promote to LearnedZone
   - Persist to SharedPreferences (JSON)
   
2. **LearnedZone** model:
   ```dart
   class LearnedZone {
     String id;
     double lat, lon;
     double radius; // starts 150m, shrinks to 50m
     int visitCount;
     int confidence; // 0-100
     DateTime lastVisit;
     List<String>? wifiBssids; // fingerprint
     String? userLabel; // null = anonymous
   }
   ```

3. **Zone check in location_provider._onPosition()**:
   - If position is inside any learned zone with confidence > 50 → set `inZone = true`
   - If `inZone`: skip relay (zone center already on server), stop GPS after 60s
   - On zone exit (position > zone.radius * 1.2): wake GPS immediately

4. **OS geofence registration**:
   - Top 5 zones by confidence → register with Android GeofencingClient / iOS CLCircularRegion
   - Exit event → `locationService.wake(WakeReason.geofence)` → instant GPS

5. **Settings UI**:
   - "Learned Places" row in profile_tab → shows zones on mini map
   - Tap zone → label it, delete it, adjust radius
   - Master toggle: "Auto-learn places" on/off

### Tests:
- Stay at GPS point for 35 min → dwell recorded
- Return 3 times → zone created
- Enter zone → GPS stops within 60s
- Leave zone → GPS wakes within 5s
- Delete zone → GPS resumes normal tracking at that location

### Dependencies: Phase 1 (accelerometer provides motion context for zone exit)

---

## Phase 3: Batched Background Relay (P1)
**Impact: 5-10x fewer radio wakes in background.**

### New Files:
- **CREATE** `lib/services/relay_buffer.dart` — Accumulates fixes, flushes in batches

### Modified Files:
- **MODIFY** `location_provider.dart` — Replace per-fix relay with buffer flush
- **MODIFY** `ws_service.dart` — Add `sendBatchLocationUpdate()` method
- **MODIFY** `crypto_service.dart` — Accept batch JSON for encryption
- **MODIFY** `point-server/src/ws/handler.rs` — Handle `location.batch_update` message type
- **MODIFY** `models/location_update.dart` — Add batch_id field

### Implementation:
1. **RelayBuffer** class:
   ```dart
   class RelayBuffer {
     List<LocationData> _buffer = [];
     Timer? _flushTimer;
     
     void add(LocationData fix); // add to buffer
     void flush(); // encrypt batch → send → clear
     void startAutoFlush(Duration interval); // 30s for background
   }
   ```

2. **Foreground relay**: unchanged — single fix every 3-5s via WS (already open, no radio cost)

3. **Background relay**: 
   - GPS fires at 10-15s → fix goes into `_buffer`
   - Every 30s OR when buffer has 5+ fixes → flush
   - Flush: `jsonEncode(buffer)` → encrypt → single WS or HTTP send → clear buffer
   - On WiFi: flush immediately (cheaper)

4. **Server handling**:
   - New message type: `location.batch_update` with `positions: [...]` array
   - Handler iterates, stores each as individual history point
   - Broadcasts most recent position to viewers (not the whole batch)
   - Rate limit: count batch as 1 message (not N)

5. **Compression**:
   - Delta-encode: first fix is full, subsequent are deltas from previous
   - Typical batch: 5 positions × 100 bytes delta = 500 bytes (vs 5 × full = 2.5KB)

### Tests:
- Background: verify only 1 network burst per 30s (not per fix)
- Verify all fixes arrive in correct order on server
- Verify viewers see smooth movement from batched data
- WiFi connect → immediate flush

### Dependencies: None (works alongside single relay)

---

## Phase 4: WiFi Fingerprint Zone Presence (P2)
**Impact: Cheap zone confirmation without GPS.**

### New Files:
- **CREATE** `lib/services/wifi_fingerprint_service.dart` — BSSID scanning, fingerprint matching

### Modified Files:
- **MODIFY** `zone_learning_service.dart` — Store WiFi fingerprints per zone
- **MODIFY** `location_service.dart` — Use WiFi fingerprint as presence confirmation
- **MODIFY** `AndroidManifest.xml` — Add `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE` permissions
- **MODIFY** `pubspec.yaml` — Add `network_info_plus` or `wifi_scan` package

### Implementation:
1. **WiFiFingerprintService**:
   - Scan visible WiFi BSSIDs every 30s (when in/near a zone)
   - Hash top-5 BSSIDs by signal strength → 64-bit fingerprint
   - Compare with zone's stored fingerprint → match = "still in zone"
   - Mismatch = "may have left" → trigger GPS for confirmation

2. **Zone fingerprint storage**:
   - When zone is created, record WiFi fingerprint
   - Update fingerprint on each visit (rolling average)
   - Store in LearnedZone model

3. **Cost**: WiFi scan ~200mW for 1s every 30s = ~7mW average (vs GPS at 200-300mW continuous)

### Tests:
- Enter zone → WiFi confirms → GPS stays off
- Walk to different room (same WiFi) → still confirmed
- Leave building → WiFi mismatch → GPS wakes

### Dependencies: Phase 2 (zones must exist first)

---

## Phase 5: Server-Side Interpolation (P2)
**Impact: Smooth viewer experience from sparse background fixes.**

### New Files:
- **CREATE** `point-server/src/api/interpolate.rs` — Interpolation endpoint

### Modified Files:
- **MODIFY** `point-server/src/api/mod.rs` — Register route
- **MODIFY** `point-server/src/db/history.rs` — Add interpolation_source field
- **MODIFY** `point-server/migrations/` — New migration for interpolation metadata

### Implementation:
1. **GET /api/history/{user_id}/interpolated**:
   - Params: `since`, `limit`, `method` (lerp|spline), `density` (points per minute)
   - Fetch raw history points
   - Apply Catmull-Rom spline between points
   - Return dense trajectory with `source: "interpolated"` flag

2. **Real-time interpolation on broadcast**:
   - When relaying a location to viewers, if previous fix was >30s ago, include `interpolation_hint: true`
   - Client uses this to apply heavier lerp smoothing

3. **History metadata**:
   - Each stored point gets `source` field: `gps`, `zone_center`, `interpolated`
   - Trail playback UI shows GPS fixes as dots, interpolated segments as lighter lines

### Tests:
- Request interpolated history → get smooth trajectory from 15s fixes
- Compare with raw history → verify interpolation is reasonable

### Dependencies: Phase 3 (batched relay provides the sparse data to interpolate)

---

## Phase 6: Delta Compression (P3)
**Impact: ~80% smaller payloads.**

### Modified Files:
- **MODIFY** `relay_buffer.dart` — Delta-encode before send
- **MODIFY** `ws_service.dart` — Compress flag
- **MODIFY** `point-server/src/ws/handler.rs` — Delta-decode on receive

### Implementation:
1. First fix in batch: full JSON `{lat, lon, speed, battery, timestamp}`
2. Subsequent: delta from previous `{dlat, dlon, dspeed, dt}` (4 shorts = 8 bytes)
3. Total batch: ~50-100 bytes vs ~500 bytes uncompressed

### Dependencies: Phase 3 (batched relay must exist)

---

## Execution Order

```
Phase 1 (Accel Gate)     ████████░░  ~2 days
Phase 2 (Auto Zones)     ░░████████  ~3 days  
Phase 3 (Batched Relay)  ░░░░████░░  ~1 day
Phase 4 (WiFi FP)        ░░░░░░████  ~2 days
Phase 5 (Server Interp)  ░░░░░░░░██  ~1 day
Phase 6 (Delta Compress)  ░░░░░░░░░█  ~0.5 day
```

Phases 1-3 are independent and can run in parallel.
Phase 4 depends on Phase 2.
Phase 5 depends on Phase 3.
Phase 6 depends on Phase 3.

**Total: ~5-6 days with parallel execution.**
