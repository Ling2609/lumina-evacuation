# Lumina Egress Intelligence

**Smart Evacuation System — IEEE × ViTrox Tech 4 Good Grand Finale 2026**
*Team Siew Pow: Lai Zi Huey · Low Wei Ling · Woo May Eng*

---

## What It Does

Lumina transforms passive fire-exit signage into an active, AI-driven evacuation system. When a hazard is detected, the system:

1. **Detects** — thermal anomaly (Z-score + rate-of-change) or FFT-confirmed 520 Hz FACP alarm
2. **Routes** — DYN-A* pathfinding recalculates safest exit in <500ms, avoiding blocked corridors
3. **Guides** — LED strip lighting on the diorama floor lights up the safe path in real time
4. **Falls back** — camera-based fall detection (YOLOv8 + custom fine-tuned model) flags injured persons
5. **Prevents stampedes** — IoT Pull Policy holds upstream crowd until downstream corridors clear

Validated on a physical toy diorama (16-store mall floor plan, 20 junction nodes, 5 exits) with live webcam feed and MQTT-connected ESP32 LED controller.

---

## Architecture

```
lumina-frontend/          React + Vite dashboard (real-time map, camera feed, event log)
lumina-backend/
├── lumina_live_stream.py  Flask backend + AI pipeline (YOLO, thermal, FFT, DYN-A*)
├── routing_engine.py      DYN-A* pathfinding engine with hysteresis + Pull Policy
├── thermal_classifier.py  Rolling Z-score thermal anomaly detector
├── fft_classifier.py      FFT acoustic alarm classifier (520 Hz NFPA-72 pattern)
├── crowd_velocity_demo.py Standalone terminal demo of all 3 routing USPs
├── test_integration.py    Pre-demo health check — run before every presentation
└── models/
    └── fall_detector.pt   Custom fine-tuned YOLOv8n fall detection model
```

---

## Quickstart

### Prerequisites
- Python 3.10+
- Node.js 18+
- Webcam (USB or built-in)

### Backend
```bash
cd lumina-backend
pip install -r requirements.txt
python lumina_live_stream.py
```

Backend runs at `http://127.0.0.1:5001`

### Frontend
```bash
cd lumina-frontend
npm install
npm run dev
```

Dashboard runs at `http://localhost:5173`

> **Before demo:** update `FLASK_IP` in `lumina-frontend/src/App.jsx` to your machine's Wi-Fi IP so the React dashboard can reach the Flask backend over the local network.

---

## Pre-Demo Checklist

Run this after starting the backend to verify everything is working:

```bash
cd lumina-backend
python test_integration.py
```

Expected output: `27 passed  0 warnings  0 failed — SYSTEM IS DEMO-READY`

---

## Standalone Demos (no hardware needed)

```bash
# Demonstrates DYN-A* proactive rerouting, flash fire, and Pull Policy
python crowd_velocity_demo.py

# Validates thermal anomaly detection (gradual fire + flash fire scenarios)
python thermal_classifier.py

# Validates 520 Hz FFT alarm classifier with HVAC false-positive rejection
python fft_classifier.py

# Validates routing engine, heuristic admissibility, and RSET calculations
python routing_engine.py
```

---

## Key Performance Metrics

| Metric | Value | Source |
|--------|-------|--------|
| DYN-A* reroute latency | <500ms | `routing_engine.py` benchmark |
| Average RSET reduction | 43.3% | Routing simulation, 36 nodes, fire at J8 |
| Max RSET reduction | 57.9% | Node B11, same scenario |
| Thermal classifier latency | <1ms | `thermal_classifier.py` Test D |
| FFT classifier latency | <1ms | `fft_classifier.py` Test D |
| Fall detection model mAP50 | 0.88 | Roboflow fall-detection-ca3o8 validation set |
| Hardware cost per node (OEM) | RM 840 | Alibaba BOM, RK3588 chip-level pricing |

---

## Floor Plan

20 junction nodes (J1–J20), 16 store doors (B1–B16), 5 emergency exits (EXIT-1 to EXIT-5).

Modelled on a Malaysian retail mall layout. Junction and store coordinates are defined in `routing_engine.py` (`JUNCTION_COORDS`, `_DOOR_PX`).

---

## Fall Detection

Two-layer system:
1. **Primary** — `model_diorama` (YOLOv8n, COCO pretrained) for general person detection and pose-based fall check
2. **Fallback** — `models/fall_detector.pt` (custom fine-tuned on Roboflow fall-detection-ca3o8, 10,793 images) runs every frame to catch fallen figures at steep camera angles where silhouette-based detection fails
3. **Last resort** — MOG2 background subtraction blob check for stationary anomalies when both models find nobody

---

## MQTT Topics

| Topic | Direction | Payload |
|-------|-----------|---------|
| `lumina/status` | Backend → ESP32/React | JSON: system state, route, node statuses |
| `lumina/command` | React → Backend | JSON: manual trigger/reset commands |

Broker: `broker.hivemq.com:1883` (public, no auth required for prototype)

---

## License

Academic project — IEEE × ViTrox Tech 4 Good 2026. Not for commercial deployment.
