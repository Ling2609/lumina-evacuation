export const nodeData = [
  { id: "N-042", zone: "Sector 4 / Retail A",   status: "normal", hazard: null, temp: 27, crowd: 0, x: 30, y: 35 },
  { id: "N-043", zone: "Sector 4 / Corridor B",  status: "normal", hazard: null, temp: 27, crowd: 0, x: 52, y: 35 },
  { id: "N-011", zone: "Sector 1 / Lobby",       status: "normal", hazard: null, temp: 27, crowd: 0, x: 15, y: 60 },
  { id: "N-067", zone: "Sector 6 / Stairwell",   status: "normal", hazard: null, temp: 27, crowd: 0, x: 72, y: 55 },
  { id: "N-089", zone: "Sector 8 / Exit East",   status: "normal", hazard: null, temp: 27, crowd: 0, x: 85, y: 75 },
  { id: "N-031", zone: "Sector 3 / Office",      status: "normal", hazard: null, temp: 27, crowd: 0, x: 40, y: 65 },
];

export const eventLog = [
  { time: "INIT", msg: "Lumina system online — all subsystems nominal", level: "success" },
  { time: "INIT", msg: "DYN-A* routing engine loaded — default route active", level: "info" },
  { time: "INIT", msg: "Thermal classifier ready — Z-score baseline calibrating", level: "info" },
  { time: "INIT", msg: "FFT classifier ready — listening for 520Hz FACP tone", level: "info" },
  { time: "INIT", msg: "MQTT broker connected — awaiting sensor telemetry", level: "info" },
];