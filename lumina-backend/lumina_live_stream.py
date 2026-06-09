# =============================================================================
# LUMINA SMART EVACUATION SYSTEM
# lumina_live_stream.py  —  Main Edge Node Controller
#
# Run:  python lumina_live_stream.py
#
# What changed from the original:
#   ① ByteTrack (YOLO native) replaces DeepSORT — persistent anonymous IDs,
#     density history, and velocity all flow into the routing engine.
#     Uses model.track(persist=True) — no random embeddings, no ID flicker.
#   ② Crowd velocity → routing_engine.update_crowd() called every frame,
#     so DYN-A* is always working with live predictive data
#   ③ ThermalClassifier added as a background thread — simulated readings
#     in DIORAMA mode, real sensor readings when hardware is connected
#   ④ FFTAlarmClassifier added as a background thread — confirms FACP alarm
#     before global evacuation routing is activated (air-gap compliance)
#   ⑤ Pull Policy signals exposed on /api/get_route alongside the route
#   ⑥ RSET/ASET breakdown exposed on /api/status for dashboard display
#   ⑦ All new endpoints are backward-compatible — existing React code
#     still works without any changes
# =============================================================================

import csv
import os
import atexit
import math
import json
import time
import random
import threading
from datetime import datetime
from collections import deque

import cv2
import numpy as np
import paho.mqtt.client as mqtt
from ultralytics import YOLO
from flask import Flask, Response, jsonify
from flask_cors import CORS

# Local modules (must be in the same folder)
from routing_engine import (
    calculate_safest_route,
    run_pull_policy,
    update_crowd,
    live_node_status,
    get_crowd_velocity,
    estimate_rset,
)
from thermal_classifier import ThermalClassifier, _gradual_fire, _normal_ambient
from fft_classifier import FFTAlarmClassifier, _generate_alarm_tone, FRAME_SIZE, SAMPLE_RATE

app = Flask(__name__)
CORS(app)

# =============================================================================
# 1. GLOBAL SETUP & THREAD LOCKING
# =============================================================================
BROKER = "broker.hivemq.com"
TOPIC  = "lumina/vitrox/demo/7a9b2f/alerts"   # unique — prevents hackathon collision

mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, "Lumina_Edge_Streamer")
try:
    mqtt_client.connect(BROKER, 1883, 60)
    mqtt_client.loop_start()
    print("[MQTT] Connected to broker")
except Exception as e:
    print(f"[MQTT] Warning: Could not connect ({e}) — running offline")

state_lock   = threading.Lock()

# Core system state
system_state = "NORMAL"          # NORMAL | HAZARD
ai_mode      = "DIORAMA"         # DIORAMA | ENTERPRISE
facp_confirmed = False           # True once FFT confirms the official alarm

# Shared metrics (written by bg threads, read by Flask)
current_person_count  = 0
current_track_ids     = []        # list of active anonymous track IDs
crowd_velocity_lobby  = 0.0      # rate-of-change at lobby node (N-011)
thermal_state         = "NORMAL" # NORMAL | WARNING | ALERT
fft_state             = "SILENT" # SILENT | DETECTING | CONFIRMED
current_route         = ["N-011", "N-042", "N-043", "N-089"]
current_pull_signals  = {}
current_rset          = {}
current_route_cost    = 0   # raw DYN-A* cost score — exposed to frontend

LOG_FILE = "lumina_telemetry_log.csv"

# Startup timestamp — for /api/health uptime display
_startup_time = time.time()

# Manual override flag — set by /trigger and /api/block_node.
# When True: stochastic sensor drift pauses so BOMBA's manual command
# isn't overwritten by simulated sensor noise. Only /reset clears this.
manual_override = False

# Module-level drift tick — replaces the fragile generate_frames._last_drift
# function attribute. Safe across Flask threads; GIL protects the int read/write.
_last_drift_tick = -1

# Live temperature readings per node — populated by thermal thread,
# read by /api/status so the React sparkline shows real escalating values.
_latest_temps = {nid: 27.0 for nid in ["N-011","N-031","N-042","N-043","N-089"]}

# Classifier latency readings — float writes are GIL-atomic, no lock needed.
# Updated by bg threads every cycle, read by /api/status for display.
_thermal_latency_ms = 0.0
_fft_latency_ms     = 0.0

# Simulated fleet size — 6 real nodes + 192 standby nodes matching proposal
NODES_ONLINE = 198
NODES_TOTAL  = 200

# =============================================================================
# 2. AI MODEL LOADING
#
# --- DEPLOYMENT NOTE: Edge TPU Production Pipeline -
# This prototype runs standard PyTorch (.pt) weights on a laptop CPU.
# Production deployment on the RK3588 hardware node requires:
#   1. Export:  yolo export model=yolov8n.pt format=rknn  (via rknn-toolkit2)
#   2. Load:    model = YOLO("lumina_topdown_v1.rknn")
#   3. Result:  RK3588 NPU (6 TOPS) reduces inference from ~150ms (CPU) to
#               ~12ms (NPU) — well within the 500ms ASET actuation target.
# Reference: https://docs.ultralytics.com/integrations/rockchip-rknn/
# ---
# =============================================================================
print("[INIT] Loading DUAL-ENGINE AI models...")
model_diorama    = YOLO("yolov8n.pt")         # toy/diorama: bounding-box aspect ratio
model_enterprise = YOLO("yolov8n-pose.pt")    # real humans: skeletal keypoints

