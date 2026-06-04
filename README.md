# Lumina Smart Evacuation System

> Category 2 — Tech4Good Challenge 2026
> Team: Lai Zi Huey (Leader), Low Wei Ling, Woo May Eng

Lumina transforms building evacuation from a passive infrastructure into an active, data-driven safety framework. It detects hazards in real time, reroutes evacuees dynamically using a Deterministic Dynamic A\* (DYN-A\*) algorithm, and generates daily commercial ROI through anonymous retail analytics — turning fire safety from a sunk cost into a profitable business asset.

---

## Repository Structure

```
lumina-evacuation/
├── backend/
│   ├── lumina_live_stream.py     # Flask server, YOLOv8 inference, MQTT
│   ├── routing_engine.py         # DYN-A* pathfinding + IoT Pull Policy
│   ├── thermal_classifier.py     # Z-score thermal anomaly detection
│   ├── fft_classifier.py         # 520Hz FFT acoustic alarm classifier
│   ├── export_onnx.py            # Export YOLOv8 to ONNX (for RK3588 NPU)
│   ├── test_integration.py       # Pre-demo integration test suite
│   ├── crowd_velocity_demo.py    # Standalone DYN-A* benchmark demos
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.jsx               # Main React dashboard (single file)
│   │   ├── theme.js              # Design tokens and colour palette
│   │   ├── data.js               # Fallback node data and event log
│   │   └── components/
│   │       └── UIComponents.jsx  # MetricCard and shared components
│   ├── package.json
│   ├── vite.config.js
│   └── index.html
├── firmware/
│   └── esp32_lumina_node.ino     # ESP32 BLE mesh node firmware
└── README.md
```

---

## Quick Start

### Prerequisites

- Python 3.10+
- Node.js 18+
- A webcam (built-in or USB)

### 1. Backend

```bash
cd backend
pip install -r requirements.txt

# Download the YOLOv8 pose model (first run only)
python -c "from ultralytics import YOLO; YOLO('yolov8n-pose.pt')"

# Run the server
python lumina_live_stream.py
```

The server starts on `http://localhost:5001`. You will see:

```
[INIT] Using camera index 0
[INIT] YOLO model loaded
[INIT] Flask server starting on port 5001
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

---

## Configuration

### Connecting the iPad / second device to the dashboard

By default `FLASK_IP` is set to `127.0.0.1` (localhost only). To access the dashboard from another device on the same Wi-Fi network:

1. Find your laptop's Wi-Fi IP:

   - **Mac/Linux:** `ifconfig | grep "inet " | grep -v 127`
   - **Windows:** `ipconfig` → look for IPv4 Address
2. Open `frontend/src/App.jsx` and change line 8:

   ```js
   const FLASK_IP = "192.168.x.x";  // your actual Wi-Fi IP
   ```
3. The amber DEV MODE banner at the top disappears when set correctly.

### USB webcam (external camera)

If your USB webcam is not detected on the default index:

```bash
# Find the correct index
python -c "import cv2; [print(i, cv2.VideoCapture(i).read()[0]) for i in range(4)]"

# Start with the correct index
CAMERA_INDEX=1 python lumina_live_stream.py
```

---

## Running Before Every Demo

```bash
cd backend
python test_integration.py
```

This runs 5 assertions in ~10 seconds:

1. Flask online with YOLO loaded and camera open
2. System in NORMAL state at startup
3. Trigger produces HAZARD state
4. Safe route excludes the blocked node
5. Reset returns to NORMAL

All 5 must pass before presenting.

---

## System Architecture

```
┌─────────────────────────────────────────────────────┐
│                  EDGE LAYER (Lumina Node)            │
│  RGB Camera → YOLOv8-pose → ByteTrack (anonymous)   │
│  Thermal IR → Z-score classifier                     │
│  Microphone → FFT (520Hz FACP detection)             │
│  DYN-A* routing engine (local, no cloud dependency)  │
└──────────────────┬──────────────────────────────────┘
                   │ MQTT + REST API
