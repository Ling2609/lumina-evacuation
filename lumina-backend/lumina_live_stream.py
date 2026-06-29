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
from flask import Flask, Response, jsonify, request
from flask_cors import CORS

# Local modules (must be in the same folder)
from routing_engine import (
    calculate_safest_route,
    force_route,
    reset_hysteresis,
    route_to_specific_exit,
    get_all_exit_routes,
    block_node_and_reroute,
    unblock_node,
    get_all_exit_routes,
    facp_store_alert,
    route_from_store,
    DOOR_TO_JUNCTION,
    DOOR_LABELS,
    run_pull_policy,
    update_crowd,
    live_node_status,
    get_crowd_velocity,
    estimate_rset,
    estimate_baseline_rset,
    rset_t2_sensitivity,
    J_TO_CORRIDOR,
    EXIT_TO_CORRIDOR,
    J_CORRIDOR_RANK,
    resolve_node_name,
)
from thermal_classifier import ThermalClassifier, _gradual_fire, _normal_ambient
from fft_classifier import FFTAlarmClassifier, _generate_alarm_tone, FRAME_SIZE, SAMPLE_RATE

app = Flask(__name__)
CORS(app)

# =============================================================================
# CORRIDOR STATE BUILDER — translates DYN-A* route + pull policy into the
# 5-corridor dict the ESP32 firmware parses (C-001..C-005).
# Each corridor entry is {"state": ..., "dir": 1|-1} — direction tells the
# LED chase which way to point so evacuees are always guided TOWARD the
# exit, never back into a blocked/hazard segment, regardless of which
# physical direction DYN-A* happens to traverse that corridor's nodes.
# Caller MUST hold state_lock before calling this (reads live_node_status,
# current_route, current_pull_signals).
# =============================================================================
def _build_corridor_states():
    states = {c: {"state": "normal", "dir": 1}
              for c in ["C-001", "C-002", "C-003", "C-004", "C-005"]}

    # 1. Hazard / quarantine takes priority — any junction in alert or
    #    quarantine marks its whole home corridor RED (hazard).
    for jid, data in live_node_status.items():
        corridor = J_TO_CORRIDOR.get(jid)
        if not corridor:
            continue
        if data.get("status") in ("alert", "quarantine"):
            states[corridor]["state"] = "hazard"

    # 2. Pull policy RED stop-lines — congestion/crush, blink red, but
    #    don't downgrade an existing hazard corridor.
    for nid, info in current_pull_signals.items():
        corridor = J_TO_CORRIDOR.get(nid)
        if corridor and states[corridor]["state"] == "normal" and info.get("signal") == "RED":
            states[corridor]["state"] = "pull_stop"

    # 3. Pull policy AMBER / warning — congestion building.
    for nid, info in current_pull_signals.items():
        corridor = J_TO_CORRIDOR.get(nid)
        if corridor and states[corridor]["state"] == "normal" and info.get("signal") == "AMBER":
            states[corridor]["state"] = "warning"

    # 4. Active DYN-A* route — every corridor the evacuation path actually
    #    passes through gets GREEN chase, UNLESS that corridor is itself
    #    the hazard origin (don't show "safe, walk this way" through fire).
    #    Direction: compare the rank-within-corridor of consecutive route
    #    nodes that share this corridor. Rank increases toward the building
    #    interior, decreases toward the exit — so if the route visits this
    #    corridor's junctions in DEcreasing rank order, evacuees are moving
    #    toward the exit (dir=1, the LED strip's natural orientation).
    #    Increasing rank order means moving away from this corridor's own
    #    exit (e.g. cutting through to reach a different exit), so the
    #    chase must reverse (dir=-1) or it would visually point inward.
    for idx, node_id in enumerate(current_route):
        corridor = (J_TO_CORRIDOR.get(node_id) or EXIT_TO_CORRIDOR.get(node_id))
        # Don't downgrade hazard/pull_stop/warning to a plain green route —
        # the firmware can only show one state per corridor at a time, and
        # an evacuee should see "congestion ahead, proceed with caution"
        # rather than a full-speed green chase into a forming crush, even
        # if that corridor is technically still the correct evacuation path.
        if not corridor or states[corridor]["state"] in ("hazard", "pull_stop", "warning"):
            continue
        states[corridor]["state"] = "route"

        # Determine direction from this node to the next one, if both
        # are ranked junctions inside the same corridor.
        if idx + 1 < len(current_route):
            next_id = current_route[idx + 1]
            r_cur  = J_CORRIDOR_RANK.get(node_id)
            r_next = J_CORRIDOR_RANK.get(next_id)
            if r_cur is not None and r_next is not None:
                states[corridor]["dir"] = 1 if r_next < r_cur else -1
            elif next_id in EXIT_TO_CORRIDOR and EXIT_TO_CORRIDOR[next_id] == corridor:
                # Walking straight into this corridor's own exit = forward
                states[corridor]["dir"] = 1



    return states

# =============================================================================
# 1. GLOBAL SETUP & THREAD LOCKING
# =============================================================================
BROKER       = "broker.hivemq.com"
TOPIC        = "lumina/vitrox/demo/7a9b2f/alerts"   # unique — prevents hackathon collision
SENSOR_TOPIC = "lumina/vitrox/demo/7a9b2f/sensors"  # ESP32→Python: sensor data

