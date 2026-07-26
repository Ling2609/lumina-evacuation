# Lumina Smart Evacuation System

> **1st Runner-Up — Tech 4 Good (T4G) Challenge 2026 Grand Finale**
> University Category, ViTrox Campus, Penang
> **Team:** Lai Zi Huey (Leader), Low Wei Ling, Woo May Eng
> **Institution:** Asia Pacific University of Technology & Innovation (APU)

Lumina is an adaptive smart evacuation prototype built around a simple loop:

> **Detect → Decide → Guide**

It combines computer vision, environmental sensing, local edge processing, dynamic A*-based routing, a live digital twin, MQTT communication, and ESP32-controlled LED guidance to demonstrate how evacuation directions can adapt when hazards, crowd conditions, or corridor availability change.

Lumina is designed as a **supplementary intelligence layer** for existing fire alarms, exit signs, CCTV, and building-management systems. It does not replace mandatory life-safety systems, approved emergency procedures, or responder authority.

---

## Project Overview

Traditional exit signs remain fixed even when a route becomes unsafe, blocked, or congested. Lumina explores a more adaptive approach:

1. **Detect** hazards and crowd conditions using cameras and sensors.
2. **Decide** on a safer available path using a dynamic A*-based routing engine.
3. **Guide** occupants through the dashboard and physical LED indicators.
4. **Escalate** to a no-route or responder-intervention workflow when no verified safe path remains.

### Current prototype capabilities

- YOLO-based crowd monitoring
- Possible fallen-person detection
- Thermal anomaly detection
- Ultrasonic obstruction detection
- Dynamic A*-based route recalculation
- Multi-hazard handling
- IoT Pull Policy for upstream crowd control
- Live digital twin dashboard
- ESP32-controlled WS2812B LED guidance
- Simple buzzer alert
- MQTT-based communication
- Manual responder override and rerouting controls
- Node health, battery, and service-status display
- Simulation and live operating modes

### Proposed commercial direction

The prototype uses LEDs and a simple buzzer to demonstrate the concept. A future commercial deployment could integrate:

- Ceiling-mounted smart sensing nodes
- Zone-based edge gateways
- Dynamic floor projection using DLP
- Directional audio or voice instructions
- Backup batteries and emergency power
- Existing CCTV, fire-alarm, access-control, and BMS interfaces
- Multi-floor and multi-building analytics
- Industrial-grade sensing and communication hardware

These commercial features require further engineering, validation, certification, cybersecurity review, and controlled real-building testing.

---

## Repository Structure

```text
lumina-evacuation/
├── backend/
│   ├── lumina_live_stream.py     # Flask server, AI inference, MQTT and APIs
│   ├── routing_engine.py         # Dynamic A*-based routing and Pull Policy
│   ├── thermal_classifier.py     # Thermal anomaly classification
│   ├── fft_classifier.py         # Acoustic frequency analysis
│   ├── export_onnx.py            # YOLO model export utility
│   ├── test_integration.py       # Integration test suite
│   ├── crowd_velocity_demo.py    # Routing and crowd-behaviour demos
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.jsx               # Main React digital-twin dashboard
│   │   ├── theme.js              # Design tokens and colour palette
│   │   ├── data.js               # Fallback node data and event log
│   │   └── components/
│   │       └── UIComponents.jsx  # Shared UI components
│   ├── package.json
│   ├── vite.config.js
│   └── index.html
├── firmware/
│   └── esp32_lumina_node.ino     # ESP32 LED and sensor firmware
└── README.md
```

---

## Technology Stack

### Backend

- Python
- Flask
- OpenCV
- Ultralytics YOLO
- MQTT
- NumPy
- Custom graph-routing logic

### Frontend

- React
- Vite
- JavaScript
- SVG-based digital twin
- REST API and MQTT integration

### Hardware

- ESP32
- WS2812B LED strips
- Camera
- Thermal sensor
- Ultrasonic sensor
- Buzzer
- Local network connection

---

## Quick Start

### Prerequisites

- Python 3.10+
- Node.js 18+
- Webcam or USB camera
- ESP32 hardware for the physical LED demonstration, where applicable

### 1. Start the backend

```bash
cd backend
pip install -r requirements.txt
```

Download the YOLO model on first use:

```bash
python -c "from ultralytics import YOLO; YOLO('yolov8n-pose.pt')"
```

Run the backend:

```bash
python lumina_live_stream.py
```

The backend normally starts on:

