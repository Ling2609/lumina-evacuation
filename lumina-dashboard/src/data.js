export const nodeData = [
  { id: "N-042", zone: "Sector 4 / Retail A",   status: "normal", hazard: null, temp: 27, crowd: 0, x: 30, y: 35 },
  { id: "N-043", zone: "Sector 4 / Corridor B",  status: "normal", hazard: null, temp: 27, crowd: 0, x: 52, y: 35 },
  { id: "N-011", zone: "Sector 1 / Lobby",       status: "normal", hazard: null, temp: 27, crowd: 0, x: 15, y: 60 },
  { id: "N-067", zone: "Sector 6 / Stairwell",   status: "normal", hazard: null, temp: 27, crowd: 0, x: 72, y: 55 },
  { id: "N-089", zone: "Sector 8 / Exit East",   status: "normal", hazard: null, temp: 27, crowd: 0, x: 85, y: 75 },
  { id: "N-031", zone: "Sector 3 / Office",      status: "normal", hazard: null, temp: 27, crowd: 0, x: 40, y: 65 },
];

export const eventLog = [
  { time: "T-00s", msg: "Thermal anomaly detected — Node #042, Sector 4", level: "danger" },
  { time: "T-01s", msg: "Edge AI processing initiated (<500ms)", level: "info" },
  { time: "T-02s", msg: "RED local quarantine zone projected — Sector 4 Retail", level: "danger" },
  { time: "T-04s", msg: "Mesh communication — adjacent nodes rerouting vectors", level: "warning" },
  { time: "T-06s", msg: "FACP PAS countdown initiated — 178s to global alarm", level: "warning" },
  { time: "T-08s", msg: "DYN-A* routing activated — safe egress projected GREEN", level: "success" },
  { time: "T-12s", msg: "Crowd congestion detected — Node #043 PULL policy active", level: "danger" },
  { time: "T-15s", msg: "BOMBA commlink dispatched — situational awareness relayed", level: "info" },
];