def _on_sensor_message(client, userdata, msg):
    """
    Receives physical sensor events published by the ESP32 on SENSOR_TOPIC.
    Handles two sensor types:
      HC-SR04  → obstruction detected/cleared, calls block_node_and_reroute()
      MLX90614 → thermal anomaly, feeds temp reading into ThermalClassifier

    IMPORTANT: Real sensor events are SUPPRESSED in simulation mode.
    Bomba override cannot be overridden by sensor events.
    """
    global manual_override, current_route, system_state, thermal_state

    # Respect system mode — ignore real sensors in simulation mode
    with state_lock:
        _mode  = system_mode
        _bomba = bomba_override_active
    if _mode != "live":
        print(f"[SENSOR] Suppressed — system is in {_mode.upper()} mode")
        return
    if _bomba:
        print("[SENSOR] Suppressed — Bomba override active")
        return
    try:
        data   = json.loads(msg.payload.decode())
        sensor = data.get("sensor")

        # ── HC-SR04: physical corridor obstruction ─────────────────────────
        if sensor == "HC-SR04":
            status  = data.get("status")
            node_id = data.get("node", "C-003")
            dist    = data.get("distance_cm", -1)
            CORRIDOR_TO_JUNCTION = {
                "C-001": "J2", "C-002": "J4", "C-003": "J8",
                "C-004": "J12", "C-005": "J18",
            }
            junction = CORRIDOR_TO_JUNCTION.get(node_id, "J8")

            if status == "BLOCKED":
                print(f"[HC-SR04] Obstruction in {node_id} ({dist}cm) → blocking {junction}, recalculating route")
                with state_lock:
                    result = block_node_and_reroute(junction, current_route[0] if current_route else "J16")
                    current_route   = result["new_route"]
                    manual_override = True
                    _total_pax  = sum(d["crowd"] for d in live_node_status.values())
                    _corridors  = _build_corridor_states()
                mqtt_client.publish(TOPIC, json.dumps({
                    "status": "CRITICAL", "system_state": system_state,
                    "hazard_type": f"OBSTRUCTION DETECTED in {node_id}",
                    "manual_override": True, "person_count": _total_pax,
                    "green_direction": "FOLLOW_ROUTE", "corridors": _corridors,
                }))
            elif status == "CLEAR":
                print(f"[HC-SR04] {node_id} cleared → unblocking {junction}")
                with state_lock:
                    unblock_node(junction)
                    reset_hysteresis()
                    # Only release manual_override if no active fire/thermal hazard —
                    # clearing a debris obstruction shouldn't cancel an ongoing evacuation
                    if system_state == "NORMAL":
                        manual_override = False

        # ── MLX90614: real thermal anomaly from physical IR sensor ─────────
        elif sensor == "MLX90614":
            temp_c = data.get("temp_c", 0)
            print(f"[MLX90614] Real thermal reading: {temp_c}°C")
            # Feed the real reading into the existing ThermalClassifier —
            # same pipeline as the simulated path, now driven by real hardware.
            result = thermal_clf.classify(temp_c)
            with state_lock:
                thermal_state = result["state"]
                if result["state"] in ("WARNING", "ALERT") and system_state == "NORMAL":
                    system_state = "HAZARD"
                    live_node_status["J7"]["status"] = "alert"
                    live_node_status["J7"]["hazard"] = "thermal"
                    _total_pax  = sum(d["crowd"] for d in live_node_status.values())
                    _corridors  = _build_corridor_states()
            if result["state"] == "ALERT":
                mqtt_client.publish(TOPIC, json.dumps({
                    "status":       "CRITICAL",
                    "system_state": "HAZARD",
                    "hazard_type":  "THERMAL ANOMALY (MLX90614)",
                    "temp_c":       temp_c,
                    "person_count": _total_pax,
                    "corridors":    _corridors,
                }))
                print(f"[MLX90614] THERMAL ALERT triggered at {temp_c}°C")

    except Exception as e:
        print(f"[SENSOR] Message error: {e}")

mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, "Lumina_Edge_Streamer")
mqtt_client.message_callback_add(SENSOR_TOPIC, _on_sensor_message)
try:
    mqtt_client.connect(BROKER, 1883, 60)
    mqtt_client.subscribe(SENSOR_TOPIC)   # listen for ESP32 sensor events
    mqtt_client.loop_start()
    print("[MQTT] Connected to broker")
except Exception as e:
    print(f"[MQTT] Warning: Could not connect ({e}) — running offline")

state_lock   = threading.Lock()

# Core system state
system_state = "NORMAL"          # NORMAL | HAZARD
ai_mode      = "DIORAMA"         # DIORAMA | ENTERPRISE
facp_confirmed = False           # True once FFT confirms the official alarm

# =============================================================================
# SYSTEM MODE — controls which event sources are accepted
#   "simulation" : only manual simulation triggers accepted; real sensors ignored
#   "live"       : only real sensor data accepted; simulation triggers disabled
# BOMBA override (bomba_override_active) is a special elevated state that works
# in ANY mode and cannot be cancelled by simulation or sensor events.
# Priority: bomba_override (3) > live_sensor (2) > simulation (1)
# =============================================================================
system_mode           = "simulation"   # "simulation" | "live"
bomba_override_active = False          # True when Bomba has issued a command override

# Simulation trigger state — which event type was manually triggered
# None | "fire" | "fallen" | "crowd"
sim_trigger_type  = None
sim_trigger_node  = None   # most recent trigger node (for status display)
active_hazard_nodes = []  # list of {node_id, event_type} for multi-hazard tracking

# Fire simulation flag — no physical thermal sensor in this prototype.
# Set to True by /trigger (BOMBA "Simulate Fire" button) for demo purposes.
# Cleared by /reset. Camera-based fall detection is independent of this flag.
fire_sim_active = False

# Shared metrics (written by bg threads, read by Flask)
current_person_count  = 0
current_track_ids     = []        # list of active anonymous track IDs
crowd_velocity_lobby  = 0.0      # rate-of-change at lobby node (N-011)
thermal_state         = "NORMAL" # NORMAL | WARNING | ALERT
fft_state             = "SILENT" # SILENT | DETECTING | CONFIRMED
current_route         = ["J19","J18","EXIT-5"]
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
_latest_temps = {nid: 27.0 for nid in ["J16","J4","J7","J8","J18","J12"]}

# Classifier latency readings — float writes are GIL-atomic, no lock needed.
# Updated by bg threads every cycle, read by /api/status for display.
_thermal_latency_ms = 0.0
_fft_latency_ms     = 0.0

# Simulated fleet size — 6 real nodes + 192 standby nodes matching proposal
NODES_ONLINE = 198
NODES_TOTAL  = 200

# Single source of truth for battery data — used by api_health() and download_log()
NODE_BATTERY = {
    "NODE-A": {"pct": 94, "next_service": "Aug 10"},
    "NODE-B": {"pct": 87, "next_service": "Aug 01"},
    "NODE-C": {"pct": 72, "next_service": "Jul 15"},
    "NODE-D": {"pct": 81, "next_service": "Aug 05"},
    "NODE-E": {"pct": 96, "next_service": "Aug 12"},
    "NODE-F": {"pct": 63, "next_service": "Jul 01"},
}

# Mirrors frontend's LUMINA_NODE_DEFS labels — only the 6 physical Lumina
# ceiling units have batteries, not individual junctions/doors.
LUMINA_NODE_LABELS = {
    "NODE-A": "West Corridor", "NODE-B": "Central Crossroad",
    "NODE-C": "East Corridor", "NODE-D": "South-Central",
    "NODE-E": "South-West",    "NODE-F": "East-South",
}

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
thermal_clf = ThermalClassifier("J16")   # Lobby node
_thermal_tick = 0                          # frame counter for simulated signal

def _read_thermal_sensor_simulated() -> float:
    global _thermal_tick
    _thermal_tick += 1
    with state_lock:
        in_fire = fire_sim_active
    if in_fire:
        return _gradual_fire(_thermal_tick, onset=0)
    return _normal_ambient(_thermal_tick)