```text
http://localhost:5001
```

### 2. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

---

## Access from an iPad or Second Device

The dashboard and backend must use the laptop's local network IP instead of `127.0.0.1`.

1. Find the laptop's Wi-Fi IPv4 address.

   **Windows**

   ```bash
   ipconfig
   ```

   **macOS/Linux**

   ```bash
   ifconfig
   ```
2. Update `FLASK_IP` in `frontend/src/App.jsx`.

   ```js
   const FLASK_IP = "192.168.x.x";
   ```
3. Make sure the laptop and second device are on the same network.
4. Start Vite with network access if required.

   ```bash
   npm run dev -- --host 0.0.0.0
   ```
5. Open the dashboard on the second device.

   ```text
   http://<LAPTOP_IP>:5173
   ```

The backend must also listen on the local network, and the firewall must allow the required ports.

---

## System Architecture

```text
Sensors and cameras
        │
        ▼
Local AI and sensor processing
        │
        ▼
MQTT / REST communication
        │
        ▼
Floor edge gateway and shared building graph
        │
        ▼
Dynamic A*-based routing engine
        │
        ├──► Live digital twin dashboard
        └──► ESP32 LED and buzzer output
```

### Coordination model

Lumina uses **distributed detection but coordinated decision-making**.

Individual nodes detect local conditions and publish timestamped events. The floor edge gateway combines these events, removes duplicates, updates one shared building graph, and distributes one synchronised route.

The nodes do not independently issue competing evacuation routes.

---

## Detect

### Computer vision

The prototype uses YOLO-based computer vision to support:

- Occupancy counting
- Crowd-density estimation
- Possible fallen-person detection
- Crowd movement monitoring

The system is intended to process anonymous occupancy and posture information without requiring facial recognition.

### Environmental sensing

The prototype can receive data from:

- Thermal sensors for abnormal heat
- Ultrasonic sensors for corridor obstruction
- Microphone input for acoustic-event analysis
- Device-health and connectivity monitoring

A commercial deployment should use calibrated, suitable sensing hardware and formal validation procedures.

---

## Decide: Dynamic A*-Based Routing

The building floor plan is represented as a weighted graph:

- **Nodes:** junctions, doors, hazard locations, refuge areas, and exits
- **Edges:** traversable corridor connections
- **Costs:** distance, hazard risk, congestion, obstruction, and accessibility constraints

The routing engine follows the A* principle:

```text
Estimated route cost = travelled cost + estimated remaining cost
```

When conditions change, the graph is updated and the route is recalculated.

### Example routing treatment

| Condition                 | Routing treatment                        |
| ------------------------- | ---------------------------------------- |
| Confirmed fire zone       | Impassable or extreme penalty            |
| Structural obstruction    | Impassable                               |
| Severe crowd congestion   | High penalty or block                    |
| Moderate crowd congestion | Additional cost                          |
| Possible fallen person    | Protected buffer or configurable penalty |
| Failed guidance node      | Marked unavailable                       |
| Inaccessible path         | Excluded for an accessible route         |

The system compares routes to available exits and selects the lowest-cost valid path. A longer route may be chosen when it is safer than the physically nearest exit.

### No-route behaviour

When no verified safe path exists, Lumina must not invent one.

The intended fallback flow is:

1. Return a **no safe route available** state.
2. Stop displaying an unverified dynamic route.
3. Apply the building's approved fallback procedure.
4. Alert the control room and responders.
5. Direct occupants to a designated refuge area only when approved by the building's emergency plan.

Final emergency decisions remain subject to approved procedures and responder authority.

---

## IoT Pull Policy

The Pull Policy is designed to reduce bottlenecks before occupants enter a congested corridor.

```text
Downstream congestion detected
        ↓
Upstream junction receives a stop or redirect instruction
        ↓
Occupants are held or rerouted before entering the bottleneck
```

The current prototype represents this through dashboard signals and LED route changes.

---

## Guide

### Current prototype

- **Green WS2812B LEDs:** safer route
- **Red LEDs:** hazard or blocked area
- **Blinking hazard node:** active hazard location
- **Dashboard:** route, hazard, crowd, exit, and device status
- **Buzzer:** simple alert beep only

The current buzzer does **not** provide directional navigation.

### Proposed commercial output

A future product could replace or complement LEDs with:

- DLP-projected arrows
- Stop symbols and hazard boundaries
- Zone-based directional audio
- Voice instructions
- Certified visual and audible alarms
- Refuge-area communication