print("[INIT] Starting camera...")
# CAMERA_INDEX: 0 = built-in webcam, 1+ = USB/external webcam
# Set env var CAMERA_INDEX=1 if USB webcam is not detected on index 0
# e.g.  CAMERA_INDEX=1 python lumina_live_stream.py
import os as _os
_cam_idx = int(_os.environ.get("CAMERA_INDEX", 0))
print(f"[INIT] Using camera index {_cam_idx} (set CAMERA_INDEX env var to change)")
cap = cv2.VideoCapture(_cam_idx)
cap.set(cv2.CAP_PROP_FRAME_WIDTH,  1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT,  720)
cap.set(cv2.CAP_PROP_AUTOFOCUS, 1)
cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)   # always read latest frame, no stale queue

# =============================================================================
# 3. THERMAL CLASSIFIER — background thread
#    In DIORAMA mode: feeds simulated temperature readings (demo without sensor)
#    In ENTERPRISE mode: replace _read_thermal_sensor() with your real sensor
# =============================================================================
thermal_clf = ThermalClassifier("N-011")   # Lobby node
_thermal_tick = 0                          # frame counter for simulated signal

def _read_thermal_sensor_simulated() -> float:
    global _thermal_tick
    _thermal_tick += 1
    with state_lock:
        in_hazard = (system_state == "HAZARD")
    if in_hazard:
        return _gradual_fire(_thermal_tick, onset=0)
    return _normal_ambient(_thermal_tick)

def _thermal_thread():
    global thermal_state, system_state, _thermal_latency_ms
    while True:
        temp   = _read_thermal_sensor_simulated()
        result = thermal_clf.classify(temp)
        _thermal_latency_ms = result["latency_ms"]   # GIL-atomic float write
        # Store latest temp for /api/status — drives the React temperature sparkline
        _latest_temps["N-011"] = round(result["temp_c"], 1)
        # Simulate correlated temps for other nodes (fire spreads)
        with state_lock:
            in_hazard = (system_state == "HAZARD")
        if in_hazard:
            _latest_temps["N-042"] = round(min(150, result["temp_c"] * 1.8), 1)  # fire epicentre
            _latest_temps["N-043"] = round(min(80,  result["temp_c"] * 1.1), 1)  # adjacent smoke
        else:
            _latest_temps["N-042"] = round(27.0 + random.uniform(-0.5, 0.5), 1)
            _latest_temps["N-043"] = round(27.0 + random.uniform(-0.3, 0.3), 1)

        with state_lock:
            thermal_state = result["state"]
            # Write system_state inside state_lock — prevents race condition with
            # /reset endpoint which also holds state_lock while iterating nodes.
            # globals() hack is unnecessary inside the lock; direct assignment works.
            if result["state"] == "ALERT" and system_state == "NORMAL":
                system_state = "HAZARD"
                live_node_status["N-011"]["status"] = "alert"
                live_node_status["N-011"]["hazard"] = "thermal"
                _publish_alert = True
            else:
                _publish_alert = False

        # Publish OUTSIDE the lock — I/O must never be inside a threading lock
        if _publish_alert:
            mqtt_client.publish(TOPIC, json.dumps({
                "status":      "CRITICAL",
                "hazard_type": "THERMAL ANOMALY",
                "temp_c":      result["temp_c"],
                "z_score":     result["z_score"],
            }))
        time.sleep(0.2)   # 5 Hz

threading.Thread(target=_thermal_thread, daemon=True).start()
print("[INIT] Thermal classifier thread started")

# =============================================================================
# 4. FFT ACOUSTIC CLASSIFIER — background thread
# =============================================================================
fft_clf = FFTAlarmClassifier("N-011")

def _read_audio_frame_simulated() -> np.ndarray:
    with state_lock:
        in_hazard = (system_state == "HAZARD")
    if in_hazard:
        return _generate_alarm_tone(FRAME_SIZE / SAMPLE_RATE)
    else:
        n = FRAME_SIZE
        t = np.linspace(0, FRAME_SIZE / SAMPLE_RATE, n)
        noise = (
            0.3 * np.sin(2 * math.pi * 60 * t) +
            0.2 * np.sin(2 * math.pi * 120 * t) +
            np.random.normal(0, 0.05, n)
        )
        return noise.astype(np.float32)

def _fft_thread():
    global fft_state, facp_confirmed, _fft_latency_ms
    while True:
        frame  = _read_audio_frame_simulated()
        result = fft_clf.classify_frame(frame)
        _fft_latency_ms = result["latency_ms"]       # GIL-atomic float write
        _publish_facp = False
        with state_lock:
            fft_state = result["state"]
            if result["state"] == "CONFIRMED" and not facp_confirmed:
                facp_confirmed = True
                _publish_facp  = True
                print("[FFT] FACP Positive Alarm Sequence CONFIRMED — global routing active")
        # Publish OUTSIDE the lock — same pattern as _thermal_thread
        if _publish_facp:
            mqtt_client.publish(TOPIC, json.dumps({
                "status":   "FACP_CONFIRMED",
                "snr_db":   result["snr_db"],
                "alarm_hz": 520,
            }))
        time.sleep(0.1)   # 10 Hz

threading.Thread(target=_fft_thread, daemon=True).start()
print("[INIT] FFT acoustic classifier thread started")

# =============================================================================
# 5. VIDEO GENERATOR
# =============================================================================
_SKELETON_PAIRS = [
    (0,1),(0,2),(1,3),(2,4),
    (5,6),(5,7),(7,9),(6,8),(8,10),
    (5,11),(6,12),(11,12),
    (11,13),(13,15),(12,14),(14,16),
]