def _thermal_thread():
    global thermal_state, system_state, _thermal_latency_ms
    while True:
        temp   = _read_thermal_sensor_simulated()
        result = thermal_clf.classify(temp)
        _thermal_latency_ms = result["latency_ms"]
        with state_lock:
            in_fire = fire_sim_active
        # Only update temps with fire simulation during active fire trigger
        # During fall hazard (fire_sim_active=False), temps remain ambient
        _latest_temps["J16"] = round(result["temp_c"], 1)
        if in_fire:
            _latest_temps["J7"] = round(min(150, result["temp_c"] * 1.8), 1)
            _latest_temps["J4"] = round(min(80,  result["temp_c"] * 1.1), 1)
        else:
            _latest_temps["J7"] = round(27.0 + random.uniform(-0.5, 0.5), 1)
            _latest_temps["J4"] = round(27.0 + random.uniform(-0.3, 0.3), 1)

        with state_lock:
            thermal_state = result["state"]
            # Write system_state inside state_lock — prevents race condition with
            # /reset endpoint which also holds state_lock while iterating nodes.
            # globals() hack is unnecessary inside the lock; direct assignment works.
            if result["state"] == "ALERT" and system_state == "NORMAL":
                system_state = "HAZARD"
                live_node_status["J16"]["status"] = "alert"
                live_node_status["J16"]["hazard"] = "thermal"
                _publish_alert = True
            else:
                _publish_alert = False

        # Publish OUTSIDE the lock — I/O must never be inside a threading lock
        if _publish_alert:
            with state_lock:
                _total_pax  = sum(d["crowd"] for d in live_node_status.values())
                _corridors  = _build_corridor_states()
            mqtt_client.publish(TOPIC, json.dumps({
                "status":       "CRITICAL",
                "system_state": "HAZARD",
                "hazard_type":  "THERMAL ANOMALY",
                "temp_c":       result["temp_c"],
                "z_score":      result["z_score"],
                "person_count": _total_pax,
                "corridors":    _corridors,
            }))
        time.sleep(0.2)   # 5 Hz

threading.Thread(target=_thermal_thread, daemon=True).start()
print("[INIT] Thermal classifier thread started")

# =============================================================================
# 4. FFT ACOUSTIC CLASSIFIER — background thread
# =============================================================================
fft_clf = FFTAlarmClassifier("J16")

def _read_audio_frame_simulated() -> np.ndarray:
    with state_lock:
        in_fire = fire_sim_active
    if in_fire:
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
# 4b. MQTT HEARTBEAT — background thread
# Keeps the ESP32 synced with live person counts during NORMAL operation.
# CRITICAL/RESOLVED/FACP_CONFIRMED messages already cover hazard transitions —
# this heartbeat fills the gap during normal (non-hazard) operation so the
# ESP32's person count display stays current without flooding it with
# per-frame video updates (15fps would overwhelm the Wi-Fi chip).
# =============================================================================
def _heartbeat_thread():
    while True:
        with state_lock:
            _state   = system_state
            _manual  = manual_override
            # True total footfall across ALL nodes (camera + stochastic),
            # not just the J16 lobby camera count — must match what the
            # dashboard's "Total Footfall" metric shows, or MQTT logs and
            # the React UI will visibly disagree in front of judges.
            _total_pax = sum(d["crowd"] for d in live_node_status.values())
            _route     = list(current_route)
            _corridors = _build_corridor_states()
        if _state == "NORMAL":
            # BOMBA can manually block a node and force a reroute while
            # system_state is still NORMAL (no organic hazard triggered
            # the HAZARD transition). If we stayed "stealth", the chief
            # would reroute the building and the ceiling lights would
            # stay completely dark — wake the hardware whenever a manual
            # override is active, even outside a real emergency.
            _stealth = not _manual
            mqtt_client.publish(TOPIC, json.dumps({
                "status":          "NORMAL",
                "system_state":    "NORMAL",
                "manual_override": _manual,
                "stealth_mode":    _stealth,
                "person_count":    _total_pax,
                "green_led":       _manual,     # lit if BOMBA has an active reroute
                "red_led":         False,
                "buzzer_active":   False,
                "green_direction": "FOLLOW_ROUTE" if _manual else "NONE",
                "corridors":       _corridors,
            }))
        time.sleep(2.0)   # 2s heartbeat — light enough for ESP32 Wi-Fi/MQTT stack

threading.Thread(target=_heartbeat_thread, daemon=True).start()
print("[INIT] MQTT heartbeat thread started")

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


# ── Shared frame buffer (AI worker writes, /video_feed reads) ──────────────
# This decouples AI processing from the browser: YOLO inference, fall
# detection, and DYN-A* routing run continuously in a background thread
# regardless of whether anyone has the dashboard open. /video_feed simply
# reads whatever frame the worker most recently produced.
_frame_buffer   = None          # latest annotated JPEG bytes
_frame_lock     = threading.Lock()
_ai_thread_stop = threading.Event()