DLP may provide clearer and more flexible low-level visual instructions than LEDs, but it is not smoke-proof and requires controlled visibility testing.

---

## Accessibility Layer

Lumina is intended to deliver the same emergency decision through multiple channels.

| Occupant need                    | Proposed support                                             |
| -------------------------------- | ------------------------------------------------------------ |
| Blind or visually impaired       | Audio or voice instructions, tactile features, staff support |
| Deaf or hard of hearing          | Visual route, text, certified flashing alert                 |
| Wheelchair or reduced mobility   | Step-free route or approved refuge procedure                 |
| Cognitive or learning disability | Short, consistent, one-step instructions                     |
| Fallen or injured occupant       | Protected buffer and responder alert                         |
| Speech disability                | Help button or text-based refuge communication               |

The prototype currently demonstrates visual guidance and a basic buzzer alert. Full accessibility requires tested commercial hardware, approved procedures, and human assistance.

---

## Existing-Building Integration

Lumina is designed to reuse existing infrastructure where technically and legally suitable.

```text
Existing CCTV / Fire Alarm / BMS / Access Control
                         │
                         ▼
              Controlled integration gateway
                         │
                         ▼
          Lumina edge server and digital twin
                         │
                         ▼
              Dynamic evacuation guidance
```

Possible integration methods include:

- Authorised CCTV streams through RTSP, ONVIF, or VMS interfaces
- Approved fire-alarm panel event interfaces
- BMS data for doors, ventilation, lifts, power, and sensors
- Access-control status for door availability

Existing systems remain independently operational. Lumina does not replace the official fire-alarm system, mandatory exit signs, or approved emergency procedures.

---

## Power and Network Resilience

### Power failure

A proposed deployment should include:

- Local node batteries
- UPS for gateways and local servers
- Emergency power or generator integration
- Battery-health monitoring
- Automatic power switchover

The exact backup runtime must be validated through power testing and applicable requirements.

### Internet failure

Emergency routing is intended to run locally at the edge. A cloud outage should affect remote analytics rather than local routing.

### Local network or node failure

- Disconnected nodes are marked unavailable.
- Old route messages are rejected using timestamps or route-version numbers.
- Nodes display only the latest verified instruction.
- If route integrity cannot be confirmed, dynamic guidance stops and the system falls back to approved emergency procedures.

---

## Manual Responder Controls

The dashboard includes manual controls intended for authorised personnel:

| Control          | Purpose                                     |
| ---------------- | ------------------------------------------- |
| Block corridor   | Mark a selected node as impassable          |
| Reroute          | Recalculate around a hazard or obstruction  |
| Quick exit route | Compare available routes to exits           |
| Reset system     | Clear simulation and manual states          |
| No-route alert   | Flag zones requiring responder intervention |

Manual commands should be logged, timestamped, and restricted to authorised users in a production deployment.

---

## Demo Day Checklist

- [ ] Set the correct `FLASK_IP`
- [ ] Confirm backend and frontend are running
- [ ] Run `python test_integration.py`
- [ ] Verify the camera feed
- [ ] Confirm MQTT connection
- [ ] Check ESP32 and LED power
- [ ] Test fire simulation
- [ ] Test obstruction simulation
- [ ] Test fallen-person simulation
- [ ] Test multiple simultaneous hazards
- [ ] Verify blocked nodes are never crossed
- [ ] Verify no-route fallback appears correctly
- [ ] Verify hazard icons remain aligned on different screen sizes
- [ ] Test dashboard on the iPad or second device
- [ ] Reset the system before presenting

---

## Testing and Validation

The prototype should be evaluated through:

- Unit tests for routing behaviour
- Integration tests for backend, MQTT, dashboard, and ESP32
- Multi-hazard scenario testing
- Route correctness checks
- Sensor persistence and false-alarm testing
- End-to-end latency measurement
- Power-failure and network-failure testing
- Controlled accessibility trials
- Controlled corridor or building pilot
- Consultation with fire-safety professionals and relevant authorities

Do not claim production readiness until the required testing, certification, and regulatory review are completed.

---

## Known Limitations

- The prototype is not a certified life-safety system.
- The current buzzer is a simple alert, not directional audio.
- LED strips represent the proposed commercial projection concept.
- Camera performance depends on angle, lighting, occlusion, and training data.
- Existing CCTV can only be reused when image quality and coverage are sufficient.
- Thermal, obstruction, and fall-detection thresholds require further calibration.
- Backup runtime has not yet been formally validated.
- Large-scale deployment and multi-gateway performance require further testing.
- Financial and safety benefits remain preliminary until supported by pilot data.

