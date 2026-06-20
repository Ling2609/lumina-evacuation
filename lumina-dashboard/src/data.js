// =============================================================================
// LUMINA — data.js
// Node data: 20 junctions (J1-J20) + 5 exits = 25 routing nodes
// Store doors (B1-B16) are display-only in App.jsx, not routing nodes
// =============================================================================

export const nodeData = [
  // Junction nodes — where Lumina hardware monitors crowd/hazard
  { id:"J1",  zone:"West Corridor (Exit 1 approach)", status:"normal", hazard:null, temp:27, crowd:0, x:120.2, y:331.7 },
  { id:"J2",  zone:"West Corridor Upper",              status:"normal", hazard:null, temp:27, crowd:0, x:120.2, y:264.6 },
  { id:"J3",  zone:"Left-Center Junction",             status:"normal", hazard:null, temp:27, crowd:0, x:205.9, y:264.6 },
  { id:"J4",  zone:"Central Crossroad",                status:"normal", hazard:null, temp:27, crowd:0, x:381.2, y:264.6 },
  { id:"J5",  zone:"Top Branch (Exit 2 vertical)",     status:"normal", hazard:null, temp:27, crowd:0, x:381.2, y:103.5 },
  { id:"J6",  zone:"Exit 2 Junction",                  status:"normal", hazard:null, temp:27, crowd:0, x:282.0, y:103.5 },
  { id:"J7",  zone:"Center-Right Junction",            status:"normal", hazard:null, temp:27, crowd:0, x:456.3, y:264.6 },
  { id:"J8",  zone:"East Corridor Upper",              status:"normal", hazard:null, temp:27, crowd:0, x:582.4, y:264.6 },
  { id:"J9",  zone:"East Corridor (Exit 3 branch)",    status:"normal", hazard:null, temp:27, crowd:0, x:582.4, y:167.8 },
  { id:"J10", zone:"Exit 3 Junction",                  status:"normal", hazard:null, temp:27, crowd:0, x:582.4, y: 86.8 },
  { id:"J11", zone:"East Corridor Lower",              status:"normal", hazard:null, temp:27, crowd:0, x:582.4, y:356.9 },
  { id:"J12", zone:"East-South Junction",              status:"normal", hazard:null, temp:27, crowd:0, x:582.4, y:469.1 },
  { id:"J13", zone:"Exit 4 Junction",                  status:"normal", hazard:null, temp:27, crowd:0, x:701.3, y:469.1 },
  { id:"J14", zone:"Bottom-Right Junction",            status:"normal", hazard:null, temp:27, crowd:0, x:475.1, y:469.1 },
  { id:"J15", zone:"South-Center Junction",            status:"normal", hazard:null, temp:27, crowd:0, x:381.2, y:469.1 },
  { id:"J16", zone:"Center Vertical Junction",         status:"normal", hazard:null, temp:27, crowd:0, x:381.2, y:375.9 },
  { id:"J17", zone:"Bottom Corridor Right",            status:"normal", hazard:null, temp:27, crowd:0, x:381.2, y:576.9 },
  { id:"J18", zone:"Exit 5 Junction",                  status:"normal", hazard:null, temp:27, crowd:0, x:205.9, y:576.9 },
  { id:"J19", zone:"South-West Junction",              status:"normal", hazard:null, temp:27, crowd:0, x:205.9, y:511.2 },
  { id:"J20", zone:"Left Lower Junction",              status:"normal", hazard:null, temp:27, crowd:0, x:205.9, y:464.7 },
  // Exit nodes
  { id:"EXIT-1", zone:"Exit 1 — West",          status:"normal", hazard:null, temp:27, crowd:0, x: 15.4, y:331.7 },
  { id:"EXIT-2", zone:"Exit 2 — North Center",  status:"normal", hazard:null, temp:27, crowd:0, x:282.0, y: 12.3 },
  { id:"EXIT-3", zone:"Exit 3 — North East",    status:"normal", hazard:null, temp:27, crowd:0, x:582.4, y: 12.3 },
  { id:"EXIT-4", zone:"Exit 4 — East",          status:"normal", hazard:null, temp:27, crowd:0, x:751.7, y:469.1 },
  { id:"EXIT-5", zone:"Exit 5 — Assembly Point",status:"normal", hazard:null, temp:27, crowd:0, x:205.9, y:675.8 },
];

export const eventLog = [
  { time:"INIT", msg:"Lumina system online — all subsystems nominal",                    level:"success" },
  { time:"INIT", msg:"DYN-A* engine loaded — 20 junctions, 5 exits, hysteresis ON",     level:"info"    },
  { time:"INIT", msg:"Capacity-constrained edges active — Fruin LOS D threshold: 80pax",level:"info"    },
  { time:"INIT", msg:"Thermal classifier ready — Z-score baseline calibrating",          level:"info"    },
  { time:"INIT", msg:"FFT classifier ready — 520Hz FACP failsafe listening",             level:"info"    },
  { time:"INIT", msg:"MQTT broker connected — 6 Lumina nodes online",                    level:"info"    },
];