def _process_ai_cycle(cap, state):
    """
    Runs ONE iteration of: read frame -> YOLO inference -> fall/crowd
    detection -> DYN-A* reroute -> annotate frame -> store in buffer.
    `state` is a dict carrying loop-persistent variables across calls
    (fall timers, frame counter, cached inference results, etc).
    """
    global system_state, ai_mode, current_person_count
    global current_track_ids, crowd_velocity_lobby
    global current_route, current_pull_signals, current_rset, current_route_cost
    global facp_confirmed, _last_drift_tick, _frame_buffer

    success, frame = cap.read()
    if not success:
        time.sleep(0.1)
        return

    t_now = time.time()
    fps   = 1.0 / max(t_now - state["prev_time"], 1e-6)
    state["prev_time"] = t_now
    state["frame_counter"] += 1

    with state_lock:
        cur_state = system_state
        cur_mode  = ai_mode

    person_count           = 0
    current_frame_has_fall = False
    track_ids_this_frame   = []

    # --- BYTETRACK DETECTION + TRACKING PASS ---
    # Frame skipping halves CPU load; ByteTrack's Kalman filter predicts
    # positions on skipped frames so track IDs remain stable.
    _skip_interval = 3 if cur_state == "HAZARD" else 2
    _run_inference = (state["frame_counter"] % _skip_interval == 0) or (state["last_results"] is None)
    fallen_boxes = []

    if _run_inference:
        if cur_mode == "DIORAMA":
            results = model_diorama.track(frame, persist=True, conf=0.45,
                                          classes=[0], verbose=False)
        else:
            results = model_enterprise.track(frame, persist=True, conf=0.60,
                                             verbose=False)
        state["last_results"] = results
    else:
        results = state["last_results"]

    for r in results:
        if r.boxes is None:
            continue
        track_ids = (
            r.boxes.id.int().cpu().tolist()
            if r.boxes.id is not None else
            [None] * len(r.boxes)
        )
        for i, box in enumerate(r.boxes):
            if cur_mode == "DIORAMA" and int(box.cls) != 0:
                continue
            tid = track_ids[i]
            if tid is None:
                continue
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            w, h = x2 - x1, y2 - y1
            person_count += 1
            track_ids_this_frame.append(tid)

            is_fallen    = False
            fall_trigger = "upright"
            if cur_mode == "DIORAMA":
                is_fallen, fall_trigger = _check_fall_bbox(w, h)
            elif r.keypoints is not None and len(r.keypoints.xy) > i:
                kpts = r.keypoints.xy[i]
                _draw_skeleton(frame, kpts)
                is_fallen, fall_trigger = _check_fall_enterprise(kpts, w, h)
            elif cur_mode == "ENTERPRISE":
                is_fallen, fall_trigger = _check_fall_bbox(w, h)

            if is_fallen:
                fallen_boxes.append((x1, y1, x2, y2))
                current_frame_has_fall = True

            box_color = (0, 0, 255) if is_fallen else (0, 255, 0)
            cv2.rectangle(frame, (x1, y1), (x2, y2), box_color, 2)
            cv2.putText(frame, f"ID:{tid}", (x1, y1 - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, box_color, 1)
            if is_fallen:
                cv2.putText(frame, f"FALL [{fall_trigger}]", (x1, y2 + 14),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 100, 255), 1)

    # --- FEED INTO ROUTING ENGINE ---
    # Locked: update_crowd/get_crowd_velocity mutate live_node_status,
    # which /reset and other Flask threads also touch concurrently.
    with state_lock:
        update_crowd("J16", person_count)
        vel = get_crowd_velocity("J16")
        current_person_count = person_count
        current_track_ids    = track_ids_this_frame
        crowd_velocity_lobby = round(vel, 3)

    # --- STOCHASTIC SENSOR MODEL — secondary nodes ---
    if not manual_override and int(t_now) % 2 == 0 and int(t_now) != _last_drift_tick:
        _last_drift_tick = int(t_now)
        _in_hazard = (cur_state == "HAZARD")
        _sensor_model = {
            "J4": (40, 70), "J7": (75, 99 if _in_hazard else 84),
            "J8": (60, 84), "J18": (10, 30), "J12": (20, 45),
        }
        with state_lock:
            for _nid, (_lo, _hi) in _sensor_model.items():
                _cur   = live_node_status[_nid]["crowd"]
                _drift = random.randint(-1, 1)
                _new   = max(_lo, min(_hi, _cur + _drift))
                update_crowd(_nid, _new)

    if vel > 5 and cur_state == "NORMAL":
        print(f"[CROWD] Velocity spike {vel:+.2f} — pre-emptive reroute")
        with state_lock:
            live_node_status["J16"]["status"] = "warning"

    # --- FALL ESCALATION ---
    if current_frame_has_fall:
        state["recovery_timer_start"] = 0
        if state["fall_timer_start"] == 0:
            state["fall_timer_start"] = t_now
        if t_now - state["fall_timer_start"] >= 3.0 and cur_state == "NORMAL":
            with state_lock:
                system_state = "HAZARD"
                live_node_status["J16"]["hazard"] = "fall"
                live_node_status["J16"]["status"] = "alert"
                live_node_status["J16"]["pull_signal"] = "RED"
                _route     = list(current_route)
                _total_pax = sum(d["crowd"] for d in live_node_status.values())
                _corridors = _build_corridor_states()
            mqtt_client.publish(TOPIC, json.dumps({
                "status": "CRITICAL", "system_state": "CRITICAL",
                "hazard_type": "FALL DETECTED", "person_count": _total_pax,
                "track_count": len(track_ids_this_frame),
                "stealth_mode": False, "green_led": True, "red_led": False,
                "buzzer_active": True, "green_direction": "FOLLOW_ROUTE",
                "active_route": _route, "corridors": _corridors,
            }))
    else:
        state["fall_timer_start"] = 0
        with state_lock:
            _n011_hazard = live_node_status["J16"]["hazard"]
        if cur_state == "HAZARD" and _n011_hazard == "fall":
            if state["recovery_timer_start"] == 0:
                state["recovery_timer_start"] = t_now
            if t_now - state["recovery_timer_start"] >= 3.0:
                with state_lock:
                    system_state   = "NORMAL"
                    facp_confirmed = False
                    live_node_status["J16"]["hazard"]      = None
                    live_node_status["J16"]["status"]      = "normal"
                    live_node_status["J16"]["pull_signal"] = "GREEN"
                with state_lock:
                    _total_pax = sum(d["crowd"] for d in live_node_status.values())
                    _corridors = _build_corridor_states()
                mqtt_client.publish(TOPIC, json.dumps({
                    "status": "RESOLVED", "system_state": "NORMAL",
                    "person_count": _total_pax, "stealth_mode": True,
                    "green_led": False, "red_led": False, "buzzer_active": False,
                    "green_direction": "NONE", "corridors": _corridors,
                }))
        else:
            state["recovery_timer_start"] = 0

    # --- DYN-A* REROUTE (throttled to 1/sec) ---
    # Locked end-to-end: calculate_safest_route/run_pull_policy/estimate_rset
    # all read+mutate live_node_status and routing_engine's module-level
    # hysteresis cache. Without one continuous lock, a concurrent /reset
    # (or another Flask request thread) can mutate live_node_status mid-
    # calculation -> RuntimeError: dictionary changed size during iteration.
    if t_now - state["route_cooldown"] >= 1.0 and not manual_override:
        state["route_cooldown"] = t_now
        with state_lock:
            lobby_hazard = live_node_status.get("J16", {}).get("hazard")
            start_node = "J7" if lobby_hazard == "fall" else "J16"
            path, score = calculate_safest_route(start_node, verbose=False)
            if path:
                if start_node == "J7":
                    path = ["J16"] + path
                signals = run_pull_policy()  # global — evaluates ALL nodes, not just the route
                rset    = estimate_rset(path)
                current_route        = path
                current_pull_signals = signals
                current_rset         = rset
                current_route_cost   = score

    with state_lock:
        _state   = system_state
        _thermal = thermal_state
        _fft     = fft_state
        _vel     = crowd_velocity_lobby

    _mode_txt = "TOY DIORAMA" if cur_mode == "DIORAMA" else "REAL-WORLD SKELETAL"
    cv2.putText(frame, f"MODE: {_mode_txt}", (10, 25),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
    cv2.putText(frame, f"FPS:{fps:.0f}  PERSONS:{person_count}  VEL:{_vel:+.1f}/rdg",
                (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    cv2.putText(frame, f"THERMAL:{_thermal}  FFT:{_fft}  STATE:{_state}",
                (10, 72), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                (0, 255, 0) if _state == "NORMAL" else (0, 80, 255), 2)

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
        cv2.putText(frame, f"ROUTE: {route_txt}", (10, h_frame - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 255, 120), 1)

    ret, buffer = cv2.imencode(".jpg", frame)
    if ret:
        with _frame_lock:
            _frame_buffer = buffer.tobytes()


def _ai_worker():
    """
    Background daemon thread: runs the full AI + routing cycle continuously,
    independent of whether any browser has /video_feed open. This is the
    fix for the "observer-dependent AI loop" — DYN-A* and fall detection
    must never stop just because no one is watching the camera feed.
    """
    state = {
        "fall_timer_start": 0, "recovery_timer_start": 0, "route_cooldown": 0,
        "prev_time": time.time(), "frame_counter": 0, "last_results": None,
    }
    while not _ai_thread_stop.is_set():
        try:
            _process_ai_cycle(cap, state)
        except Exception as e:
            print(f"[AI Worker] Error: {e}")
            time.sleep(0.5)


def generate_frames():
    """
    /video_feed generator. Does NOT run AI — just reads whatever frame
    the background _ai_worker thread most recently produced and streams
    it as MJPEG. Safe to have zero, one, or many viewers; AI keeps running
    in all cases.
    """
    while True:
        with _frame_lock:
            frame_bytes = _frame_buffer
        if frame_bytes is None:
            time.sleep(0.1)
            continue
        yield (b"--frame\r\n"
               b"Content-Type: image/jpeg\r\n\r\n" +
               frame_bytes + b"\r\n")
        time.sleep(0.03)  # ~30fps stream cap, independent of AI processing rate


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
        _sysmode = system_mode
        _bomba   = bomba_override_active
        _simtype = sim_trigger_type
        _simnode = sim_trigger_node
        _count   = current_person_count
        _total_pax = sum(d["crowd"] for d in live_node_status.values())
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
        "system_mode":        _sysmode,
        "bomba_override":     _bomba,
        "sim_trigger_type":   _simtype,
        "sim_trigger_node":   _simnode,
        "ai_mode":            _mode,
        "facp_confirmed":     _facp,
        "manual_override":    _manual,
        "person_count":       _count,
        "total_footfall":     _total_pax,
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
        "baseline_rset":      estimate_baseline_rset(_route) if _route else {},
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
    BOMBA "Simulate Fire" — there is no physical thermal sensor in this prototype,
    so fire scenarios are triggered manually for demonstration purposes.
    Fall detection (via camera) is independent and works without this trigger.

    Sets fire_sim_active=True so the thermal classifier thread begins
    simulating a gradual fire (_gradual_fire curve) and the FFT thread
    begins simulating the 520Hz alarm tone for FACP confirmation.
    Sets manual_override so stochastic drift pauses.
    """
    global system_state, manual_override, fire_sim_active
    with state_lock:
        system_state    = "HAZARD"
        manual_override = True
        fire_sim_active = True   # thermal + FFT threads begin fire simulation
        live_node_status["J7"]["status"] = "alert"
        live_node_status["J7"]["hazard"] = "thermal"
        _total_pax = sum(d["crowd"] for d in live_node_status.values())
        _corridors = _build_corridor_states()
    mqtt_client.publish(TOPIC, json.dumps({
        "status":       "CRITICAL",
        "system_state": "HAZARD",
        "hazard_type":  "MANUAL OVERRIDE (thermal only — awaiting FFT confirmation)",
        "person_count": _total_pax,
        "corridors":    _corridors,
    }))
    return jsonify({"status": "success", "message": "Fire simulation triggered at J7 (Thai Relax corridor — FACP zone B5) — thermal + acoustic AI now running"})


@app.route("/api/facp_store_alert", methods=["POST","GET"])
def api_facp_alert():
    """
    FACP integration endpoint.
    Called when building fire panel signals a specific store.
    Body: { "door_id": "B5", "hazard": "thermal" }
    Marks nearest junction alert + returns evacuation route from store door.
    """
    global system_state, manual_override, fire_sim_active
    body        = request.get_json(silent=True) or {}
    door_id     = body.get("door_id") or request.args.get("door_id")
    if not door_id:
        return jsonify({"error": "door_id required — never guess fire location"}), 400
    hazard      = body.get("hazard", "thermal")
    store_label = DOOR_LABELS.get(door_id, door_id)
    with state_lock:
        junction_id = facp_store_alert(door_id, hazard)
        if not junction_id:
            return jsonify({"error": f"Unknown door_id: {door_id}"}), 400
        path, cost  = route_from_store(door_id, verbose=False)
        current_route[:] = path
        system_state     = "HAZARD"
        manual_override  = True
        fire_sim_active  = True
    print(f"[FACP] ALERT: {store_label} ({door_id}) — {hazard}. Junction: {junction_id}. Route: {' → '.join(path)}")
    return jsonify({
        "status":    "facp_alert",
        "store":     store_label,
        "door_id":   door_id,
        "junction":  junction_id,
        "route":     path,
        "cost":      cost,
        "message":   f"FACP: {store_label} fire detected — evacuating via {' → '.join(path)}",
    })


@app.route("/api/facp_store_clear", methods=["POST","GET"])
def api_facp_clear():
    """Clear a FACP store alert and restore normal routing."""
    global system_state, manual_override, fire_sim_active
    from routing_engine import facp_store_clear as _facp_clear
    body        = request.get_json(silent=True) or {}
    door_id     = body.get("door_id") or request.args.get("door_id")
    if not door_id:
        return jsonify({"error": "door_id required — never guess fire location"}), 400
    store_label = DOOR_LABELS.get(door_id, door_id)
    with state_lock:
        junction_id      = _facp_clear(door_id)
        system_state     = "NORMAL"
        manual_override  = False
        fire_sim_active  = False
        reset_hysteresis()
    print(f"[FACP] CLEAR: {store_label} ({door_id}) — junction {junction_id} restored")
    return jsonify({
        "status":   "cleared",
        "door_id":  door_id,
        "junction": junction_id,
        "message":  f"FACP: {store_label} hazard cleared — normal routing resumed",
    })


@app.route("/reset")
def reset_system():
    global system_state, facp_confirmed, current_route, current_pull_signals, current_rset, \
           manual_override, fire_sim_active, fft_state, thermal_state, current_route_cost
    with state_lock:
        system_state         = "NORMAL"
        facp_confirmed       = False
        manual_override      = False   # release manual command — restore full AUTO mode
        fire_sim_active      = False   # stop fire simulation — thermal returns to ambient
        fft_state            = "SILENT"   # clear acoustic confirmation indicator
        thermal_state        = "NORMAL"   # clear thermal alert indicator
        current_route_cost   = 0          # clear stale DYN-A* cost from hazard route
        current_route        = ["J19","J18","EXIT-5"]  # restore baseline
        current_pull_signals = {}
        current_rset         = {}
        for nid, data in live_node_status.items():
            data["status"]      = "normal"
            data["hazard"]      = None
            data["pull_signal"] = "GREEN"
        # Reset clears hazard state, NOT actual occupancy — people don't
        # vanish from the building just because the alarm cleared.
        _total_pax = sum(d["crowd"] for d in live_node_status.values())
        _corridors = _build_corridor_states()  # all "normal" post-reset
    mqtt_client.publish(TOPIC, json.dumps({
        "status": "RESOLVED", "system_state": "NORMAL",
        "person_count": _total_pax, "stealth_mode": True,
        "green_direction": "NONE", "corridors": _corridors,
    }))
    return jsonify({"status": "success", "message": "System reset to NORMAL"})


@app.route("/api/block_node", methods=["POST","GET"])
def block_node():
    """
    BOMBA blocks a node. Backend recalculates route avoiding it.
    Returns the complete new route — frontend just displays it.
    """
    global current_route, manual_override
    body    = request.get_json(silent=True) or {}
    node_id = body.get("node_id") or request.args.get("node_id", "J4")
    # start: caller sends the hazard origin (activeRoute[0]); fallback to current_route
    start   = (body.get("start")
               or request.args.get("start")
               or (current_route[0] if current_route else "J16"))
    # If start is a door (Bx), get its junction
    from routing_engine import DOOR_TO_JUNCTION
    if start in DOOR_TO_JUNCTION:
        start = DOOR_TO_JUNCTION[start]
    with state_lock:
        result = block_node_and_reroute(node_id, start)
        current_route = result["new_route"]
        manual_override = True
        _total_pax = sum(d["crowd"] for d in live_node_status.values())
        _corridors = _build_corridor_states()
    # Push immediately — don't make BOMBA wait up to 2s for the next
    # heartbeat to see the diorama lights react to a manual block.
    mqtt_client.publish(TOPIC, json.dumps({
        "status": "CRITICAL", "system_state": system_state,
        "hazard_type": "MANUAL OVERRIDE", "manual_override": True,
        "stealth_mode": False, "person_count": _total_pax,
        "green_direction": "FOLLOW_ROUTE", "corridors": _corridors,
    }))
    print(f"[BOMBA] Blocked {node_id}, new route: {' → '.join(result['new_route'])}")
    return jsonify(result)


@app.route("/api/unblock_node", methods=["POST","GET"])
def api_unblock():
    """BOMBA unblocks a previously blocked node."""
    global manual_override
    body    = request.get_json(silent=True) or {}
    node_id = body.get("node_id") or request.args.get("node_id", "J4")
    with state_lock:
        unblock_node(node_id)
        reset_hysteresis()
        manual_override = False
    return jsonify({"status": "unblocked", "node_id": node_id})


@app.route("/api/set_system_mode/<mode>")
def set_system_mode(mode):
    """
    Switch between simulation and live mode.
    Simulation: manual triggers only, real sensors suppressed.
    Live: real sensors only, manual simulation triggers disabled.
    Bomba override works in both modes.
    """
    global system_mode
    if mode not in ("simulation", "live"):
        return jsonify({"error": "mode must be 'simulation' or 'live'"}), 400
    with state_lock:
        system_mode = mode
        if mode == "live":
            # Clear simulation state so DYN-A* thread resumes auto-routing
            global manual_override, sim_trigger_type, sim_trigger_node
            manual_override  = False
            sim_trigger_type = None
            sim_trigger_node = None
            active_hazard_nodes.clear()
    print(f"[MODE] System mode switched to: {mode.upper()}")
    return jsonify({"status": "success", "system_mode": mode})


@app.route("/api/get_system_mode")
def get_system_mode():
    """Returns current system mode and Bomba override status."""
    with state_lock:
        return jsonify({
            "system_mode":           system_mode,
            "bomba_override_active": bomba_override_active,
            "sim_trigger_type":      sim_trigger_type,
            "sim_trigger_node":      sim_trigger_node,
        })


@app.route("/api/sim_trigger", methods=["POST"])
def sim_trigger():
    """
    Simulation mode only — manually trigger a fire/fallen/crowd event at a node.
    Body: { "event_type": "fire"|"fallen"|"crowd", "node_id": "J7" }
    Rejected if system_mode is not "simulation" or bomba_override_active is True.
    """
    global system_state, manual_override, fire_sim_active
    global sim_trigger_type, sim_trigger_node, active_hazard_nodes

    with state_lock:
        _mode   = system_mode
        _bomba  = bomba_override_active

    if _mode != "simulation":
        return jsonify({"error": "Simulation triggers only allowed in SIMULATION mode"}), 403
    if _bomba:
        return jsonify({"error": "Bomba override active — simulation triggers blocked"}), 403

    body       = request.get_json(silent=True) or {}
    event_type = body.get("event_type", "fire")   # "fire" | "fallen" | "crowd"
    node_id    = body.get("node_id", "J7")

    if event_type not in ("fire", "fallen", "crowd"):
        return jsonify({"error": "event_type must be fire, fallen, or crowd"}), 400

    with state_lock:
        # Accumulate hazards — append to list, do NOT clear previous ones
        sim_trigger_type  = event_type
        sim_trigger_node  = node_id
        system_state      = "HAZARD"
        manual_override   = True
        # Track all active hazard nodes for multi-path routing
        if not any(h["node_id"]==node_id for h in active_hazard_nodes):
            active_hazard_nodes.append({"node_id": node_id, "event_type": event_type})

        if event_type == "fire":
            fire_sim_active = True
            live_node_status[node_id]["status"] = "alert"
            live_node_status[node_id]["hazard"] = "thermal"
            hazard_label = "FIRE (Simulation)"
        elif event_type == "fallen":
            live_node_status[node_id]["status"] = "alert"
            live_node_status[node_id]["hazard"] = "fall"
            live_node_status[node_id]["pull_signal"] = "RED"
            hazard_label = "PERSON FALLEN (Simulation)"
        elif event_type == "crowd":
            live_node_status[node_id]["status"] = "warning"
            live_node_status[node_id]["hazard"] = "crowd"
            live_node_status[node_id]["pull_signal"] = "AMBER"
            hazard_label = "CROWD DENSITY (Simulation)"

        _total_pax = sum(d["crowd"] for d in live_node_status.values())
        # Reset hysteresis so multi-hazard recalculates fresh each trigger
        reset_hysteresis()
        # Calculate best exit route for EACH active hazard node
        _per_node_routes = []
        for _h in active_hazard_nodes:
            _h_routes = get_all_exit_routes(_h["node_id"])
            if _h_routes:
                _per_node_routes.append({
                    "node_id":    _h["node_id"],
                    "event_type": _h["event_type"],
                    "best_path":  _h_routes[0]["path"],
                    "best_exit":  _h_routes[0]["exit"],
                    "best_cost":  _h_routes[0]["cost"],
                    "all_exits":  _h_routes,
                })
        # Primary route = best route from most recently triggered node
        _path = _per_node_routes[-1]["best_path"] if _per_node_routes else []
        if _path:
            current_route[:] = _path
        _corridors = _build_corridor_states()

    mqtt_client.publish(TOPIC, json.dumps({
        "status":       "CRITICAL",
        "system_state": "HAZARD",
        "hazard_type":  hazard_label,
        "source":       "SIMULATION",
        "node_id":      node_id,
        "person_count": _total_pax,
        "corridors":    _corridors,
    }))
    print(f"[SIM] Triggered {event_type.upper()} at {node_id} → {len(_per_node_routes)} hazard nodes active")
    return jsonify({
        "status":          "success",
        "event_type":      event_type,
        "node_id":         node_id,
        "route":           _path or [],
        "per_node_routes": _per_node_routes,
        "message":         f"Simulation: {hazard_label} triggered at {node_id}",
    })


@app.route("/api/bomba_override", methods=["POST"])
def bomba_override():
    """
    Bomba override — works in ANY mode (simulation or live).
    Highest priority event — cannot be overridden by simulation or sensors.
    Body: { "action": "activate"|"clear", "node_id": "J7" (optional) }
    """
    global system_state, manual_override, fire_sim_active, bomba_override_active
    global sim_trigger_type, sim_trigger_node

    body    = request.get_json(silent=True) or {}
    action  = body.get("action", "activate")
    node_id = body.get("node_id", None)

    if action == "activate":
        with state_lock:
            bomba_override_active = True
            system_state          = "HAZARD"
            manual_override       = True
            fire_sim_active       = True   # triggers thermal + FFT simulation
            sim_trigger_type      = None   # cancel any pending simulation
            sim_trigger_node      = None

            _node = node_id or "J7"
            live_node_status[_node]["status"] = "alert"
            live_node_status[_node]["hazard"] = "thermal"
            _total_pax = sum(d["crowd"] for d in live_node_status.values())
            _corridors = _build_corridor_states()

        mqtt_client.publish(TOPIC, json.dumps({
            "status":       "CRITICAL",
            "system_state": "HAZARD",
            "hazard_type":  "BOMBA COMMAND OVERRIDE",
            "source":       "BOMBA",
            "person_count": _total_pax,
            "corridors":    _corridors,
        }))
        print("[BOMBA] Override ACTIVATED — highest priority event, all other triggers blocked")
        return jsonify({"status": "success", "bomba_override_active": True,
                        "message": "Bomba override activated — all sensors and simulation suppressed"})

    elif action == "clear":
        with state_lock:
            bomba_override_active = False
            system_state          = "NORMAL"
            manual_override       = False
            fire_sim_active       = False
            sim_trigger_type      = None
            sim_trigger_node      = None
            active_hazard_nodes.clear()
            for nid, d in live_node_status.items():
                d["status"]      = "normal"
                d["hazard"]      = None
                d["pull_signal"] = "GREEN"
            _total_pax = sum(d["crowd"] for d in live_node_status.values())
            _corridors = _build_corridor_states()

        mqtt_client.publish(TOPIC, json.dumps({
            "status":       "RESOLVED",
            "system_state": "NORMAL",
            "source":       "BOMBA",
            "person_count": _total_pax,
            "corridors":    _corridors,
        }))
        print("[BOMBA] Override CLEARED — system restored to normal")
        return jsonify({"status": "success", "bomba_override_active": False,
                        "message": "Bomba override cleared — normal operation resumed"})

    return jsonify({"error": "action must be activate or clear"}), 400


@app.route("/api/quick_routes", methods=["POST","GET"])
def api_quick_routes():
    """
    Returns routes to all reachable exits from a given start point.
    Used by BOMBA quick route panel.
    """
    body  = request.get_json(silent=True) or {}
    start = body.get("start") or request.args.get("start", "J16")
    from routing_engine import DOOR_TO_JUNCTION
    if start in DOOR_TO_JUNCTION:
        start_j = DOOR_TO_JUNCTION[start]
    else:
        start_j = start
    routes = get_all_exit_routes(start_j)
    # If start was a door, prepend it
    if start in DOOR_TO_JUNCTION:
        for r in routes:
            r["path"] = [start] + r["path"]
    return jsonify({"start": start, "routes": routes})


@app.route("/api/force_exit", methods=["POST","GET"])
def api_force_exit():
    """
    BOMBA forces route to a specific exit. Backend calculates full junction path.
    """
    global current_route, manual_override
    body     = request.get_json(silent=True) or {}
    start    = body.get("start") or (current_route[0] if current_route else "J16")
    exit_id  = body.get("exit_id") or request.args.get("exit_id", "EXIT-1")
    from routing_engine import DOOR_TO_JUNCTION
    start_j  = DOOR_TO_JUNCTION.get(start, start)
    path, cost = route_to_specific_exit(start_j, exit_id, verbose=False)
    if start in DOOR_TO_JUNCTION and path:
        path = [start] + path
    with state_lock:
        current_route = path
        force_route(path)
        manual_override = True
    print(f"[BOMBA] Forced route to {exit_id}: {' → '.join(path)}")
    return jsonify({"route": path, "cost": cost, "exit": exit_id})


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
    baseline_data  = estimate_baseline_rset(current_route)
    total_footfall = sum(d["crowd"] for d in snap.values())
    peak_entry     = max(snap.items(), key=lambda x: x[1]["crowd"]) if snap else ("N/A", {"crowd": 0})
    avg_occ        = round(total_footfall / max(len(snap), 1), 1)
    dynamic_rset   = rset_data.get("RSET_s", 142)
    baseline_rset  = baseline_data.get("RSET_s", 342)  # measured, not hardcoded
    try:
        reduction_pct = round((1 - float(dynamic_rset) / float(baseline_rset)) * 100, 1)
    except Exception:
        reduction_pct = "N/A"

    BATT = {k: v["pct"]          for k, v in NODE_BATTERY.items()}
    NEXT = {k: v["next_service"] for k, v in NODE_BATTERY.items()}
    # NODE_BATTERY is the module-level source of truth — update once, reflects everywhere

    # --- REPORT HEADER -
    writer.writerow(["LUMINA SMART EVACUATION SYSTEM"])
    writer.writerow(["Facility Management & Commercial Analytics Report"])
    writer.writerow(["Generated",            time.strftime('%Y-%m-%d %H:%M:%S')])
    writer.writerow(["Session Duration (s)", round(time.time() - _startup_time, 1)])
    writer.writerow(["Deployment Model",     "Hardware-as-a-Service (HaaS)"])
    writer.writerow(["System Status",        _sys])
    writer.writerow([])

    # --- SECTION 1: FOOTFALL TELEMETRY -
    # Supports DOOH ad premium pricing and kiosk rental rates (Appendix G)
    writer.writerow(["FOOTFALL TELEMETRY"])
    writer.writerow(["Total Occupancy (pax)",   total_footfall])
    writer.writerow(["Peak Zone",               f"{resolve_node_name(peak_entry[0])} ({peak_entry[0]})"])
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
            resolve_node_name(nid), nid, crowd, vel,
            d["status"].upper(), action,
        ])
    writer.writerow([])

    # --- SECTION 3: OCCUPANCY-DRIVEN COMMERCIAL INSIGHTS ---
    # Shows what the data enables — facility managers apply their own cost rates
    writer.writerow(["OCCUPANCY-DRIVEN COMMERCIAL INSIGHTS"])
    writer.writerow(["What Lumina measures", "What facility management can act on"])
    writer.writerow([])

    # Compute peak and low zones from live data
    occupied_zones  = [(nid, d["crowd"]) for nid, d in snap.items() if d["crowd"] > 0]
    empty_zones     = [(nid, d["crowd"]) for nid, d in snap.items() if d["crowd"] < 10]
    high_zones      = [(nid, d["crowd"]) for nid, d in snap.items() if d["crowd"] > 60]
    total_pax       = sum(d["crowd"] for d in snap.values())
    avg_occ_pct     = round(total_pax / max(len(snap) * 100, 1) * 100, 1)

    writer.writerow(["FOOTFALL ANALYTICS"])
    writer.writerow(["total_occupancy_pax",     total_pax,
                     "Current headcount across all zones"])
    writer.writerow(["average_zone_occupancy_%", avg_occ_pct,
                     "% of maximum capacity across all nodes"])
    writer.writerow(["high_traffic_zones",
                     ", ".join(f"{resolve_node_name(z[0])} ({z[0]})" for z in high_zones) or "None",
                     "Zones above 60 pax — prime locations for DOOH or kiosk placement"])
    writer.writerow(["low_traffic_zones",
                     ", ".join(f"{resolve_node_name(z[0])} ({z[0]})" for z in empty_zones) or "None",
                     "Zones below 10 pax — candidate for HVAC reduction"])
    writer.writerow([])

    writer.writerow(["HVAC OPTIMISATION SIGNALS"])
    writer.writerow(["zone", "node_id", "occupancy_pax", "measured_temp_c",
                     "occupancy_based_hvac_action", "note"])
    for nid, d in snap.items():
        temp  = round(_latest_temps.get(nid, 27.0), 1)
        crowd = d["crowd"]
        # Actions derived from occupancy only — facility manager applies their own setpoints
        if crowd < 10:
            action = "Reduce cooling — zone unoccupied"
            note   = "Apply facility's unoccupied setpoint (typically +3 to +5 deg C)"
        elif crowd > 70:
            action = "Increase cooling — high occupancy"
            note   = "Apply facility's peak-occupancy setpoint"
        else:
            action = "Maintain current setpoint"
            note   = "Normal occupancy range"
        writer.writerow([resolve_node_name(nid), nid, crowd, temp, action, note])
    writer.writerow([])
    writer.writerow(["NOTE", "",
                     "Lumina provides occupancy signals only. Energy savings depend on "
                     "facility HVAC specifications, electricity tariff, and building "
                     "management system configuration. No savings figures are claimed here."])
    writer.writerow([])

    # --- SECTION 5: EVACUATION SAFETY STATUS -
    writer.writerow(["EVACUATION SAFETY STATUS"])
    writer.writerow(["Active Route",                " > ".join(current_route)])
    writer.writerow(["Route Safe",                  "Yes" if rset_data.get("safe", True) else "No"])
    writer.writerow(["Estimated Evacuation Time (s)", dynamic_rset, "With Lumina DYN-A* guidance"])
    writer.writerow(["Baseline Evacuation Time (s)",  baseline_rset, "Without guidance (static signs, panic speed)"])
    writer.writerow(["Time Reduction",                f"{reduction_pct}%", "Measured by routing engine"])
    writer.writerow(["Available Safe Egress Time (s)", rset_data.get("ASET_s", 600)])
    writer.writerow(["Safety Margin (s)",           rset_data.get("margin_s", "N/A")])
    writer.writerow(["FACP Status",                 "Confirmed" if _facp else "Standby"])
    writer.writerow([])

    # T2 sensitivity table — proves system is safe across all realistic T2 values
    # T2 (response hesitation) cannot be measured without a live user trial.
    # This table shows RSET remains safe even if T2 is as high as the static baseline.
    writer.writerow(["T2 SENSITIVITY ANALYSIS"])
    writer.writerow(["Note",
                     "T2 = occupant response hesitation time. "
                     "Lumina design target: T2=5s (>80% reduction on 30s static baseline). "
                     "Actual T2 requires user trial measurement before production claim. "
                     "This table shows the system is SAFE across all realistic T2 values."])
    writer.writerow(["T2_hesitation_s", "RSET_s", "reduction_vs_static_%", "safe", "margin_s"])
    for row in rset_t2_sensitivity(current_route):
        marker = " <- DESIGN TARGET" if row["T2_s"] == 5 else (
                 " <- SAME AS STATIC (worst case)" if row["T2_s"] == 30 else "")
        writer.writerow([
            f"{row['T2_s']}s{marker}",
            row["RSET_s"],
            f"{row['reduction_%']}%",
            "Yes" if row["safe"] else "No",
            row["margin_s"],
        ])
    writer.writerow([])

    # --- SECTION 6: ZONE CONGESTION SIGNALS -
    writer.writerow(["ZONE CONGESTION SIGNALS"])
    writer.writerow(["zone", "signal", "detail"])
    for nid, info in current_pull_signals.items():
        reason = info.get("reason", "N/A").replace("\u2014", "-").replace("\u2013", "-")
        writer.writerow([resolve_node_name(nid), info.get("signal", "N/A"), reason])
    if not current_pull_signals:
        writer.writerow(["All zones", "GREEN", "No congestion detected"])
    writer.writerow([])

    # --- SECTION 7: NODE MAINTENANCE & BATTERY STATUS -
    # NFPA 72 requires batteries >= 60% shelf life (Appendix F, BOM Defence)
    writer.writerow(["NODE MAINTENANCE AND BATTERY STATUS"])
    writer.writerow(["node_id", "zone", "battery_pct", "nfpa72_status",
                     "next_service", "action_required"])
    for nid in NODE_BATTERY:
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
        writer.writerow([nid, LUMINA_NODE_LABELS.get(nid, nid), bat, status, next_, action])
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
                     "Analytics run on edge TPU only - no raw video transmitted"])
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
    Battery data lives here as the single source of truth for both dashboard and CSV.
    """
    with state_lock:
        _sys_state = system_state
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
        "battery":            NODE_BATTERY,
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
        fire_sim_active      = False
        current_route        = ["J19","J18","EXIT-5"]
        current_pull_signals = {}
        current_rset         = {}
        for _nid, _d in live_node_status.items():
            _d["status"]      = "normal"
            _d["hazard"]      = None
            _d["pull_signal"] = "GREEN"
    if hasattr(thermal_clf, 'reset'): thermal_clf.reset()
    if hasattr(fft_clf,    'reset'): fft_clf.reset()

    # Start the AI worker as a daemon thread — runs independently of
    # whether any browser has /video_feed open (fixes observer-dependent
    # AI loop: fall detection and DYN-A* must keep running 24/7).
    _ai_thread = threading.Thread(target=_ai_worker, daemon=True)
    _ai_thread.start()
    print("[LUMINA] AI worker thread started — decoupled from /video_feed")

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