---

## Competition Achievement

Siew Pow Team achieved **1st Runner-Up** in the **Tech 4 Good Challenge 2026 Grand Finale** at the ViTrox Campus in Penang.

The team was selected as one of the University Category finalists and presented Lumina as an adaptive, inclusive, and edge-enabled evacuation concept.

We sincerely appreciate the guidance and support provided by our mentors, lecturers, APU, the organisers, judges, and everyone who contributed to this journey.

---

## Team

- **Lai Zi Huey** — Team Leader
- **Low Wei Ling**
- **Woo May Eng**

**Asia Pacific University of Technology & Innovation (APU)**

---

## Responsible Use

Lumina is an academic prototype and research concept. It must not be used as the sole basis for real emergency evacuation decisions.

Real deployment requires:

- Formal safety engineering
- Regulatory approval
- Building-specific risk assessment
- Hardware certification
- Cybersecurity assessment
- Accessibility validation
- Controlled field testing
- Integration with approved emergency procedures
- Responder and facility-management oversight

---

## Copyright

Copyright © 2026 Siew Pow Team. All rights reserved.

The source code and project materials in this repository are provided for academic review, portfolio presentation, and demonstration purposes only.

No permission is granted to copy, modify, redistribute, sublicense, publish, or use the software or project materials commercially without prior written permission from the copyright holders.

Unless a separate written agreement is provided, this repository is **not open source**.

Third-party libraries, models, frameworks, logos, datasets, and other external materials remain subject to their respective licences and ownership term

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

## Demo Day Checklist

Run through this before every presentation session.

- [ ] Change `FLASK_IP` in `App.jsx` to laptop Wi-Fi IP
- [ ] Run `python test_integration.py` — all 5 must pass
- [ ] Verify camera feed visible in browser at `localhost:5173`
- [ ] Confirm amber DEV MODE banner is gone on the dashboard
- [ ] iPad connected to same Wi-Fi hotspot as laptop
- [ ] Dashboard loads on iPad at `http://<FLASK_IP>:5173`
- [ ] Test scenario: play 520Hz tone near microphone → FFT confirms → route changes
- [ ] Export Report works and opens cleanly in Excel (now a formatted .xlsx workbook with multiple sheets, not CSV)

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

**Graduated hazard severity** — not every hazard is treated the same way, matching real evacuation protocol rather than a single blanket rule:

- **Fire, and crowd density at genuine crush level (80+ people, sustained)** are hard blocks — the routing algorithm will never send anyone through them, full stop, regardless of whether that's the only remaining path.
- **A fallen person, and crowd density below crush level**, are soft cost penalties only — routes prefer to avoid them but will still use them if that's genuinely the best or only option, the same way a real evacuee would step around someone on the ground rather than treating the whole corridor as unusable.
- This means a route is only ever refused outright ("Area of Refuge — dispatch rescue") when *every* path is blocked by something genuinely life-threatening, not merely inconvenient.

**IoT Pull Policy** — Upstream nodes project RED stop lines when downstream corridors are congested. Prevents fatal bottlenecks before they form (prevention, not just response).

**Dual-signal Fall Detection** — Combines YOLOv8 keypoint check (nose Y > hip Y) with bounding box aspect ratio check (width > 1.3× height). Either signal triggers detection; both together gives `DUAL` confidence shown on the HUD.

**FFT Acoustic Classifier** — Listens for the 520Hz NFPA 72 FACP alarm frequency. Rejects ambient noise via signal-to-noise ratio threshold. Only confirms hazard after both thermal anomaly AND acoustic confirmation.

---

## BOMBA / Incident Commander Controls

All manual override controls are in the **Digital Twin expanded view** (click the floor plan to expand):

| Control                       | What it does                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Select node → REROUTE AROUND | BOMBA manually quarantines a node and forces DYN-A\* to re-route                                                                          |
| BOMBA — QUICK REROUTE        | Ranked routes to every real exit (Exit 1 / 3 / 4), labeled BEST / 2nd / 3rd by distance — one click sends evacuees to that exit directly |
| RESET SYSTEM                  | Releases manual override and returns system to AUTO mode                                                                                  |

Manual override locks all hazard state — the backend poll cannot overwrite BOMBA commands until RESET is pressed.

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