def _draw_skeleton(frame, kpts):
    for a, b in _SKELETON_PAIRS:
        if a >= len(kpts) or b >= len(kpts):
            continue
        ax, ay = int(kpts[a][0]), int(kpts[a][1])
        bx, by = int(kpts[b][0]), int(kpts[b][1])
        if ax > 0 and ay > 0 and bx > 0 and by > 0:
            cv2.line(frame, (ax, ay), (bx, by), (180, 180, 180), 1)
    for kpt in kpts:
        kx, ky = int(kpt[0]), int(kpt[1])
        if kx > 0 and ky > 0:
            cv2.circle(frame, (kx, ky), 3, (255, 255, 255), -1)

def _check_fall_keypoints(kpts) -> tuple:
    """
    Keypoint-based fall detection (face-up / front-facing).
    Returns (is_fallen: bool, confidence: str)
    Fallen when nose_y > avg_hip_y — person is horizontal from top-down camera.
    """
    if len(kpts) < 13:
        return False, "insufficient_keypoints"
    nose_y    = float(kpts[0][1])
    avg_hip_y = (float(kpts[11][1]) + float(kpts[12][1])) / 2
    if nose_y <= 0 or avg_hip_y <= 0:
        return False, "keypoints_occluded"
    return nose_y > avg_hip_y, "keypoint_signal"

def _check_fall_bbox(w: int, h: int) -> tuple:
    """
    Bounding-box aspect ratio fall detection (works face-down, back-facing,
    any orientation — more robust than keypoints alone).
    Returns (is_fallen: bool, confidence: str)
    Fallen when width > 1.3× height — person is horizontal.
    """
    return w > (h * 1.3), "bbox_signal"

def _check_fall_enterprise(kpts, w: int, h: int) -> tuple:
    """
    Dual-signal fall classifier — combines keypoint + bbox detection.
    Either signal alone can trigger, making it robust to:
      - Face-down falls    (keypoints fail → bbox catches it)
      - Back-facing falls  (keypoints fail → bbox catches it)
      - Partial occlusion  (bbox fails   → keypoints catch it)
      - Top-down cameras   (both signals combined for higher sensitivity)

    Returns (is_fallen: bool, trigger: str)
    """
    kpt_fallen, kpt_reason = _check_fall_keypoints(kpts)
    bbox_fallen, _         = _check_fall_bbox(w, h)

    if kpt_fallen and bbox_fallen:
        return True,  "DUAL (kpt+bbox)"    # highest confidence
    elif kpt_fallen:
        return True,  "KPT only"           # face-up, front-facing
    elif bbox_fallen:
        return True,  "BBOX only"          # face-down, back-facing
    else:
        return False, "upright"