┌──────────────────▼──────────────────────────────────┐
│              DASHBOARD (React + Vite)                │
│  Live Command tab   — Camera feed + Digital Twin     │
│  System Health tab  — Node map + battery status      │
│  Analytics tab      — Footfall + commercial ROI      │
└─────────────────────────────────────────────────────┘
```

### Key Algorithms

**DYN-A\*** — Deterministic Dynamic A\* pathfinding. Each corridor segment is assigned a cost based on travel distance, hazard severity, crowd density, and thermal penalty. When a node is blocked, the cost jumps by +5000 and the algorithm instantly re-routes around it.

**IoT Pull Policy** — Upstream nodes project RED stop lines when downstream corridors are congested. Prevents fatal bottlenecks before they form (prevention, not just response).

**Dual-signal Fall Detection** — Combines YOLOv8 keypoint check (nose Y > hip Y) with bounding box aspect ratio check (width > 1.3× height). Either signal triggers detection; both together gives `DUAL` confidence shown on the HUD.

**FFT Acoustic Classifier** — Listens for the 520Hz NFPA 72 FACP alarm frequency. Rejects ambient noise via signal-to-noise ratio threshold. Only confirms hazard after both thermal anomaly AND acoustic confirmation.

---

## BOMBA / Incident Commander Controls

All manual override controls are in the **Digital Twin expanded view** (click the floor plan to expand):

| Control                       | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| Select node → REROUTE AROUND | BOMBA manually quarantines a node and forces DYN-A\* to re-route |
| Route A / B / C               | Quick preset routes for common evacuation scenarios              |
| RESET                         | Releases manual override and returns system to AUTO mode         |

Manual override locks all hazard state — the backend poll cannot overwrite BOMBA commands until RESET is pressed.

---

## Commercial ROI Model (200-Node Projection)

| Revenue Stream                                 | Monthly Value       |
| ---------------------------------------------- | ------------------- |
| DOOH Ad Premiums (5 zones × RM 1,600)         | RM 8,000            |
| Kiosk & Pop-Up Retail (10 locations × RM 500) | RM 5,000            |
| ESG HVAC Savings (35% efficiency gain)         | RM 2,500            |
| **Total Value Generated**                | **RM 15,500** |
| HaaS Subscription (200 nodes × RM 65)         | (RM 13,000)         |
| **Net Monthly Cash Flow**                | **RM 2,500**  |

CapEx avoided: RM 168,000 (200 nodes × RM 840 manufacturing cost, bypassed via HaaS model).

---

## Privacy & Compliance

- **0 bytes** of raw video transmitted — all analytics run on edge
- **No facial data stored** — ByteTrack uses anonymous crowd vectors only
- **PDPA 2010 compliant** (Malaysia Personal Data Protection Act)
- **NFPA 72 compliant** — 60-180s FACP Positive Alarm Sequence window
- **RAMO compliant** — 520Hz directional acoustic beacon for ADA accessibility

---

## Production Deployment Notes

The prototype runs YOLOv8 on a laptop CPU. The production pipeline is:

```
YOLOv8 (PyTorch) → export_onnx.py → ONNX → rknn-toolkit2 → RK3588 NPU
```

Run `python export_onnx.py` once to generate the ONNX model. RKNN conversion requires the Rockchip toolkit installed on the target device.

---

## Verbal Answers for Judges

**"How accurate is your fall detection from the ceiling?"**
YOLOv8-pose was trained on front-facing COCO data, not top-down. The bbox aspect ratio fallback compensates — a fallen person is always wider than tall regardless of camera angle. Production would fine-tune on synthetic top-down data from BIM models.

**"Why is it always 178 seconds for the FACP countdown?"**
178s is the default starting point within the NFPA 72 legal window of 60-180s. The Incident Commander can issue a manual override before it reaches zero.

**"Does this actually use the RK3588 NPU?"**
This prototype runs PyTorch on a laptop CPU. The ONNX export is step one of the production pipeline — step two is RKNN conversion via rknn-toolkit2.

**"What happens if the mesh network fails?"**
Each node runs DYN-A\* locally and routes independently. The mesh only shares hazard penalties — if it drops, each node routes conservatively using its own sensor data.

**"Can this scale to 200 nodes?"**
DYN-A\* on 6 nodes runs in under 0.5ms. At 200 nodes approximately 5-15ms. For 1000+ nodes the architecture transitions to D\* Lite which only recalculates locally affected edges.

---

## Demo Day Checklist

- [ ] Change `FLASK_IP` in `App.jsx` to laptop Wi-Fi IP
- [ ] Run `python test_integration.py` — all 5 must pass
- [ ] Verify camera feed visible in browser at `localhost:5173`
- [ ] Confirm amber DEV MODE banner is gone on the dashboard
- [ ] iPad connected to same Wi-Fi hotspot as laptop
- [ ] Dashboard loads on iPad at `http://<FLASK_IP>:5173`
- [ ] Test SIM scenario: play 520Hz tone near microphone → FFT confirms → route changes
- [ ] Export CSV works and opens cleanly in Excel