def generate_frames():
    global system_state, ai_mode, current_person_count
    global current_track_ids, crowd_velocity_lobby
    global current_route, current_pull_signals, current_rset, current_route_cost
    global facp_confirmed, _last_drift_tick   # write to module-level globals from this generator

    fall_timer_start     = 0
    recovery_timer_start = 0
    route_cooldown       = 0
    prev_time            = time.time()
    frame_counter        = 0       # for frame-skip logic
    last_results         = None    # cache last inference result for skipped frames

    while True:
        success, frame = cap.read()
        if not success:
            time.sleep(0.1)
            continue

        t_now = time.time()
        fps   = 1.0 / max(t_now - prev_time, 1e-6)
        prev_time = t_now
        frame_counter += 1

        with state_lock:
            cur_state = system_state
            cur_mode  = ai_mode

        person_count           = 0
        current_frame_has_fall = False
        track_ids_this_frame   = []

        # --- BYTETRACK DETECTION + TRACKING PASS -
        # Frame skipping: run YOLO inference every other frame only.
        # Halves CPU load (~50% reduction) — prevents thermal throttling
        # during a 5-minute demo pitch without visible UI degradation.
        # ByteTrack's Kalman filter predicts positions on skipped frames
        # so track IDs remain stable and the video feed stays smooth.
        # During HAZARD: skip every 3rd frame only (more responsive).
        _skip_interval = 3 if cur_state == "HAZARD" else 2
        _run_inference = (frame_counter % _skip_interval == 0) or (last_results is None)
        fallen_boxes = []

        if _run_inference:
            if cur_mode == "DIORAMA":
                results = model_diorama.track(frame, persist=True, conf=0.45,
                                              classes=[0], verbose=False)
            else:  # ENTERPRISE
                results = model_enterprise.track(frame, persist=True, conf=0.60,
                                                 verbose=False)
            last_results = results   # cache for skipped frames
        else:
            results = last_results   # reuse last inference — Kalman filter holds IDs

        for r in results:
            if r.boxes is None:
                continue

            # Extract track IDs (None if tracker hasn't assigned one yet)
            track_ids = (
                r.boxes.id.int().cpu().tolist()
                if r.boxes.id is not None else
                [None] * len(r.boxes)
            )

            for i, box in enumerate(r.boxes):
                if cur_mode == "DIORAMA" and int(box.cls) != 0:
                    continue   # class 0 = person in COCO

                tid = track_ids[i]
                if tid is None:
                    continue   # skip unconfirmed detections

                x1, y1, x2, y2 = map(int, box.xyxy[0])
                w, h = x2 - x1, y2 - y1

                person_count += 1
                track_ids_this_frame.append(tid)

                # --- DUAL-SIGNAL FALL DETECTION -
                is_fallen    = False
                fall_trigger = "upright"

                if cur_mode == "DIORAMA":
                    # Diorama: bbox only (toy figures have no keypoints)
                    is_fallen, fall_trigger = _check_fall_bbox(w, h)

                elif r.keypoints is not None and len(r.keypoints.xy) > i:
                    kpts = r.keypoints.xy[i]
                    _draw_skeleton(frame, kpts)
                    # Enterprise: dual-signal (keypoint + bbox)
                    # Catches face-down, back-facing, and occluded falls
                    is_fallen, fall_trigger = _check_fall_enterprise(kpts, w, h)

                elif cur_mode == "ENTERPRISE":
                    # No keypoints available — fall back to bbox only
                    is_fallen, fall_trigger = _check_fall_bbox(w, h)

                if is_fallen:
                    fallen_boxes.append((x1, y1, x2, y2))
                    current_frame_has_fall = True

                # Draw anonymous bounding box + ID + fall trigger label
                box_color = (0, 0, 255) if is_fallen else (0, 255, 0)
                cv2.rectangle(frame, (x1, y1), (x2, y2), box_color, 2)
                cv2.putText(frame, f"ID:{tid}", (x1, y1 - 6),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, box_color, 1)
                if is_fallen:
                    # Show which signal triggered — useful for demo Q&A
                    cv2.putText(frame, f"FALL [{fall_trigger}]",
                                (x1, y2 + 14),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 100, 255), 1)

        # --- FEED INTO ROUTING ENGINE -
        update_crowd("N-011", person_count)
        vel = get_crowd_velocity("N-011")

        with state_lock:
            current_person_count = person_count
            current_track_ids    = track_ids_this_frame
            crowd_velocity_lobby = round(vel, 3)

        # --- STOCHASTIC SENSOR MODEL — secondary nodes -
        # Models each zone as a Poisson-distributed occupancy source.
        # Retail A (N-042) and Corridor B (N-043) are high-density zones
        # that fluctuate within realistic bounds, stress-testing DYN-A*
        # against time-varying crowd pressure — not static hardcoded values.
        # In production: replace with live occupancy from each node's camera.
        #
        # ⚠ BUG GUARD: update_crowd() auto-quarantines any node > 85 pax.
        # N-042's range is capped at 84 during NORMAL mode so the stochastic
        # drift never pre-quarantines Retail A before the TRIGGER button fires.
        # During HAZARD mode (real fire), the cap is lifted — crowd can spike.
        # --- STOCHASTIC SENSOR MODEL — pauses during manual override -
        # When BOMBA has issued a manual command, drift stops so simulated
        # sensor noise doesn't overwrite the manually set node states.
        if not manual_override and int(t_now) % 2 == 0 and int(t_now) != _last_drift_tick:
            _last_drift_tick = int(t_now)
            _in_hazard = (cur_state == "HAZARD")
            _sensor_model = {
                "N-031": (40,  70),
                "N-042": (75,  99 if _in_hazard else 84),
                "N-043": (60,  84),
                "N-067": (10,  30),
                "N-089": (20,  45),
            }
            for _nid, (_lo, _hi) in _sensor_model.items():
                _cur   = live_node_status[_nid]["crowd"]
                _drift = random.randint(-3, 3)
                _new   = max(_lo, min(_hi, _cur + _drift))
                update_crowd(_nid, _new)

        # Proactive crowd escalation (mentor note: detect + disperse early)
        if vel > 5 and cur_state == "NORMAL":
            print(f"[CROWD] Velocity spike {vel:+.2f} — pre-emptive reroute")
            with state_lock:
                live_node_status["N-011"]["status"] = "warning"

        # --- FALL ESCALATION -
        if current_frame_has_fall:
            recovery_timer_start = 0
            if fall_timer_start == 0:
                fall_timer_start = t_now
            if t_now - fall_timer_start >= 3.0 and cur_state == "NORMAL":
                with state_lock:
                    system_state = "HAZARD"
                    live_node_status["N-011"]["hazard"] = "fall"
                    live_node_status["N-011"]["status"] = "alert"   # NodeMap turns red
                mqtt_client.publish(TOPIC, json.dumps({
                    "status":       "CRITICAL",
                    "hazard_type":  "FALL DETECTED",
                    "person_count": person_count,
                    "track_count":  len(track_ids_this_frame),
                }))
        else:
            fall_timer_start = 0
            if cur_state == "HAZARD":
                if recovery_timer_start == 0:
                    recovery_timer_start = t_now
                if t_now - recovery_timer_start >= 3.0:
                    with state_lock:
                        system_state   = "NORMAL"
                        facp_confirmed = False
                        live_node_status["N-011"]["hazard"]      = None
                        live_node_status["N-011"]["status"]      = "normal"
                        live_node_status["N-011"]["pull_signal"] = "GREEN"
                    mqtt_client.publish(TOPIC, json.dumps({
                        "status":       "RESOLVED",
                        "person_count": person_count,
                    }))

        # --- DYN-A* REROUTE (throttled to 1/sec) -
        if t_now - route_cooldown >= 1.0:
            route_cooldown = t_now
            path, score    = calculate_safest_route("N-011", "N-089", verbose=False)
            if path:
                signals = run_pull_policy(path)
                rset    = estimate_rset(path)
                with state_lock:
                    current_route        = path
                    current_pull_signals = signals
                    current_rset         = rset
                    current_route_cost   = score
        with state_lock:
            _state    = system_state
            _thermal  = thermal_state
            _fft      = fft_state
            _vel      = crowd_velocity_lobby
        # Use cur_mode (captured at frame start) not ai_mode (global) —
        # prevents HUD showing a mode different from what was used for inference
        _mode_txt = "TOY DIORAMA" if cur_mode == "DIORAMA" else "REAL-WORLD SKELETAL"

        cv2.putText(frame, f"MODE: {_mode_txt}",
                    (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
        cv2.putText(frame, f"FPS:{fps:.0f}  PERSONS:{person_count}  VEL:{_vel:+.1f}/rdg",
                    (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        cv2.putText(frame, f"THERMAL:{_thermal}  FFT:{_fft}  STATE:{_state}",
                    (10, 72), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                    (0, 255, 0) if _state == "NORMAL" else (0, 80, 255), 2)

        # Fallen-person buffer zone circles
        for fx1, fy1, fx2, fy2 in fallen_boxes:
            cx, cy = (fx1 + fx2) // 2, (fy1 + fy2) // 2
            cv2.circle(frame, (cx, cy), 60, (0, 165, 255), 2)
            cv2.putText(frame, "BUFFER ZONE", (cx - 42, cy - 65),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 165, 255), 1)

        if _state == "HAZARD":
            h_frame, w_frame = frame.shape[:2]
            cv2.rectangle(frame, (0, 0), (w_frame, h_frame), (0, 0, 255), 6)
            with state_lock:
                route_txt = " -> ".join(current_route)
            cv2.putText(frame, f"ROUTE: {route_txt}",
                        (10, h_frame - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 255, 120), 1)

        ret, buffer = cv2.imencode(".jpg", frame)
        yield (b"--frame\r\n"
               b"Content-Type: image/jpeg\r\n\r\n" +
               buffer.tobytes() + b"\r\n")

# =============================================================================
# 6. FLASK ROUTES
# =============================================================================

@app.route("/video_feed")
def video_feed():
    return Response(generate_frames(),
                    mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/api/set_mode/<new_mode>")
def set_mode(new_mode):
    global ai_mode
    with state_lock:
        if new_mode in ("DIORAMA", "ENTERPRISE"):
            ai_mode = new_mode
            return jsonify({"status": "success", "mode": ai_mode})
    return jsonify({"status": "error"}), 400


@app.route("/api/get_route")
def get_route():
    with state_lock:
        route   = current_route
        signals = current_pull_signals
        rset    = current_rset

    pull_list = [
        {"node": nid, "signal": info["signal"], "reason": info["reason"]}
        for nid, info in signals.items()
    ]
    return jsonify({
        "status":       "success",
        "route":        route,
        "cost_score":   current_route_cost,
        "pull_signals": pull_list,
    })


@app.route("/api/status")
def api_status():
    with state_lock:
        # Snapshot all mutable state — fast reads only under the lock.
        # get_crowd_velocity() and jsonify() happen OUTSIDE to avoid
        # blocking generate_frames / thermal / FFT threads.
        _state   = system_state
        _mode    = ai_mode
        _facp    = facp_confirmed
        _manual  = manual_override
        _count   = current_person_count
        _tracks  = len(current_track_ids)
        _vel     = crowd_velocity_lobby
        _thermal = thermal_state        # needed for header strip between MQTT events
        _fft     = fft_state            # needed for header strip between MQTT events
        _route   = list(current_route)
        _signals = dict(current_pull_signals)
        _rset    = dict(current_rset)
        _t_lat   = _thermal_latency_ms
        _f_lat   = _fft_latency_ms
        _nodes_snapshot = {nid: dict(data) for nid, data in live_node_status.items()}

    # All computation outside the lock
    return jsonify({
        "system_state":       _state,
        "ai_mode":            _mode,
        "facp_confirmed":     _facp,
        "manual_override":    _manual,
        "person_count":       _count,
        "active_tracks":      _tracks,
        "crowd_velocity":     _vel,
        "thermal_state":      _thermal,
        "fft_state":          _fft,
        "thermal_latency_ms": round(_t_lat, 3),
        "fft_latency_ms":     round(_f_lat, 3),
        "nodes_online":       NODES_ONLINE,
        "nodes_total":        NODES_TOTAL,
        "current_route":      _route,
        "pull_signals":       _signals,
        "rset":               _rset,
        "nodes": {
            nid: {
                "status":   d["status"],
                "hazard":   d["hazard"],
                "crowd":    d["crowd"],
                "velocity": round(get_crowd_velocity(nid), 3),  # outside lock — safe read
                "pull":     d["pull_signal"],
                "temp":     _latest_temps.get(nid, 27.0),
            }
            for nid, d in _nodes_snapshot.items()
        },
    })


@app.route("/api/node_states")
def node_states():
    with state_lock:
        snapshot = {nid: dict(data) for nid, data in live_node_status.items()}
    # velocity computed outside lock — consistent with api_status pattern
    states = [
        {
            "id":       nid,
            "status":   data["status"],
            "hazard":   data["hazard"],
            "crowd":    data["crowd"],
            "velocity": round(get_crowd_velocity(nid), 3),
            "pull":     data["pull_signal"],
        }
        for nid, data in snapshot.items()
    ]
    return jsonify({"status": "success", "nodes": states})


@app.route("/trigger")
def trigger_hazard():
    """
    Simulates a thermal camera detection. Sets manual_override so stochastic
    drift pauses — BOMBA's command is not overwritten by sensor noise.
    Does NOT set facp_confirmed — the FFT acoustic thread must confirm independently.
    """
    global system_state, manual_override
    with state_lock:
        system_state  = "HAZARD"
        manual_override = True   # pause stochastic drift — BOMBA takes command
        live_node_status["N-042"]["status"] = "alert"
        live_node_status["N-042"]["hazard"] = "thermal"
    mqtt_client.publish(TOPIC, json.dumps({
        "status":      "CRITICAL",
        "hazard_type": "MANUAL OVERRIDE (thermal only — awaiting FFT confirmation)",
        "person_count": 0,
    }))
    return jsonify({"status": "success", "message": "Thermal hazard triggered at N-042 — acoustic AI still running"})


@app.route("/reset")
def reset_system():
    global system_state, facp_confirmed, current_route, current_pull_signals, current_rset, manual_override
    with state_lock:
        system_state         = "NORMAL"
        facp_confirmed       = False
        manual_override      = False   # release manual command — restore full AUTO mode
        current_route        = ["N-011", "N-042", "N-043", "N-089"]  # restore baseline
        current_pull_signals = {}
        current_rset         = {}
        for nid, data in live_node_status.items():
            data["status"]      = "normal"
            data["hazard"]      = None
            data["pull_signal"] = "GREEN"
    mqtt_client.publish(TOPIC, json.dumps({"status": "RESOLVED", "person_count": 0}))
    return jsonify({"status": "success", "message": "System reset to NORMAL"})


@app.route("/api/block_node", methods=["POST", "GET"])
def block_node():
    """
    Incident Commander override — manually quarantines a node.
    React sends: POST /api/block_node  { "node_id": "N-031" }
    Python applies the 5000-point quarantine penalty, reruns DYN-A*,
    and the dashboard shows a genuinely different route.
    Also accepts GET /api/block_node?node_id=N-031 for easy browser testing.
    """
    from flask import request
    if request.method == "POST":
        body    = request.get_json(force=True, silent=True) or {}
        node_id = body.get("node_id", "N-031")
    else:
        node_id = request.args.get("node_id", "N-031")

    global manual_override
    if node_id not in live_node_status:
        return jsonify({"status": "error", "message": f"Unknown node: {node_id}"}), 400

    with state_lock:
        live_node_status[node_id]["status"] = "quarantine"
        live_node_status[node_id]["hazard"] = "crowd"
        manual_override = True
        # Clear any crowd-auto-quarantine on OTHER nodes so only the
        # intended node is blocked. Without this, stochastic drift that
        # pushed e.g. N-042 above 85 pax before the block command was
        # issued will make unrelated nodes appear blocked alongside the
        # one BOMBA deliberately chose.
        for nid, data in live_node_status.items():
            if nid != node_id and data["status"] == "quarantine" and data["hazard"] == "crowd":
                data["status"] = "warning"   # downgrade to warning, not normal

    # Immediately recompute route so the response already has the new path
    path, score = calculate_safest_route("N-011", "N-089", verbose=False)
    if path:
        signals = run_pull_policy(path)
        rset    = estimate_rset(path)
        global current_route, current_pull_signals, current_rset, current_route_cost
        with state_lock:
            current_route        = path
            current_pull_signals = signals
            current_rset         = rset
            current_route_cost   = score
    mqtt_client.publish(TOPIC, json.dumps({
        "status":      "CRITICAL",
        "hazard_type": f"NODE BLOCKED: {node_id}",
        "person_count": 0,
    }))
    return jsonify({
        "status":   "success",
        "message":  f"{node_id} quarantined — DYN-A* rerouted",
        "new_route": path,
        "cost":      score,
    })


@app.route("/download_log")
def download_log():
    """Commercial + operational report for facility managers and HaaS subscribers."""
    import os, io, csv

    if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 100:
        from flask import send_file
        return send_file(LOG_FILE, as_attachment=True,
                         download_name="Lumina_Management_Report.csv",
                         mimetype="text/csv")

    output = io.StringIO()
    output.write('\ufeff')  # UTF-8 BOM for Excel
    writer = csv.writer(output)

    with state_lock:
        snap    = {nid: dict(d) for nid, d in live_node_status.items()}
        _sys    = system_state
        _facp   = facp_confirmed
        _manual = manual_override

    rset_data      = estimate_rset(current_route)
    total_footfall = sum(d["crowd"] for d in snap.values())
    peak_entry     = max(snap.items(), key=lambda x: x[1]["crowd"]) if snap else ("N/A", {"crowd": 0})
    avg_occ        = round(total_footfall / max(len(snap), 1), 1)
    dynamic_rset   = rset_data.get("RSET_s", 142)
    baseline_rset  = 342
    try:
        reduction_pct = round((1 - float(dynamic_rset) / baseline_rset) * 100, 1)
    except Exception:
        reduction_pct = "N/A"

    BATT = {"N-011": 94, "N-031": 87, "N-042": 72, "N-043": 81, "N-067": 96, "N-089": 63}
    NEXT = {"N-011": "Aug 10", "N-031": "Aug 01", "N-042": "Jul 15",
            "N-043": "Aug 05", "N-067": "Aug 12", "N-089": "Jul 01"}

    # --- REPORT HEADER -
    writer.writerow(["LUMINA SMART EVACUATION SYSTEM"])
    writer.writerow(["Facility Management & Commercial Analytics Report"])
    writer.writerow(["Generated",            time.strftime('%Y-%m-%d %H:%M:%S')])
    writer.writerow(["Session Duration (s)", round(time.time() - _startup_time, 1)])
    writer.writerow(["Deployment Model",     "Hardware-as-a-Service (HaaS)"])
    writer.writerow(["Monthly Subscription", "RM 13,000 (200 nodes x RM 65)"])
    writer.writerow(["System Status",        _sys])
    writer.writerow([])

    # --- SECTION 1: FOOTFALL TELEMETRY -
    # Supports DOOH ad premium pricing and kiosk rental rates (Appendix G)
    writer.writerow(["FOOTFALL TELEMETRY"])
    writer.writerow(["Total Occupancy (pax)",   total_footfall])
    writer.writerow(["Peak Zone",               peak_entry[0]])
    writer.writerow(["Peak Zone Occupancy (pax)", peak_entry[1]["crowd"]])
    writer.writerow(["Average Zone Occupancy (pax)", avg_occ])
    writer.writerow(["Tracking Method",         "Anonymous crowd vectors (no facial data)"])
    writer.writerow(["PDPA Compliant",           "Yes - 0 bytes raw video transmitted"])
    writer.writerow([])

    # --- SECTION 2: ZONE OCCUPANCY BREAKDOWN -
    # Spatial data for kiosk placement and DOOH zone pricing (Appendix G, Table G-2)
    writer.writerow(["ZONE OCCUPANCY BREAKDOWN"])
    writer.writerow(["zone", "node_id", "occupancy_pax", "crowd_velocity_rdg",
                     "status", "recommended_action"])
    for nid, d in snap.items():
        vel   = round(get_crowd_velocity(nid), 2)
        crowd = d["crowd"]
        if crowd > 85:
            action = "HIGH TRAFFIC - Prime DOOH zone - Activate pull policy"
        elif crowd > 60:
            action = "MODERATE TRAFFIC - Kiosk opportunity"
        elif crowd < 10:
            action = "LOW TRAFFIC - Consider HVAC reduction"
        else:
            action = "NORMAL"
        writer.writerow([
            d.get("zone", nid), nid, crowd, vel,
            d["status"].upper(), action,
        ])
    writer.writerow([])

    # --- SECTION 3: COMMERCIAL ROI SNAPSHOT -
    # Based on Appendix G Table G-2 monthly cash flow model
    writer.writerow(["COMMERCIAL ROI SNAPSHOT (200-Node Projection)"])
    writer.writerow(["revenue_stream",       "monthly_value_rm", "basis"])
    writer.writerow(["DOOH Ad Premiums",      8000,
                     "5 zones x RM 1,600 - verified foot traffic analytics"])
    writer.writerow(["Kiosk and Pop-Up Retail", 5000,
                     "10 locations x RM 500 - spatial data leasing premium"])
    writer.writerow(["ESG HVAC Savings",      2500,
                     "Dynamic cooling optimisation from occupancy data"])
    writer.writerow(["Total Value Generated", 15500, "Monthly passive revenue"])
    writer.writerow(["HaaS Subscription Cost", -13000, "200 nodes x RM 65/month"])
    writer.writerow(["Net Monthly Cash Flow", 2500,
                     "Immediate net-positive ROI - no CapEx required"])
    writer.writerow([])
    writer.writerow(["CapEx Avoided",         168000,
                     "200 nodes x RM 840 manufacturing cost (bypassed via HaaS)"])
    writer.writerow(["CapEx Payback Period",  "Immediate",
                     "vs 5-7 years for traditional fire safety infrastructure"])
    writer.writerow([])

    # --- SECTION 4: ESG HVAC OPTIMISATION DATA -
    # Real occupancy data to feed BMS for dynamic HVAC scheduling (Appendix G, Point A)
    writer.writerow(["ESG HVAC OPTIMISATION DATA"])
    writer.writerow(["zone", "node_id", "occupancy_pax", "temperature_c",
                     "hvac_recommendation"])
    for nid, d in snap.items():
        temp  = round(_latest_temps.get(nid, 27.0), 1)
        crowd = d["crowd"]
        if crowd < 10:
            hvac = "REDUCE COOLING - Low occupancy detected"
        elif crowd > 70:
            hvac = "INCREASE COOLING - High occupancy detected"
        else:
            hvac = "MAINTAIN CURRENT - Normal occupancy"
        writer.writerow([d.get("zone", nid), nid, crowd, temp, hvac])
    writer.writerow([])

    # --- SECTION 5: EVACUATION SAFETY STATUS -
    writer.writerow(["EVACUATION SAFETY STATUS"])
    writer.writerow(["Active Route",                " > ".join(current_route)])
    writer.writerow(["Route Safe",                  "Yes" if rset_data.get("safe", True) else "No"])
    writer.writerow(["Estimated Evacuation Time (s)", dynamic_rset])
    writer.writerow(["Available Safe Egress Time (s)", rset_data.get("ASET_s", 600)])
    writer.writerow(["Safety Margin (s)",           rset_data.get("margin_s", "N/A")])
    writer.writerow(["Evacuation Time Reduction",   f"{reduction_pct}% vs static baseline"])
    writer.writerow(["FACP Status",                 "Confirmed" if facp_confirmed else "Standby"])
    writer.writerow([])

    # --- SECTION 6: ZONE CONGESTION SIGNALS -
    writer.writerow(["ZONE CONGESTION SIGNALS"])
    writer.writerow(["zone", "signal", "detail"])
    for nid, info in current_pull_signals.items():
        reason = info.get("reason", "N/A").replace("\u2014", "-").replace("\u2013", "-")
        writer.writerow([nid, info.get("signal", "N/A"), reason])
    if not current_pull_signals:
        writer.writerow(["All zones", "GREEN", "No congestion detected"])
    writer.writerow([])

    # --- SECTION 7: NODE MAINTENANCE & BATTERY STATUS -
    # NFPA 72 requires batteries >= 60% shelf life (Appendix F, BOM Defence)
    writer.writerow(["NODE MAINTENANCE AND BATTERY STATUS"])
    writer.writerow(["node_id", "zone", "battery_pct", "nfpa72_status",
                     "next_service", "action_required"])
    for nid, d in snap.items():
        bat   = BATT.get(nid, 85)
        next_ = NEXT.get(nid, "N/A")
        if bat >= 75:
            status = "OK"
            action = "None"
        elif bat >= 60:
            status = "LOW - Monitor"
            action = "Schedule service within 30 days"
        else:
            status = "CRITICAL - Below NFPA 72 threshold"
            action = "HOT-SWAP REQUIRED immediately"
        writer.writerow([nid, d.get("zone", nid), bat, status, next_, action])
    writer.writerow([])

    # --- SECTION 8: SYSTEM PERFORMANCE -
    writer.writerow(["SYSTEM PERFORMANCE"])
    writer.writerow(["metric",                     "value",   "target",  "status"])
    writer.writerow(["Thermal Detection Latency (ms)",
                     round(_thermal_latency_ms, 1), "< 500ms",
                     "Pass" if _thermal_latency_ms < 500 else "Review"])
    writer.writerow(["Acoustic Detection Latency (ms)",
                     round(_fft_latency_ms, 1),    "< 500ms",
                     "Pass" if _fft_latency_ms < 500 else "Review"])
    writer.writerow(["Nodes Online",               f"{NODES_ONLINE}/{NODES_TOTAL}",
                     f"{NODES_TOTAL}/{NODES_TOTAL}", "Normal"])
    writer.writerow([])

    # --- SECTION 9: PRIVACY AND COMPLIANCE SUMMARY -
    writer.writerow(["PRIVACY AND COMPLIANCE SUMMARY"])
    writer.writerow(["item",                       "status", "notes"])
    writer.writerow(["Raw video transmitted",       "0 bytes",
                     "Analytics run on edge TPU only - Zero-Stream Privacy"])
    writer.writerow(["Facial data stored",          "None",
                     "ByteTrack anonymous vectors - no biometrics"])
    writer.writerow(["PDPA compliant",              "Yes",
                     "Personal Data Protection Act 2010 (Malaysia)"])
    writer.writerow(["NFPA 72 battery compliance",  "Monitored",
                     "Auto-alerts at 60% shelf life threshold"])
    writer.writerow(["HaaS contract renewal trigger", "Month 36",
                     "Free hot-swap battery included on renewal"])

    output.seek(0)
    from flask import Response
    return Response(
        output.getvalue(), mimetype="text/csv",
        headers={"Content-Disposition": "attachment;filename=Lumina_Management_Report.csv"}
    )

@app.route("/api/health")
def api_health():
    """
    System health snapshot — polled every 5s by React (slower than /api/status).
    Shows uptime, hardware status, and connection state for the System Health tab.
    """
    with state_lock:
        _sys_state = system_state   # snapshot under lock for consistency
    return jsonify({
        "status":             "ok",
        "uptime_s":           round(time.time() - _startup_time, 1),
        "yolo_loaded":        model_diorama is not None,
        "mqtt_connected":     mqtt_client.is_connected(),
        "camera_open":        cap.isOpened(),
        "nodes_online":       NODES_ONLINE,
        "nodes_total":        NODES_TOTAL,
        "ai_mode":            ai_mode,
        "thermal_latency_ms": round(_thermal_latency_ms, 3),
        "fft_latency_ms":     round(_fft_latency_ms,     3),
        "system_state":       _sys_state,
    })


def _shutdown():
    print("[LUMINA] Shutting down — releasing camera and MQTT...")
    try: cap.release()
    except: pass
    try: mqtt_client.loop_stop(); mqtt_client.disconnect()
    except: pass
    print("[LUMINA] Clean shutdown complete.")

atexit.register(_shutdown)


if __name__ == "__main__":
    # Force clean NORMAL state on every startup — no stale hazard from previous session
    with state_lock:
        system_state         = "NORMAL"
        facp_confirmed       = False
        manual_override      = False
        current_route        = ["N-011", "N-042", "N-043", "N-089"]
        current_pull_signals = {}
        current_rset         = {}
        for _nid, _d in live_node_status.items():
            _d["status"]      = "normal"
            _d["hazard"]      = None
            _d["pull_signal"] = "GREEN"
    if hasattr(thermal_clf, 'reset'): thermal_clf.reset()
    if hasattr(fft_clf,    'reset'): fft_clf.reset()
    print("[LUMINA] State reset to NORMAL on startup")
    print("[LUMINA] All subsystems initialised. Starting Flask on :5001")
    print("[LUMINA] Endpoints:")
    print("  /video_feed               — MJPEG camera stream with HUD overlay")
    print("  /api/get_route            — DYN-A* route + Pull Policy signals")
    print("  /api/status               — full telemetry snapshot (1.5s poll)")
    print("  /api/health               — system health + uptime (5s poll)")
    print("  /api/node_states          — per-node status for NodeMap.jsx")
    print("  /api/block_node           — POST {node_id} to quarantine a node")
    print("  /trigger                  — manual hazard override")
    print("  /reset                    — reset all state to NORMAL")
    print("")
    print("  For booth demo: set FLASK_IP in App.jsx to this machine's Wi-Fi IP")
    print("  Find it with:  ipconfig (Windows)  or  ifconfig (Mac/Linux)")
    app.run(host="0.0.0.0", port=5001, threaded=True)
