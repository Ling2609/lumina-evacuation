import { useState, useEffect, useRef } from "react";
import mqtt from "mqtt";
import { palette } from "./theme";
import { eventLog, nodeData } from "./data";
import { MetricCard } from "./components/UIComponents";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const FLASK_IP    = "127.0.0.1";   // <- CHANGE FOR IPAD DEMO
const FLASK_PORT  = 5001;
const MQTT_BROKER = "ws://broker.hivemq.com:8000/mqtt";
const MQTT_TOPIC  = "lumina/vitrox/demo/7a9b2f/alerts";
const POLL_MS     = 1500;
const HEALTH_MS   = 5000;

if (FLASK_IP === "127.0.0.1")
  console.warn("[LUMINA] FLASK_IP is 127.0.0.1 — iPad dashboard will not load.");

const FALLBACK_NODES = nodeData.map(n => ({...n, status:"normal", hazard:null, crowd:0, temp:27}));
const apiUrl = path => `http://${FLASK_IP}:${FLASK_PORT}${path}`;

const ZONE_COLORS = {yellow:"#FEF9C3",orange:"#FFEDD5",purple:"#EDE9FE",pink:"#FFE4E6"};

// Store door positions for route drawing (door → junction → exit)
const DOOR_POS = {
  B1:{x:120.1,y:219.1,label:"Siew Later Restaurant"}, B2:{x:205.7,y:219.1,label:"BawangTea"},
  B3:{x:282.1,y:130.5,label:"Chill Zone"},     B4:{x:380.6,y:219.1,label:"Empty Space"},
  B5:{x:455.8,y:219.1,label:"Thai Relax Massage"}, B6:{x:660.2,y:86.8, label:"Female Washroom"},
  B7:{x:660.2,y:167.4,label:"Male Washroom"},  B8:{x:640.5,y:357.0,label:"Ali Barber"},
  B9:{x:396.6,y:375.4,label:"Mamadini"},       B10:{x:325.8,y:375.4,label:"Public Recipe"},
  B11:{x:117.6,y:464.1,label:"Meating Room"},  B12:{x:117.6,y:576.7,label:"Baskin Batman"},
  B13:{x:221.7,y:510.8,label:"Customer Service"},
  B14:{x:474.8,y:501.6,label:"MS. DIY"},       B15:{x:582.0,y:501.6,label:"SofaSoGood"},
  B16:{x:700.9,y:501.6,label:"ReadMe Bookstore"},
};

// Store door → nearest corridor junction (matches routing_engine.py DOOR_TO_JUNCTION)
const DOOR_TO_J = {
  B1:"J2", B2:"J3", B3:"J6", B4:"J4", B5:"J7", B6:"J10",
  B7:"J9", B8:"J11", B9:"J16", B10:"J16", B11:"J20", B12:"J18",
  B13:"J19", B14:"J14", B15:"J12", B16:"J13",
};

// 6 physical Lumina nodes — coverage areas
const LUMINA_NODE_DEFS = {
  // cx/cy = representative open-corridor mounting position for each node's
  // covered junction cluster. Pure centroid-of-junctions placed NODE-B,
  // NODE-C, and NODE-F within ~12-15 units of a room wall (mathematically
  // "outside" the polygon but not realistic ceiling-mount clearance) —
  // nudged into clear corridor space while staying representative of the
  // cluster's actual junction layout.
  "NODE-A":{label:"West Corridor",    color:"#3B82F6", cx:148.6,cy:286.6},
  "NODE-B":{label:"Central Crossroad",color:"#8B5CF6", cx:380.6,cy:264.0},
  "NODE-C":{label:"East Corridor",    color:"#EF4444", cx:560.0,cy:264.0},
  "NODE-D":{label:"South-Central",    color:"#10B981", cx:380.6,cy:466.8},
  "NODE-E":{label:"South-West",       color:"#F59E0B", cx:205.7,cy:517.2},
  "NODE-F":{label:"East-South",       color:"#EC4899", cx:582.0,cy:469.0},
};

// Junction to Lumina node mapping
const J_TO_NODE = {
  J1:"NODE-A",J2:"NODE-A",J3:"NODE-A",
  J4:"NODE-B",J5:"NODE-B",J6:"NODE-B",J7:"NODE-B",
  J8:"NODE-C",J9:"NODE-C",J10:"NODE-C",J11:"NODE-C",
  J15:"NODE-D",J16:"NODE-D",
  J18:"NODE-E",J19:"NODE-E",J20:"NODE-E",
  J12:"NODE-F",J13:"NODE-F",J14:"NODE-F",J17:"NODE-F",
};

// Room polygon shapes for the Digital Twin floor plan — also reused as a
// faint background layer on the Node Map so Lumina hardware positions can
// be seen relative to actual store locations, not just on a blank grid.
const ROOM_POLYGONS = [
  {pts:"15.4,12.3 15.4,219.1 162.6,219.1 162.6,12.3",            l1:"Siew Later",   l2:"Restaurant", cx:89.0,  cy:115.7, fill:"#FEF9C3", rid:"J2"},
  {pts:"162.6,12.3 162.6,219.1 248.2,219.1 248.2,12.3",          l1:"BawangTea",    l2:"",           cx:205.4, cy:115.7, fill:"#FEF9C3", rid:"J3"},
  {pts:"248.2,12.3 248.2,219.1 410.2,219.1 410.2,12.3",          l1:"",             l2:"",           cx:329.2, cy:115.7, fill:"#FEF9C3", rid:"J4"},
  {pts:"248.2,130.5 248.2,219.1 359.1,219.1 359.1,130.5",        l1:"Chill Zone",   l2:"",           cx:303.7, cy:174.8, fill:"#FEF9C3", rid:"J6"},
  {pts:"410.2,12.3 410.2,219.1 487.2,219.1 558.6,132.3 558.6,12.3", l1:"Thai Relax",l2:"Massage",   cx:469.7, cy:115.7, fill:"#FEF9C3", rid:"J7"},
  {pts:"660.2,12.3 660.2,126.8 751.4,126.8 751.4,12.3",          l1:"Female",       l2:"Washroom",   cx:705.8, cy:69.6,  fill:"#FFE4E6", rid:"J10"},
  {pts:"660.2,126.8 751.4,126.8 751.4,251.1 660.2,251.1",        l1:"Male",         l2:"Washroom",   cx:705.8, cy:189.0, fill:"#FFE4E6", rid:"J9"},
  {pts:"660.2,251.1 660.2,223.4 594.3,223.4 594.3,306.5 640.5,307.7 640.5,406.8 751.4,406.8 751.4,251.1", l1:"Ali Barber",l2:"", cx:695.9, cy:330.0, fill:"#FFE4E6", rid:"J11"},
  {pts:"396.6,305.3 396.6,432.0 524.1,432.0 524.1,305.3",        l1:"Mamadini",     l2:"",           cx:460.4, cy:368.7, fill:"#EDE9FE", rid:"J16"},
  {pts:"325.8,432.0 325.8,305.3 221.7,305.3 221.7,432.0",        l1:"Public",       l2:"Recipe",     cx:273.8, cy:368.7, fill:"#FFEDD5", rid:"J16"},
  {pts:"15.4,396.4 15.4,528.7 117.6,528.7 117.6,396.4",          l1:"Meating",      l2:"Room",       cx:66.5,  cy:462.6, fill:"#FFEDD5", rid:"J20"},
  {pts:"15.4,528.7 15.4,675.8 117.6,675.8 117.6,528.7",          l1:"Baskin",       l2:"Batman",     cx:66.5,  cy:602.3, fill:"#FFEDD5", rid:"J18"},
  {pts:"392.3,501.6 392.3,675.8 529.7,675.8 529.7,501.6",        l1:"MS. DIY",      l2:"",           cx:461.0, cy:588.7, fill:"#EDE9FE", rid:"J17"},
  {pts:"529.7,501.6 529.7,675.8 649.1,675.8 649.1,501.6",        l1:"SofaSoGood",   l2:"",           cx:589.4, cy:588.7, fill:"#EDE9FE", rid:"J12"},
  {pts:"649.1,501.6 649.1,675.8 751.4,675.8 751.4,501.6",        l1:"ReadMe",       l2:"Bookstore",  cx:700.3, cy:588.7, fill:"#EDE9FE", rid:"J13"},
];

const JUNCTIONS = {
  J1:{x:120.1,y:331.7}, J2:{x:120.1,y:264.0}, J3:{x:205.7,y:264.0},
  J4:{x:380.6,y:264.0}, J5:{x:380.6,y:103.4}, J6:{x:282.1,y:103.4},
  J7:{x:455.8,y:264.0}, J8:{x:582.0,y:264.0}, J9:{x:582.0,y:167.4},
  J10:{x:582.0,y:86.8}, J11:{x:582.0,y:357.0}, J12:{x:582.0,y:469.0},
  J13:{x:700.9,y:469.0}, J14:{x:474.8,y:469.0}, J15:{x:380.6,y:469.0},
  J16:{x:380.6,y:375.4}, J17:{x:380.6,y:576.7}, J18:{x:205.7,y:576.7},
  J19:{x:205.7,y:510.8}, J20:{x:205.7,y:464.1},
};
const EXIT_POS = {
  "EXIT-1":{x:15.4, y:331.7, label:"Exit 1"},
  "EXIT-2":{x:282.1, y:12.3, label:"Exit 2"},
  "EXIT-3":{x:582.0, y:12.3, label:"Exit 3"},
  "EXIT-4":{x:751.4, y:469.0, label:"Exit 4"},
  "EXIT-5":{x:205.7, y:675.8, label:"Exit 5"},
};
const STORE_DOTS = [
  {x:120.2,y:219.3,label:"Siew Later",    zone:"yellow"},
  {x:205.9,y:219.3,label:"BawangTea",     zone:"yellow"},
  {x:282.0,y:130.5,label:"Chill Zone",    zone:"yellow"},
  {x:381.2,y:219.3,label:"Empty Space",   zone:"yellow"},
  {x:456.3,y:219.3,label:"Thai Relax",    zone:"yellow"},
  {x:660.5,y: 86.8,label:"Female WR",     zone:"pink"},
  {x:660.5,y:167.8,label:"Male WR",       zone:"pink"},
  {x:640.7,y:357.0,label:"Ali Barber",    zone:"pink"},
  {x:396.8,y:375.9,label:"Mamadini",      zone:"purple"},
  {x:325.9,y:375.9,label:"Public Recipe", zone:"orange"},
  {x:117.6,y:464.7,label:"Meating Rm",    zone:"orange"},
  {x:117.6,y:576.9,label:"Baskin Batman", zone:"orange"},
  {x:272.3,y:511.2,label:"Customer Svc",  zone:"orange"},
  {x:475.1,y:501.8,label:"MS. DIY",       zone:"purple"},
  {x:582.4,y:501.8,label:"SofaSoGood",    zone:"purple"},
  {x:701.3,y:501.8,label:"ReadMe",        zone:"purple"},
];




// Corridor backbone edges — exact train-map topology, no diagonals, no skipping
const CORRIDOR_EDGES = [
  ["J1","EXIT-1"],["J1","J2"],["J2","J3"],
  ["J3","J4"],["J3","J20"],
  ["J4","J5"],["J4","J7"],["J4","J16"],
  ["J5","J6"],["J6","EXIT-2"],
  ["J7","J8"],["J8","J9"],["J8","J11"],
  ["J9","J10"],["J10","EXIT-3"],
  ["J11","J12"],["J12","J13"],["J12","J14"],
  ["J13","EXIT-4"],["J14","J15"],
  ["J15","J16"],["J15","J17"],
  ["J16","J4"],
  ["J17","J18"],["J18","EXIT-5"],["J18","J19"],
  ["J19","J20"],["J20","J3"],
];



// Build route points — handles Bx door IDs, junction IDs, and exit IDs
const getRoutePoints = (route) => {
  if (!route || route.length < 2) return "";
  return route.map(id => {
    if (DOOR_POS[id])  return `${DOOR_POS[id].x},${DOOR_POS[id].y}`;
    if (JUNCTIONS[id]) return `${JUNCTIONS[id].x},${JUNCTIONS[id].y}`;
    if (EXIT_POS[id])  return `${EXIT_POS[id].x},${EXIT_POS[id].y}`;
    return null;
  }).filter(Boolean).join(" ");
};


// Get waypoint coordinate sequence for a route segment



// ─── STATUS COLOURS ───────────────────────────────────────────────────────────
const statusColor = s => ({
  alert:"#DC2626", quarantine:"#D97706", warning:"#CA8A04", normal:"#059669"
}[s] ?? "#6B7280");
const statusBg = s => ({
  alert:"#FEF2F2", quarantine:"#FFFBEB", warning:"#FEFCE8", normal:"#ECFDF5"
}[s] ?? "#F3F4F6");
const card = (extra={}) => ({
  background:palette.bgCard, border:`1px solid ${palette.border}`,
  borderRadius:10, ...extra,
});

const initVelHistoryPN  = () => Object.fromEntries(nodeData.map(n=>[n.id, Array(12).fill(0)]));
const initTempHistoryPN = () => Object.fromEntries(nodeData.map(n=>[n.id, Array(12).fill(27)]));

// Swipeable sparkline card — defined at module scope (React requires this)
function ChartSlider({cards, idx, setIdx, title}) {
  const entry = cards[idx] ?? cards[0];
  if (!entry) return null;
  const d = entry.data, w = 100, h = 50;
  // Scale against the actual min/max of THIS series, not a fixed 0 floor.
  // A flat dataset (e.g. thermal idling at a constant 27°C baseline) has
  // min===max, which previously made every point evaluate to y=0 (since
  // value/max = 1 when max IS the value) — collapsing the whole line to
  // the very top edge of the SVG instead of sitting visibly mid-card like
  // a flat-zero series coincidentally does. Padding the range keeps a
  // flat line vertically centered regardless of its absolute value.
  const rawMin = Math.min(...d), rawMax = Math.max(...d);
  const pad    = (rawMax - rawMin) * 0.15 || 1;  // 15% breathing room, min ±1
  const domMin = rawMin - pad, domMax = rawMax + pad;
  const range  = domMax - domMin || 1;
  const yOf    = v => h - ((v - domMin) / range) * h;
  const pts  = d.map((v,i) => `${(i/(d.length-1))*w},${yOf(v)}`).join(" ");
  const area = `${pts} ${w},${h} 0,${h}`;
  const gid  = `sg${entry.nodeId}${title.replace(/\s/g,"")}`;
  return (
    <div style={{background:palette.bgCard,border:`1px solid ${palette.border}`,borderRadius:10,
      padding:"12px 14px",flex:1,minHeight:128,display:"flex",flexDirection:"column",gap:4}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
        <div style={{fontSize:10,fontWeight:600,color:palette.textMuted}}>{title}</div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <button onClick={()=>setIdx(i=>Math.max(0,i-1))} style={{
            width:20,height:20,borderRadius:4,border:`1px solid ${idx>0?palette.info:palette.border}`,
            background:idx>0?palette.infoLight:"transparent",cursor:idx>0?"pointer":"not-allowed",
            color:idx>0?palette.info:palette.textMuted,fontSize:12,display:"flex",
            alignItems:"center",justifyContent:"center",fontWeight:700}}>&#8249;</button>
          <span style={{fontSize:9,color:palette.textMuted,minWidth:32,textAlign:"center"}}>
            {idx+1} / {cards.length}
          </span>
          <button onClick={()=>setIdx(i=>Math.min(cards.length-1,i+1))} style={{
            width:20,height:20,borderRadius:4,border:`1px solid ${idx<cards.length-1?palette.info:palette.border}`,
            background:idx<cards.length-1?palette.infoLight:"transparent",
            cursor:idx<cards.length-1?"pointer":"not-allowed",
            color:idx<cards.length-1?palette.info:palette.textMuted,fontSize:12,display:"flex",
            alignItems:"center",justifyContent:"center",fontWeight:700}}>&#8250;</button>
        </div>
      </div>
      <div style={{fontSize:10,fontWeight:600,color:palette.text}}>{entry.nodeId}
        <span style={{fontSize:9,color:palette.textMuted,marginLeft:6,fontWeight:400}}>{entry.zone}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={entry.color} stopOpacity="0.35"/>
            <stop offset="100%" stopColor={entry.color} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <polygon points={area} fill={`url(#${gid})`}/>
        <polyline points={pts} fill="none" stroke={entry.color} strokeWidth="1.5"/>
        {/* Latest value dot — offset by radius to stay within viewBox */}
        {d.length>1&&(()=>{
          const lx=w-2.5, ly=Math.max(2.5, Math.min(h-2.5, yOf(d[d.length-1])));
          return <circle cx={lx} cy={ly} r="2.5" fill={entry.color}/>;
        })()}
      </svg>
      <div style={{fontSize:10,color:palette.textMuted}}>
        Current: <b style={{color:entry.color}}>{entry.current}{entry.unit}</b>
        {entry.unit==="/rdg"&&parseFloat(entry.current)===0&&(
          <span style={{fontSize:9,color:palette.textMuted,marginLeft:6}}>
            (stable — no change)
          </span>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("command");

  // Always start clean — backend is source of truth, poll syncs within 1.5s
  // Only restore non-hazard UI prefs (none currently needed)
  const [isHazard,      setIsHazard]      = useState(false);
  const [hazardType,    setHazardType]    = useState("HAZARD DETECTED");
  const [fftConfirmed,  setFftConfirmed]  = useState(false);
  const [activeRoute,   setActiveRoute]   = useState(["J19","J18","EXIT-5"]);
  const [pasCountdown,  setPasCountdown]  = useState(178);
  const [personCount,   setPersonCount]   = useState(0);   // CAM-01 live YOLO track count (lobby only)
  const [totalFootfall, setTotalFootfall] = useState(0);   // building-wide total across all nodes
  const [thermalState,  setThermalState]  = useState("NORMAL");
  const [fftState,      setFftState]      = useState("SILENT");
  const [pullSignals,   setPullSignals]   = useState({});
  const [rset,          setRset]          = useState({});
  const [costScore,     setCostScore]     = useState(0);
  const [nodes,         setNodes]         = useState(FALLBACK_NODES);
  const [selectedNode,  setSelectedNode]  = useState(null);
  const [aiMode,        setAiMode]        = useState("DIORAMA");
  const [backendOnline, setBackendOnline] = useState(false);
  const [mqttMsgCount,  setMqttMsgCount]  = useState(0);
  const [mqttStatus,    setMqttStatus]    = useState("CONNECTING");
  const [liveEvents,    setLiveEvents]    = useState(eventLog);
  const [velHistoryPN,  setVelHistoryPN]  = useState(initVelHistoryPN);
  const [tempHistoryPN, setTempHistoryPN] = useState(initTempHistoryPN);
  const [velCardIdx,    setVelCardIdx]    = useState(0);
  const [tempCardIdx,   setTempCardIdx]   = useState(0);
  const [twinExpanded,    setTwinExpanded]    = useState(false);
  const [camExpanded,     setCamExpanded]     = useState(false);
  const [nodeMapExpanded, setNodeMapExpanded] = useState(false);
  const [occupancyExpandedCat, setOccupancyExpandedCat] = useState(null); // null | "High Traffic" | "HVAC Reduce" | "HVAC Increase"
  const [manualOverride,  setManualOverride]  = useState(false);
  const [manualBlockedNode, setManualBlockedNode] = useState(null);
  const [nodeHealthPage, setNodeHealthPage] = useState(0);
  const [quickExitRoutes, setQuickExitRoutes] = useState([]); // sorted best-to-worst from backend
  const [health, setHealth] = useState({
    uptime_s:0, yolo_loaded:false, mqtt_connected:false,
    camera_open:false, nodes_online:198, nodes_total:200,
    thermal_latency_ms:0, fft_latency_ms:0,
    battery:{
      "NODE-A":{pct:94,next_service:"Aug 10"},
      "NODE-B":{pct:87,next_service:"Aug 01"},
      "NODE-C":{pct:91,next_service:"Aug 05"},
      "NODE-D":{pct:72,next_service:"Jul 15"},
      "NODE-E":{pct:88,next_service:"Aug 08"},
      "NODE-F":{pct:85,next_service:"Aug 15"},
    },
  });

  const lastThermalRef    = useRef("NORMAL");
  const lastFftRef        = useRef("SILENT");
  const hazardLockRef     = useRef(0); // timestamp of last CRITICAL event — ignore stale NORMAL polls for 2s
  const lastVelRef        = useRef(false);
  const manualOverrideRef = useRef(false);
  useEffect(()=>{ manualOverrideRef.current = manualOverride; }, [manualOverride]);

  const pushEvent = (msg, level="info", tag=null) => {
    const ts = new Date().toLocaleTimeString("en-GB",{hour12:false});
    setLiveEvents(p => [{time:`${ts}`,msg,level,tag},...p].slice(0,15));
  };

  // ── POLL /api/status ──────────────────────────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(apiUrl("/api/status"),{signal:AbortSignal.timeout(1200)});
        const d   = await res.json();
        setBackendOnline(true);
        setPersonCount(d.person_count??0);
        setTotalFootfall(d.total_footfall??0);
        setAiMode(d.ai_mode??"DIORAMA");
        if (!manualOverrideRef.current) {
          // AUTO mode — backend drives everything
          setIsHazard(d.system_state==="HAZARD");
          setThermalState(d.thermal_state??"NORMAL");
          setFftState(d.fft_state??"SILENT");
          setFftConfirmed(d.facp_confirmed??false);
          // Split-brain fix: ignore stale NORMAL from REST poll if MQTT just said CRITICAL
          const stalePoll = d.system_state==="NORMAL" && (Date.now()-hazardLockRef.current < 2000);
          if (!stalePoll) {
            // Only sync route from backend if not in manual override mode
            if (d.current_route?.length && !manualOverrideRef.current) setActiveRoute(d.current_route);
          }
          if (d.pull_signals) setPullSignals(d.pull_signals);
          if (d.rset) setRset(d.rset);
          if (d.cost_score !== undefined) setCostScore(d.cost_score);
          if (d.nodes) {
            const pm = Object.fromEntries(FALLBACK_NODES.map(n=>[n.id,{x:n.x,y:n.y,zone:n.zone}]));
            const merged = Object.entries(d.nodes).map(([id,v])=>({
              // Junctions/exits get their zone from FALLBACK_NODES; store
              // doors (B1-B16) aren't in that list, so fall back to their
              // DOOR_POS label ("Siew Later") instead of the raw door ID —
              // otherwise the UI rendered "B1  B1" (id + id) side by side.
              id, zone:pm[id]?.zone??DOOR_POS[id]?.label??id, x:pm[id]?.x??DOOR_POS[id]?.x??50, y:pm[id]?.y??DOOR_POS[id]?.y??50,
              temp:v.temp??27, status:v.status, hazard:v.hazard,
              crowd:v.crowd, velocity:v.velocity, pull:v.pull,
            }));
            setNodes(merged);
            setSelectedNode(p=>merged.find(n=>n.id===p?.id)??null);
          }
        } else {
          // MANUAL OVERRIDE — BOMBA has command, only update safe telemetry
          // Hazard state, route, node statuses are NOT overwritten by the poll
          if (d.nodes) {
            setNodes(prev=>prev.map(n=>{
              const live=d.nodes[n.id]; if(!live) return n;
              return {...n, temp:live.temp??n.temp, crowd:live.crowd??n.crowd, velocity:live.velocity??n.velocity};
            }));
          }
        }
        // Per-node history for swipeable sparklines
        if (d.nodes) {
          setVelHistoryPN(prev=>{
            const next={...prev};
            Object.entries(d.nodes).forEach(([id,v])=>{
              if (next[id]) next[id]=[...next[id].slice(1), v.velocity??0];
            });
            return next;
          });
          setTempHistoryPN(prev=>{
            const next={...prev};
            Object.entries(d.nodes).forEach(([id,v])=>{
              if (next[id]) next[id]=[...next[id].slice(1), v.temp??27];
            });
            return next;
          });
        }
        if (d.thermal_state==="ALERT"&&d.thermal_state!==lastThermalRef.current){
          // Find which node has thermal hazard
          const thermalNode = d.nodes ? Object.entries(d.nodes).find(([,v])=>v.hazard==="thermal")?.[0] : "R-thairelax";
          pushEvent(`Thermal anomaly at ${thermalNode||"R-thairelax"} — quarantine projected`,"danger","REACTIVE");
          lastThermalRef.current=d.thermal_state;
        } else if(d.thermal_state!=="ALERT"&&lastThermalRef.current==="ALERT") lastThermalRef.current=d.thermal_state;
        // FFT confirms acoustic alarm — only relevant for fire, not fall
        if (d.fft_state==="CONFIRMED"&&d.fft_state!==lastFftRef.current){
          pushEvent("FFT: 520Hz FACP alarm confirmed — global routing active","warning","REACTIVE");
          lastFftRef.current=d.fft_state;
        } else if(d.fft_state!=="CONFIRMED"&&lastFftRef.current==="CONFIRMED") lastFftRef.current=d.fft_state;
        // Fall detection — check if any node has fall hazard
        if (d.nodes) {
          const fallNode = Object.entries(d.nodes).find(([,v])=>v.hazard==="fall")?.[0];
          if (fallNode && !lastFftRef._fallLogged) {
            pushEvent(`Fall detected at ${fallNode} — buffer zone active, trampling risk`,"danger","REACTIVE");
            lastFftRef._fallLogged = true;
          } else if (!fallNode) {
            lastFftRef._fallLogged = false;
          }
        }
        if ((d.crowd_velocity??0)>5&&!lastVelRef.current){
          pushEvent(`Velocity spike ${d.crowd_velocity?.toFixed(1)}/rdg — pre-emptive reroute`,"warning","PRE-EMPTIVE");
          lastVelRef.current=true;
        } else if((d.crowd_velocity??0)<=5) lastVelRef.current=false;
      } catch { setBackendOnline(false); }
    };
    poll();
    const id=setInterval(poll,POLL_MS);
    return ()=>clearInterval(id);
  },[]);

  // ── Fetch BOMBA quick-exit routes (sorted best→worst by backend) ───────────
  // Depends only on the route ORIGIN (first node), not the whole activeRoute
  // array — activeRoute gets a new array identity on every poll even when
  // its contents are unchanged, so depending on the full array would refetch
  // quick_routes on every single /api/status tick instead of only when the
  // hazard origin actually moves.
  const routeOrigin = activeRoute[0];
  useEffect(()=>{
    if (!routeOrigin) return;
    fetch(apiUrl("/api/quick_routes"),{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({start:routeOrigin})
    }).then(r=>r.json()).then(d=>{
      if (d.routes?.length) setQuickExitRoutes(d.routes);
    }).catch(()=>{});
  },[routeOrigin]);

  // ── POLL /api/health ──────────────────────────────────────────────────────
  useEffect(()=>{
    const h=async()=>{
      try{const r=await fetch(apiUrl("/api/health"),{signal:AbortSignal.timeout(2000)});setHealth(await r.json());}
      catch{ /* backend offline — keep last health values */ }
    };
    h(); const id=setInterval(h,HEALTH_MS); return()=>clearInterval(id);
  },[]);

  // ── MQTT ──────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const c=mqtt.connect(MQTT_BROKER,{reconnectPeriod:3000,connectTimeout:10000});
    c.on("connect",()=>{setMqttStatus("LIVE");c.subscribe(MQTT_TOPIC);});
    c.on("reconnect",()=>setMqttStatus("RECONNECTING"));
    c.on("error",()=>setMqttStatus("OFFLINE"));
    c.on("disconnect",()=>setMqttStatus("OFFLINE"));
    c.on("message",(_,msg)=>{
      try{
        const p=JSON.parse(msg.toString());
        setMqttMsgCount(n=>n+1);
        // MQTT's person_count is always the true building-wide total (see
        // lumina_live_stream.py heartbeat/trigger/fall publishes) — NOT the
        // same metric as the CAM-01 lobby tracker. Routing both REST and
        // MQTT writes into the same state caused the dashboard number to
        // visibly alternate between "1" (camera) and "200+" (building).
        if(p.person_count!==undefined) setTotalFootfall(p.person_count);
        if(p.status==="CRITICAL"){
          const _hzType = p.hazard_type??"HAZARD";
          setIsHazard(true); setHazardType(_hzType);
          setPasCountdown(178);
          if(_hzType==="FALL DETECTED"){
            pushEvent(`Fall detected — buffer zone active, evacuees redirected`,"danger","REACTIVE");
          } else {
            pushEvent(`CRITICAL: ${_hzType}`,"danger","REACTIVE");
          }
        }
        if(p.status==="FACP_CONFIRMED"){
          // FACP only confirms fire — not triggered by fall detection
          setFftConfirmed(true);
          pushEvent("FACP confirmed — 520Hz alarm","warning","REACTIVE");
          pushEvent("RAMO 520Hz directional beacon activated — ADA / NFPA 72 compliant guidance","info");
          pushEvent("Mesh coordination active — fire penalty propagated to adjacent nodes","info","PRE-EMPTIVE");
        }
        if(p.status==="RESOLVED"){
          setIsHazard(false); setPasCountdown(178); setFftConfirmed(false);
          pushEvent("System RESOLVED — back to NORMAL","success","REACTIVE");
        }
      } catch{ /* malformed MQTT payload — ignore */ }
    });
    return()=>c.end();
  },[]);

  // ── FACP timer ────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!isHazard) return;
    const id=setInterval(()=>setPasCountdown(p=>p>0?p-1:0),1000);
    return()=>clearInterval(id);
  },[isHazard]);

  // ── ACTIONS ───────────────────────────────────────────────────────────────
  const resetSystem=async()=>{
    setManualOverride(false);
    setManualBlockedNode(null);
    setActiveRoute(["J19","J18","EXIT-5"]);
    setIsHazard(false); setPasCountdown(178); setFftConfirmed(false); setPullSignals({});
    setActiveRoute(["J19","J18","EXIT-5"]);
    pushEvent("RESET — manual override released, returning to AUTO mode","info");
    try{ await fetch(apiUrl("/reset")); } catch{ /* offline */ }
  };

  const triggerFire=async()=>{
    // No physical thermal sensor in this prototype — fire is triggered manually
    // for demonstration. Fall detection (camera) works independently and
    // does not require this trigger.
    pushEvent("DEMO: Fire simulation triggered at R-thairelax (Thai Relax) — thermal classifier active","danger","REACTIVE");
    try{ await fetch(apiUrl("/trigger")); } catch{ pushEvent("Trigger failed — backend offline","danger"); }
  };

  const toggleAiMode=async()=>{
    const m=aiMode==="DIORAMA"?"ENTERPRISE":"DIORAMA";
    try{ await fetch(apiUrl(`/api/set_mode/${m}`)); } catch{ /* offline */ }
    setAiMode(m);
  };

  const overridePath=async()=>{
    if(!isHazard){ alert("Cannot override during normal operations."); return; }
    // Start from current hazard origin (first node of active route)
    const rawTarget=selectedNode?.id??activeRoute[0]??"J19";
    // Defensive normalization: if a door ID (B1-B16) is ever selected,
    // convert to its junction so manualBlockedNode matches room rid keys
    // and the Digital Twin actually highlights purple on quarantine.
    const target=DOOR_TO_J[rawTarget]||rawTarget;
    // Only reject if THIS node was already manually blocked by BOMBA
    if(target===manualBlockedNode){
      alert(`${target} is already manually blocked. Press RESET to release it.`); return;
    }
    setManualOverride(true);
    try{
      const r=await fetch(apiUrl("/api/block_node"),{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({node_id:target, start:activeRoute[0]||"J16"})});
      const d=await r.json();
      if(d.new_route){
        setManualBlockedNode(target);
        setActiveRoute(d.new_route);
        setNodes(prev=>prev.map(n=>n.id===target?{...n,status:"quarantine",hazard:"crowd"}:n));
        setSelectedNode(null); // clear selection so stale status doesn't confuse next action
        pushEvent(`BOMBA override: ${target} quarantined — route locked. Auto-routing PAUSED.`,"warning","REACTIVE");
      } else {
        pushEvent(`Override failed — no alternate route found from ${target}`,"danger");
      }
    } catch{ pushEvent("Override failed — backend offline","danger"); }
  };

  // ── DERIVED ───────────────────────────────────────────────────────────────
  const rsetTotal   = rset.RSET_s ?? 142;
  const rsetSafe    = rset.safe   ?? true;

  const hazardBorder = isHazard ? `2px solid ${palette.danger}` : `1px solid ${palette.border}`;

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      height:"100vh", overflow:"hidden", display:"flex", flexDirection:"column",
      background:isHazard?"#FFF5F5":palette.bg,
      color:palette.text, fontFamily:"'Inter','Segoe UI',sans-serif",
      fontSize:13, transition:"background 0.4s",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes dash{to{stroke-dashoffset:-28}}
        @keyframes hazardBlink{0%,100%{opacity:0.12}50%{opacity:0.32}}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-thumb{background:#CBD5E1;border-radius:2px}
        button{font-family:inherit;}
      `}</style>

      {/* ── CAMERA EXPANDED MODAL ── */}
      {camExpanded&&(
        <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.85)",
          display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={()=>setCamExpanded(false)}>
          <div style={{background:"#0F172A",borderRadius:12,width:"92vw",maxWidth:1100,
            height:"92vh",display:"flex",flexDirection:"column",overflow:"hidden"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{padding:"10px 16px",borderBottom:"1px solid #1E293B",flexShrink:0,
              display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <span style={{fontWeight:700,fontSize:13,color:"#F1F5F9"}}>{camExpanded.id} — {camExpanded.label}</span>
                <span style={{marginLeft:10,fontSize:10,
                  color:camExpanded.live?"#10B981":"#94A3B8",fontWeight:600}}>
                  {camExpanded.live?"● LIVE":"○ STANDBY"}
                </span>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                {isHazard&&<span style={{fontSize:11,fontWeight:700,color:"#EF4444",
                  background:"#450A0A",padding:"3px 10px",borderRadius:6}}>HAZARD ACTIVE</span>}
                <button onClick={()=>setCamExpanded(false)} style={{background:"#1E293B",
                  border:"1px solid #334155",borderRadius:6,padding:"4px 12px",
                  fontSize:11,cursor:"pointer",color:"#94A3B8"}}>Close</button>
              </div>
            </div>
            <div style={{flex:1,position:"relative",background:"#000",minHeight:0,overflow:"hidden"}}>
              {camExpanded.live
                ? <img src={apiUrl("/video_feed")} alt="expanded"
                    style={{position:"absolute",inset:0,width:"100%",height:"100%",
                      objectFit:"contain",display:"block",
                      filter:isHazard?"sepia(40%) hue-rotate(320deg) saturate(180%)":"none"}}/>
                : <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",
                    justifyContent:"center",flexDirection:"column",gap:12}}>
                    <div style={{fontSize:40,opacity:0.3,color:"#94A3B8"}}>○</div>
                    <span style={{color:"#CBD5E1",fontSize:14,fontWeight:500}}>Camera standby — active in production deployment</span>
                    <span style={{color:"#94A3B8",fontSize:11}}>Node: {camExpanded.label}</span>
                  </div>
              }
            </div>
          </div>
        </div>
      )}

      {/* ── NODE MAP EXPANDED MODAL ── */}
      {nodeMapExpanded&&(
        <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.45)",
          display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={()=>setNodeMapExpanded(false)}>
          <div style={{background:"#fff",borderRadius:12,width:"95vw",maxWidth:1200,
            maxHeight:"92vh",display:"flex",flexDirection:"column",overflow:"hidden"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{padding:"10px 16px",borderBottom:`1px solid ${palette.border}`,
              display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
              <div>
                <span style={{fontWeight:700,fontSize:13,color:palette.text}}>NODE MAP — Full Detail View</span>
                <span style={{marginLeft:12,fontSize:10,color:palette.textMuted}}>
                  {" "}Top-right dot: <b style={{color:palette.success}}>green</b> = battery &gt;75%,
                  <b style={{color:palette.warning}}> orange</b> = 60-75%,
                  <b style={{color:palette.danger}}> red</b> = &lt;60% (NFPA 72 threshold)
                </span>
              </div>
              <button onClick={()=>setNodeMapExpanded(false)} style={{background:palette.grayLight,
                border:`1px solid ${palette.border}`,borderRadius:6,padding:"3px 10px",
                fontSize:11,cursor:"pointer",color:palette.text}}>Close</button>
            </div>
            <div style={{flex:1,display:"grid",gridTemplateColumns:"1fr 1fr",minHeight:0,overflow:"hidden"}}>
              <div style={{borderRight:`1px solid ${palette.border}`,overflow:"hidden",background:"#F8FAFC"}}>
                <svg viewBox="-20 -20 800 740" preserveAspectRatio="xMidYMid meet" style={{width:"100%",height:"100%"}}>
                  {Array.from({length:11},(_,i)=>(<line key={`gv${i}`} x1={i*76} y1={0} x2={i*76} y2={700} stroke="#E2E8F0" strokeWidth="1"/>))}
                  {Array.from({length:11},(_,i)=>(<line key={`gh${i}`} x1={0} y1={i*70} x2={760} y2={i*70} stroke="#E2E8F0" strokeWidth="1"/>))}
                  {/* Faint floor-plan room outlines — same as preview map */}
                  <g opacity="0.35">
                    {ROOM_POLYGONS.map((r,i)=>(
                      <g key={`room${i}`}>
                        <polygon points={r.pts} fill={r.fill} stroke="#94A3B8" strokeWidth="1"/>
                        {r.l1&&<text x={r.cx} y={r.l2?r.cy-4:r.cy} textAnchor="middle" dominantBaseline="central"
                          style={{fontSize:6,fill:"#64748B",fontFamily:"Inter,sans-serif",fontWeight:600}}>{r.l1}</text>}
                        {r.l2&&<text x={r.cx} y={r.cy+5} textAnchor="middle" dominantBaseline="central"
                          style={{fontSize:6,fill:"#64748B",fontFamily:"Inter,sans-serif",fontWeight:600}}>{r.l2}</text>}
                      </g>
                    ))}
                  </g>
                  {/* Faint corridor backbone for spatial context only — not interactive */}
                  {CORRIDOR_EDGES.map(([a,b],i)=>{
                    const pa=JUNCTIONS[a]||EXIT_POS[a]; const pb=JUNCTIONS[b]||EXIT_POS[b];
                    if(!pa||!pb) return null;
                    return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                      stroke="#E2E8F0" strokeWidth="1" strokeDasharray="4 4"/>;
                  })}
                  {/* 6 physical Lumina hardware nodes ONLY — not junctions, not store doors */}
                  {Object.entries(LUMINA_NODE_DEFS).map(([nid,nodeDef])=>{
                    const m=health.battery[nid]??{pct:85,next_service:"N/A"};
                    const bc=m.pct<60?palette.danger:m.pct<75?palette.warning:palette.success;
                    const coveredJ=Object.entries(J_TO_NODE).filter(([,n])=>n===nid).map(([j])=>j);
                    const worst=coveredJ.map(j=>nodes.find(x=>x.id===j)).filter(Boolean)
                      .sort((a,b)=>(b.status==="alert"?3:b.status==="quarantine"?2:b.status==="warning"?1:0)-
                                    (a.status==="alert"?3:a.status==="quarantine"?2:a.status==="warning"?1:0))[0];
                    const c=statusColor(worst?.status??"normal");
                    const isSel=selectedNode?.id===nid;
                    const totalCrowd=coveredJ.reduce((s,j)=>s+(nodes.find(x=>x.id===j)?.crowd??0),0);
                    return(
                      <g key={nid} style={{cursor:"pointer"}}
                        onClick={()=>setSelectedNode(p=>p?.id===nid?null:{id:nid,zone:nodeDef.label,status:worst?.status??"normal",crowd:totalCrowd,temp:worst?.temp??27,velocity:worst?.velocity??0,pull:worst?.pull_signal??"GREEN"})}>
                        {isSel&&<circle cx={nodeDef.cx} cy={nodeDef.cy} r="20" fill={c} opacity="0.15"/>}
                        <circle cx={nodeDef.cx} cy={nodeDef.cy} r={isSel?14:11}
                          fill={nodeDef.color} stroke="#fff" strokeWidth="2"
                          style={worst?.status==="alert"?{animation:"pulse 1s infinite"}:{}}/>
                        <circle cx={nodeDef.cx} cy={nodeDef.cy} r={isSel?14:11} fill="none" stroke={c} strokeWidth="2.5"/>
                        <g>
                          {/* Battery icon: outline body + terminal nub flush on
                              the right + inner fill bar scaled to pct. */}
                          <rect x={nodeDef.cx+13} y={nodeDef.cy-18.9} width={12.6} height={7} rx="1.5"
                            fill="none" stroke={bc} strokeWidth="1"/>
                          <rect x={nodeDef.cx+25.6} y={nodeDef.cy-16.9} width={1.6} height={3} rx="0.5" fill={bc}/>
                          <rect x={nodeDef.cx+14.3} y={nodeDef.cy-17.6} width={Math.max(0.6,10*(m.pct/100))} height={4.6} rx="0.7" fill={bc}/>
                        </g>
                        <text x={nodeDef.cx} y={nodeDef.cy+16} textAnchor="middle"
                          style={{fontSize:"9px",fill:palette.text,fontFamily:"Inter,sans-serif",fontWeight:700}}>
                          {nid}</text>
                        <text x={nodeDef.cx} y={nodeDef.cy+26} textAnchor="middle"
                          style={{fontSize:"7.5px",fill:palette.textMuted,fontFamily:"Inter,sans-serif"}}>
                          {nodeDef.label}</text>
                        <text x={nodeDef.cx} y={nodeDef.cy+36} textAnchor="middle"
                          style={{fontSize:"7px",fill:palette.textMuted,fontFamily:"Inter,sans-serif"}}>
                          {totalCrowd}p total</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div style={{overflow:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,minWidth:520}}>
                  <thead>
                    <tr style={{background:palette.bgCard2,position:"sticky",top:0,zIndex:1}}>
                      {["Node","Covers","Status","Crowd","Battery","Next Svc","Hazard"].map(h=>(
                        <th key={h} style={{padding:"9px 10px",textAlign:"left",fontSize:10,
                          color:palette.textMuted,fontWeight:600,whiteSpace:"nowrap",
                          borderBottom:`1px solid ${palette.border}`}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(LUMINA_NODE_DEFS).map(([nid,nodeDef],i)=>{
                      const m=health.battery[nid]??{pct:85,next_service:"N/A"};
                      const bc=m.pct<60?palette.danger:m.pct<75?palette.warning:palette.success;
                      const coveredJ=Object.entries(J_TO_NODE).filter(([,n])=>n===nid).map(([j])=>j);
                      const worst=coveredJ.map(j=>nodes.find(x=>x.id===j)).filter(Boolean)
                        .sort((a,b)=>(b.status==="alert"?3:b.status==="quarantine"?2:b.status==="warning"?1:0)-
                                      (a.status==="alert"?3:a.status==="quarantine"?2:a.status==="warning"?1:0))[0];
                      const totalCrowd=coveredJ.reduce((s,j)=>s+(nodes.find(x=>x.id===j)?.crowd??0),0);
                      const sc=statusColor(worst?.status??"normal");
                      const isSel=selectedNode?.id===nid;
                      return(
                        <tr key={nid} onClick={()=>setSelectedNode(p=>p?.id===nid?null:{id:nid,zone:nodeDef.label,status:worst?.status??"normal",crowd:totalCrowd})}
                          style={{borderBottom:`1px solid ${palette.border}`,cursor:"pointer",
                            background:isSel?statusBg(worst?.status??"normal"):i%2===0?"transparent":`${palette.bgCard2}55`}}>
                          <td style={{padding:"9px 10px",fontWeight:700,color:nodeDef.color,whiteSpace:"nowrap"}}>{nid}</td>
                          <td style={{padding:"9px 10px",color:palette.textMuted,fontSize:10}}>{nodeDef.label} ({coveredJ.join(", ")})</td>
                          <td style={{padding:"9px 10px"}}>
                            <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:4,
                              background:statusBg(worst?.status??"normal"),color:sc,
                              border:`1px solid ${sc}33`,whiteSpace:"nowrap"}}>{(worst?.status??"normal").toUpperCase()}</span>
                          </td>
                          <td style={{padding:"9px 10px",color:totalCrowd>70?palette.warning:palette.text,fontWeight:600}}>{totalCrowd}p</td>
                          <td style={{padding:"9px 10px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:5}}>
                              <div style={{width:40,height:5,background:palette.grayLight,borderRadius:2,flexShrink:0}}>
                                <div style={{height:"100%",width:`${m.pct}%`,background:bc,borderRadius:2}}/>
                              </div>
                              <span style={{fontSize:10,color:bc,fontWeight:600,whiteSpace:"nowrap"}}>{m.pct}%</span>
                              {m.pct<60&&<span style={{fontSize:9,color:palette.danger,fontWeight:700}}>!</span>}
                            </div>
                          </td>
                          <td style={{padding:"9px 10px",fontSize:10,color:palette.textMuted,whiteSpace:"nowrap"}}>{m.next_service}</td>
                          <td style={{padding:"9px 10px",fontSize:10,
                            color:worst?.hazard?palette.danger:palette.success,whiteSpace:"nowrap"}}>
                            {worst?.hazard?worst.hazard.toUpperCase():"NONE"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── DIGITAL TWIN EXPANDED MODAL ── */}
      {twinExpanded&&(
        <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.5)",
          display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={()=>setTwinExpanded(false)}>
          <div style={{background:"#fff",borderRadius:12,width:"96vw",maxWidth:1300,
            maxHeight:"94vh",display:"flex",flexDirection:"column",overflow:"hidden"}}
            onClick={e=>e.stopPropagation()}>
            <div style={{padding:"10px 16px",borderBottom:`1px solid ${palette.border}`,
              display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
              <span style={{fontWeight:700,fontSize:13,color:palette.text}}>DYN-A* DIGITAL TWIN — Full Command View</span>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                {isHazard&&<span style={{fontSize:11,fontWeight:700,color:palette.danger,
                  background:palette.dangerLight,padding:"3px 10px",borderRadius:6}}>
                  HAZARD ACTIVE — {hazardType}
                </span>}
                <button onClick={()=>setTwinExpanded(false)} style={{background:palette.grayLight,
                  border:`1px solid ${palette.border}`,borderRadius:6,padding:"4px 12px",
                  fontSize:11,cursor:"pointer",color:palette.text}}>Close</button>
              </div>
            </div>
            <div style={{flex:1,display:"grid",gridTemplateColumns:"1fr 280px",minHeight:0,overflow:"hidden"}}>
              <svg viewBox="-30 -30 820 760" style={{width:"100%",height:"100%",background:"#F8FAFC"}}>
                {/* ── Outer wall ── */}
                <polygon points="15.4,12.3 751.7,12.3 751.7,675.8 15.4,675.8"
                  fill="#EEF2F7" stroke="#334155" strokeWidth="2.5"/>

                {/* ── Room polygons with zone colors ── */}
                {ROOM_POLYGONS.map((r,i)=>{
                  const n = r.rid ? nodes.find(x=>x.id===r.rid) : null;
                  const hazardFill = n?.status==="alert"?"#FEE2E2":
                                     n?.id===manualBlockedNode?"#E9D5FF":
                                     n?.status==="quarantine"?"#FEF3C7":null;
                  const fillColor = hazardFill || r.fill || "white";
                  const fs = 8;
                  return(
                    <g key={i}>
                      {r.lines
                        ? <g>
                            <rect x={221.8} y={432.1} width={104.1} height={135.5}
                              fill={fillColor} stroke="none"/>
                            {r.lines.map((l,li)=><line key={li}
                              x1={parseFloat(l.split(" ")[0].split(",")[0])}
                              y1={parseFloat(l.split(" ")[0].split(",")[1])}
                              x2={parseFloat(l.split(" ")[1].split(",")[0])}
                              y2={parseFloat(l.split(" ")[1].split(",")[1])}
                              stroke="#94A3B8" strokeWidth="1.5"/>)}
                          </g>
                        : <polygon points={r.pts} fill={fillColor}
                            stroke="#94A3B8" strokeWidth="1.5"/>
                      }
                      <text x={r.cx} y={r.l2?r.cy-5:r.cy} textAnchor="middle"
                        dominantBaseline="central"
                        style={{fontSize:fs,fill:"#374151",fontFamily:"Inter,sans-serif",fontWeight:600}}>{r.l1}</text>
                      {r.l2&&<text x={r.cx} y={r.cy+7} textAnchor="middle"
                        dominantBaseline="central"
                        style={{fontSize:fs,fill:"#374151",fontFamily:"Inter,sans-serif",fontWeight:600}}>{r.l2}</text>}
                    </g>
                  );
                })}

                {/* Customer Service — open area, 3 walls only (per corrected coords) */}
                <rect x={221.7} y={432.0} width={104.1} height={135.4} fill="#FFEDD5" stroke="none"/>
                <line x1={221.7} y1={432.0} x2={221.7} y2={483.1} stroke="#94A3B8" strokeWidth="1.5"/>
                <line x1={221.7} y1={432.0} x2={325.8} y2={432.0} stroke="#94A3B8" strokeWidth="1.5"/>
                <line x1={325.8} y1={432.0} x2={325.8} y2={567.4} stroke="#94A3B8" strokeWidth="1.5"/>
                <text x={273.8} y={494.0} textAnchor="middle" dominantBaseline="central"
                  style={{fontSize:8,fill:"#374151",fontFamily:"Inter,sans-serif",fontWeight:600}}>Customer</text>
                <text x={273.8} y={504.0} textAnchor="middle" dominantBaseline="central"
                  style={{fontSize:8,fill:"#374151",fontFamily:"Inter,sans-serif",fontWeight:600}}>Service</text>

                {/* ── Corridor backbone — dashed lines ── */}
                {CORRIDOR_EDGES.map(([a,b],i)=>{
                  const pa=JUNCTIONS[a]||EXIT_POS[a]||{x:0,y:0};
                  const pb=JUNCTIONS[b]||EXIT_POS[b]||{x:0,y:0};
                  const aNode=nodes.find(x=>x.id===a);
                  const bNode=nodes.find(x=>x.id===b);
                  const hazard=(aNode?.status==="alert"||bNode?.status==="alert"||
                    aNode?.status==="quarantine"||bNode?.status==="quarantine");
                  return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                    stroke={hazard?"#EF4444":"#94A3B8"}
                    strokeWidth={hazard?2:1.5} strokeDasharray={hazard?"none":"6 4"}
                    opacity={hazard?0.8:0.5}/>;
                })}

                {/* ── Active route — animated green dashes through junctions ── */}
                {activeRoute.length>=2&&(()=>{
                  const pts=getRoutePoints(activeRoute);
                  if(!pts) return null;
                  return(<g>
                    <polyline points={pts} fill="none" stroke={palette.success}
                      strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
                      strokeDasharray="12 6" opacity="0.95"
                      style={{animation:"dash 1.2s linear infinite"}}/>
                    <polyline points={pts} fill="none" stroke={palette.success}
                      strokeWidth="14" opacity="0.08" strokeLinecap="round" strokeLinejoin="round"/>
                  </g>);
                })()}

                {/* ── Exit badges — outside walls ── */}
                {Object.entries(EXIT_POS).map(([id,pos])=>{
                  const isOnRoute=activeRoute.includes(id);
                  const bw=36, bh=14;
                  const bx=id==="EXIT-1"?pos.x-bw-6:id==="EXIT-4"?pos.x+10:pos.x-bw/2;
                  const by=id==="EXIT-2"||id==="EXIT-3"?pos.y-bh-8:id==="EXIT-5"?pos.y+10:pos.y-bh/2;
                  return(<g key={id}>
                    <circle cx={pos.x} cy={pos.y} r={isOnRoute?9:6}
                      fill={isOnRoute?"rgba(16,185,129,0.9)":"rgba(59,130,246,0.85)"}
                      stroke="#fff" strokeWidth={isOnRoute?2.5:1.5}/>
                    {isOnRoute&&<circle cx={pos.x} cy={pos.y} r={14}
                      fill="none" stroke={palette.success} strokeWidth="1.5" opacity="0.5"
                      style={{animation:"pulse 1.2s infinite"}}/>}
                    <rect x={bx} y={by} width={bw} height={bh} rx="3"
                      fill={isOnRoute?palette.success:"#2563EB"} opacity="0.92"/>
                    <text x={bx+bw/2} y={by+bh/2} textAnchor="middle" dominantBaseline="central"
                      style={{fontSize:7.5,fontWeight:800,fill:"white",fontFamily:"Inter,sans-serif"}}>{pos.label}</text>
                  </g>);
                })}

                {/* ── Store door dots + door→junction connector when on active route ── */}
                {Object.entries(DOOR_POS).map(([bid,d])=>{
                  const isStart = activeRoute[0]===bid;
                  const jid = DOOR_TO_J[bid];
                  const jpos = jid ? JUNCTIONS[jid] : null;
                  const storeDot = STORE_DOTS.find(s=>s.label===d.label);
                  const zoneColor = storeDot ? ZONE_COLORS[storeDot.zone] : "#94A3B8";
                  return(
                    <g key={bid}>
                      {/* Door→junction line (only shown when this store is route start) */}
                      {isStart && jpos && (
                        <line x1={d.x} y1={d.y} x2={jpos.x} y2={jpos.y}
                          stroke={palette.success} strokeWidth="2.5"
                          strokeDasharray="5 3" opacity="0.7"/>
                      )}
                      <circle cx={d.x} cy={d.y} r={isStart?6:3.5}
                        fill={isStart?palette.success:zoneColor}
                        stroke={isStart?"#fff":"#94A3B8"}
                        strokeWidth={isStart?2:0.8} opacity="0.9"/>
                      {isStart&&<text x={d.x} y={d.y-10} textAnchor="middle"
                        style={{fontSize:7.5,fontWeight:700,fill:palette.success,
                          fontFamily:"Inter,sans-serif"}}>{d.label}</text>}
                    </g>
                  );
                })}

                {/* ── Junction nodes — routing decision points ── */}
                {Object.entries(JUNCTIONS).map(([id,pos])=>{
                  const n=nodes.find(x=>x.id===id);
                  const isOnRoute=activeRoute.includes(id);
                  const isPending=manualBlockedNode===id+"_PENDING";
                  const isBlocked=id===manualBlockedNode||isPending;
                  const isAlert=n?.status==="alert";
                  const isTier2=n?.status==="quarantine"||n?.status==="warning";
                  const nodeColor=LUMINA_NODE_DEFS[J_TO_NODE[id]]?.color||"#94A3B8";
                  const dotColor=isPending?"#94A3B8":isBlocked?palette.purple:
                    isAlert?palette.danger:
                    isTier2?palette.warning:
                    isOnRoute?palette.success:nodeColor;
                  const r=isOnRoute||isAlert?7:4;
                  return(
                    <g key={id} style={{cursor:"pointer"}} onClick={()=>setSelectedNode(n??null)}>
                      {isAlert&&<circle cx={pos.x} cy={pos.y} r={r+5}
                        fill={palette.danger} opacity="0.18"
                        style={{animation:"pulse 1.2s infinite"}}/>}
                      <circle cx={pos.x} cy={pos.y} r={r}
                        fill={dotColor} stroke="#fff" strokeWidth="1.5" opacity="0.9"/>
                      {/* Show ID only on route or alert */}
                      {(isOnRoute||isAlert||isBlocked)&&(
                        <text x={pos.x} y={pos.y-r-3} textAnchor="middle"
                          style={{fontSize:7,fontWeight:700,fill:dotColor,fontFamily:"Inter,sans-serif"}}>{id}</text>
                      )}
                      {/* Hazard emoji */}
                      {isHazard&&isAlert&&(()=>{
                        const icon=n?.hazard==="thermal"?"🔥":n?.hazard==="fall"?"🚨":"⚠";
                        return<text x={pos.x} y={pos.y-r-12} textAnchor="middle"
                          style={{fontSize:12,animation:"hazardBlink 1.4s ease-in-out infinite"}}>{icon}</text>;
                      })()}
                      {/* Route sequence badge */}
                      {isOnRoute&&!isBlocked&&(()=>{
                        const rv=activeRoute.filter(x=>x!==manualBlockedNode);
                        const vi=rv.indexOf(id)+1;
                        if(vi<=0) return null;
                        const isL=vi===rv.length;
                        return(<g>
                          <circle cx={pos.x+r+6} cy={pos.y-r-2} r={6}
                            fill={isL?palette.success:palette.info} stroke="#fff" strokeWidth="1.5"/>
                          <text x={pos.x+r+6} y={pos.y-r-2} textAnchor="middle" dominantBaseline="central"
                            style={{fontSize:6,fontWeight:800,fill:"#fff",fontFamily:"Inter,sans-serif"}}>{vi}</text>
                        </g>);
                      })()}
                      {/* Crowd count */}
                      {(n?.crowd??0)>0&&(
                        <text x={pos.x} y={pos.y+r+8} textAnchor="middle"
                          style={{fontSize:6.5,fill:n.crowd>85?palette.danger:n.crowd>50?palette.warning:"#94A3B8",
                            fontFamily:"Inter,sans-serif",fontWeight:600}}>{n.crowd}p</text>
                      )}
                    </g>
                  );
                })}

                {activeRoute.length<=1&&(
                  <text x="383" y="340" textAnchor="middle" dominantBaseline="central"
                    style={{fontSize:12,fontWeight:700,fill:palette.danger,fontFamily:"Inter,sans-serif"}}>
                    ALL PATHS BLOCKED — MANUAL OVERRIDE REQUIRED
                  </text>
                )}
              </svg>
              <div style={{borderLeft:`1px solid ${palette.border}`,display:"flex",
                flexDirection:"column",overflowY:"auto",overflowX:"hidden",minWidth:255,maxWidth:280}}>
                <div style={{padding:"8px 12px",borderBottom:`1px solid ${palette.border}`,flexShrink:0}}>
                  <div style={{fontSize:9,fontWeight:600,color:palette.textMuted,marginBottom:6}}>ACTIVE ROUTE</div>
                  <div style={{display:"flex",flexDirection:"column",gap:3}}>
                    {activeRoute.map((id,i)=>{
                      const n=nodes.find(x=>x.id===id);
                      const sc=statusColor(n?.status??"normal");
                      const isDoor=!!DOOR_POS[id];
                      const isExit=!!EXIT_POS[id];
                      const isFirst=i===0;
                      const isLast=i===activeRoute.length-1;
                      return(
                        <div key={id} style={{display:"flex",alignItems:"center",gap:5}}>
                          <div style={{width:14,height:14,borderRadius:"50%",flexShrink:0,
                            background:isFirst?palette.warningLight:isLast?palette.successLight:palette.infoLight,
                            border:`1px solid ${isFirst?palette.warning:isLast?palette.success:palette.info}`,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            fontSize:7,fontWeight:700,
                            color:isFirst?palette.warning:isLast?palette.success:palette.info,
                          }}>{i+1}</div>
                          <span style={{fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:4,
                            background:statusBg(n?.status??"normal"),color:sc,
                            border:`1px solid ${sc}33`}}>
                            {DOOR_POS[id]?.label||EXIT_POS[id]?.label||id}
                            {isFirst&&isDoor&&<span style={{fontSize:7,marginLeft:3,color:palette.danger}}>🔥</span>}
                          </span>
                          <span style={{fontSize:9,color:palette.textMuted,flex:1,
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {isDoor?`Door → ${DOOR_TO_J[id]||"corridor"}`:
                             isExit?"Exit point":
                             n?.zone??"Corridor junction"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{marginTop:5,fontSize:9,padding:"3px 6px",borderRadius:4,
                    background:rsetSafe?palette.successLight:palette.dangerLight}}>
                    RSET <b style={{color:rsetSafe?palette.success:palette.danger}}>{rsetTotal}s</b>
                    {" / "}ASET <b style={{color:palette.info}}>{rset.ASET_s??600}s</b>
                  </div>
                </div>
                <div style={{padding:"8px 12px",borderBottom:`1px solid ${palette.border}`,flexShrink:0}}>
                  <div style={{fontSize:9,fontWeight:600,color:palette.textMuted,marginBottom:5}}>
                    <span style={{color:palette.info}}>① </span>SELECT NODE TO BLOCK
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:5,
                    maxHeight:72,overflowY:"auto",paddingRight:2}}>
                    {nodes.map(n=>{
                      const isSel   = selectedNode?.id===n.id;
                      const isBomba = n.id===manualBlockedNode;
                      return(
                        <button key={n.id}
                          onClick={()=>!isBomba&&setSelectedNode(p=>p?.id===n.id?null:n)}
                          style={{
                            background:isBomba?palette.purpleLight:isSel?palette.warningLight:"transparent",
                            border:`1px solid ${isBomba?palette.purple:isSel?palette.warning:palette.border}`,
                            borderRadius:4,padding:"2px 7px",fontSize:9,fontWeight:600,
                            color:isBomba?palette.purple:isSel?palette.warningDark:palette.textMuted,
                            cursor:isBomba?"not-allowed":"pointer",
                            opacity:isBomba?0.6:1,
                          }}>{(DOOR_POS[n.id]?.label||EXIT_POS[n.id]?.label||n.id)}{isBomba?" ✕":""}</button>
                      );
                    })}
                  </div>
                  <button onClick={overridePath} style={{width:"100%",
                    background:isHazard&&selectedNode&&selectedNode.id!==manualBlockedNode?palette.warningLight:"transparent",
                    border:`1px solid ${isHazard&&selectedNode&&selectedNode.id!==manualBlockedNode?palette.warning:palette.border}`,
                    borderRadius:5,padding:"5px",fontSize:10,fontWeight:700,
                    color:isHazard&&selectedNode&&selectedNode.id!==manualBlockedNode?palette.warningDark:palette.textMuted,
                    cursor:isHazard&&selectedNode&&selectedNode.id!==manualBlockedNode?"pointer":"not-allowed"}}>
                    {selectedNode&&isHazard&&selectedNode.id!==manualBlockedNode
                      ?`② REROUTE AROUND ${selectedNode.id}`
                      :"② BLOCK + REROUTE"}
                  </button>
                </div>
                <div style={{padding:"8px 12px",borderBottom:`1px solid ${palette.border}`,flexShrink:0}}>
                  <div style={{fontSize:9,fontWeight:600,color:palette.purple,marginBottom:5}}>
                    BOMBA — QUICK REROUTE
                  </div>
                  <div style={{maxHeight:130,overflowY:"auto",paddingRight:2}}>
                  {(quickExitRoutes.length ? quickExitRoutes : [
                    {exit:"EXIT-1",safe:true},{exit:"EXIT-2",safe:true},
                    {exit:"EXIT-3",safe:true},{exit:"EXIT-4",safe:true},{exit:"EXIT-5",safe:true},
                  ]).map((rt,rank)=>{
                    const exitId    = rt.exit;
                    const exitLabel = EXIT_POS[exitId]?.label || exitId;
                    const isActive  = activeRoute[activeRoute.length-1] === exitId;
                    const exitNode  = nodes.find(n=>n.id===exitId);
                    const blocked   = exitNode?.status==="quarantine"||exitNode?.status==="alert" || !rt.safe;
                    const rankLabel = rank===0?"BEST":rank===1?"2nd":rank===2?"3rd":`${rank+1}th`;
                    return(
                      <button key={exitId} onClick={()=>{
                        const origin = activeRoute[0] || "J16";
                        fetch(apiUrl("/api/force_exit"),{
                          method:"POST",
                          headers:{"Content-Type":"application/json"},
                          body:JSON.stringify({start:origin, exit_id:exitId})
                        }).then(r=>r.json()).then(d=>{
                          if(d.route?.length) {
                            setActiveRoute(d.route);
                            setManualOverride(true);
                            setManualBlockedNode(null);
                          }
                        });
                      }} disabled={blocked} style={{width:"100%",marginBottom:3,
                        background:isActive?palette.purpleLight:blocked?"#FEE2E2":palette.successLight,
                        border:`1px solid ${isActive?palette.purple:blocked?palette.danger:palette.success}`,
                        borderRadius:5,padding:"3px 8px",cursor:blocked?"not-allowed":"pointer",
                        opacity:blocked?0.5:1,
                        display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <span style={{display:"flex",alignItems:"center",gap:5}}>
                          <span style={{fontSize:7,fontWeight:800,padding:"1px 4px",borderRadius:3,
                            background:rank===0?palette.success:"#E2E8F0",
                            color:rank===0?"#fff":palette.textMuted}}>{rankLabel}</span>
                          <span style={{fontSize:9,fontWeight:700,
                            color:isActive?palette.purple:blocked?palette.danger:palette.successDark}}>
                            → {exitLabel} {isActive?"(ACTIVE)":""}
                          </span>
                        </span>
                        {blocked
                          ?<span style={{fontSize:7,color:palette.danger,fontWeight:600}}>BLOCKED</span>
                          :rt.cost!==undefined&&<span style={{fontSize:7,color:palette.textMuted}}>{rt.cost}m</span>}
                      </button>
                    );
                  })}
                  </div>
                </div>
                <div style={{padding:"8px 12px",flexShrink:0}}>
                  <div style={{fontSize:9,fontWeight:600,color:palette.textMuted,marginBottom:2}}>FACP PAS</div>
                  <div style={{fontSize:18,fontWeight:700,cursor:"help",lineHeight:1,
                    color:isHazard?(pasCountdown<60?palette.danger:palette.warning):palette.textMuted}}
                    title="FACP Positive Alarm Sequence — 60-180s human verification window (NFPA 72). Default: 178s.">
                    {isHazard?`${pasCountdown}s`:"STANDBY"}
                  </div>
                  <div style={{fontSize:9,color:palette.textMuted,marginTop:2}}>
                    {fftConfirmed?"FFT CONFIRMED":"Awaiting acoustic confirmation"}
                  </div>
                  <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:4}}>
                    <button onClick={triggerFire} disabled={isHazard} style={{width:"100%",
                      background:!isHazard?palette.dangerLight:"transparent",
                      border:`1px solid ${!isHazard?palette.danger:palette.border}`,
                      borderRadius:5,padding:"5px",fontSize:9,fontWeight:600,
                      color:!isHazard?palette.danger:palette.textMuted,
                      cursor:!isHazard?"pointer":"not-allowed",opacity:!isHazard?1:0.4}}
                      title="No physical thermal sensor in this prototype — triggers fire simulation for demo">
                      🔥 SIMULATE FIRE (DEMO)
                    </button>
                    <button onClick={resetSystem} disabled={!isHazard} style={{width:"100%",
                      background:isHazard?palette.grayLight:"transparent",
                      border:`1px solid ${isHazard?palette.gray:palette.border}`,
                      borderRadius:5,padding:"5px",fontSize:9,fontWeight:600,
                      color:isHazard?palette.text:palette.textMuted,
                      cursor:isHazard?"pointer":"not-allowed",opacity:isHazard?1:0.4}}>RESET</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {FLASK_IP==="127.0.0.1"&&(
        <div style={{background:"#FEF3C7",borderBottom:"1px solid #FCD34D",padding:"4px 16px",
          fontSize:11,fontWeight:600,color:"#92400E",textAlign:"center"}}>
          DEV MODE — FLASK_IP is 127.0.0.1 — Change to Wi-Fi IP before iPad demo
        </div>
      )}

      {/* ── HEADER ── */}
      <div style={{background:palette.bgCard,borderBottom:hazardBorder,padding:"6px 16px",
        display:"flex",alignItems:"center",justifyContent:"space-between",
        flexShrink:0,gap:8,minWidth:0,overflow:"hidden",
        boxShadow:isHazard?"0 2px 12px rgba(220,38,38,0.15)":"0 1px 3px rgba(0,0,0,0.06)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,
            background:isHazard?palette.danger:palette.success,
            animation:isHazard?"pulse 1s infinite":"none"}}/>
          <span style={{fontWeight:700,fontSize:14,letterSpacing:"0.03em",color:palette.text}}>LUMINA</span>
          <span style={{fontSize:10,fontWeight:600,padding:"2px 7px",borderRadius:20,flexShrink:0,
            background:isHazard?palette.danger:palette.successLight,
            color:isHazard?"#fff":palette.successDark,
            maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {isHazard?`CRITICAL — ${hazardType}`:"NORMAL"}
          </span>
          <span style={{fontSize:9,fontWeight:600,flexShrink:0,
            color:backendOnline?palette.success:palette.danger}}>
            {backendOnline?"● LIVE":"○ OFFLINE"}
          </span>
        </div>
        <div style={{display:"flex",gap:14,alignItems:"center",flexShrink:1,minWidth:0,overflow:"hidden"}}>
          {manualOverride&&(
            <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0,
              background:`${palette.warning}18`,border:`1px solid ${palette.warning}`,
              borderRadius:5,padding:"2px 7px"}}>
              <div style={{width:5,height:5,borderRadius:"50%",background:palette.warning,
                animation:"pulse 1s infinite",flexShrink:0}}/>
              <span style={{fontSize:9,fontWeight:700,color:palette.warningDark,whiteSpace:"nowrap"}}>MANUAL</span>
            </div>
          )}
          {[
            {label:"FACP",   value:isHazard?`${pasCountdown}s`:"—",
              color:isHazard?(pasCountdown<60?palette.danger:palette.warning):palette.gray,
              title:"FACP Positive Alarm Sequence — 60-180s human verification window (NFPA 72). Default: 178s."},
            {label:"THERMAL",value:thermalState,
              color:thermalState==="ALERT"?palette.danger:thermalState==="WARNING"?palette.warning:palette.success},
            {label:"FFT",    value:fftState,
              color:fftState==="CONFIRMED"?palette.danger:fftState==="DETECTING"?palette.warning:palette.success},
            {label:"PERSONS",value:`${totalFootfall}`,color:palette.info},
            {label:"NODES",  value:`${health.nodes_online}/${health.nodes_total}`,color:palette.text},
            {label:"MQTT",   value:`${mqttStatus} ×${mqttMsgCount}`,
              color:mqttStatus==="LIVE"?palette.success:palette.danger},
          ].map(({label,value,color,title})=>(
            <div key={label} style={{textAlign:"center",flexShrink:0}} title={title??""}>
              <div style={{fontSize:8,color:palette.textMuted,fontWeight:500,marginBottom:1}}>{label}</div>
              <div style={{fontSize:10,fontWeight:700,color,cursor:title?"help":"default"}}>{value}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
          <button onClick={toggleAiMode} style={{
            background:aiMode==="DIORAMA"?palette.infoLight:palette.purpleLight,
            border:`1px solid ${aiMode==="DIORAMA"?palette.info:palette.purple}`,
            color:aiMode==="DIORAMA"?palette.infoDark??palette.info:palette.purple,
            borderRadius:6,padding:"4px 10px",fontSize:10,fontWeight:600,cursor:"pointer"}}>
            {aiMode==="DIORAMA"?"TOY AI":"REAL AI"}
          </button>
          <button onClick={resetSystem} disabled={!isHazard} style={{
            background:isHazard?palette.grayLight:"transparent",
            border:`1px solid ${isHazard?palette.gray:palette.border}`,
            color:isHazard?palette.text:palette.textMuted,
            borderRadius:6,padding:"4px 10px",fontSize:10,fontWeight:600,
            cursor:isHazard?"pointer":"not-allowed",opacity:isHazard?1:0.4}}>RESET</button>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{background:palette.bgCard,borderBottom:`1px solid ${palette.border}`,
        padding:"0 20px",display:"flex",gap:4,flexShrink:0}}>
        {[["command","Live Command"],["health","System Health"],["analytics","Analytics"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{background:"transparent",border:"none",
            borderBottom:`2px solid ${tab===id?palette.info:"transparent"}`,
            padding:"8px 14px",fontSize:12,fontWeight:tab===id?600:400,
            color:tab===id?palette.info:palette.textMuted,cursor:"pointer",transition:"all 0.15s"}}>
            {label}
          </button>
        ))}
      </div>

      <div style={{flex:1,overflow:"hidden",padding:"12px 16px",display:"flex",flexDirection:"column",gap:10}}>

        {/* ══ TAB 1 — LIVE COMMAND ══ */}
        {tab==="command"&&(
          <div style={{flex:1,display:"grid",gridTemplateRows:"1fr auto",gap:10,minHeight:0}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1.5fr",gap:10,minHeight:0}}>

              {/* Camera panel — VMS layout: hero live feed + standby strip */}
              <div style={{...card(),display:"flex",flexDirection:"column",overflow:"hidden",
                border:isHazard?`2px solid ${palette.danger}`:card().border}}>
                <div style={{padding:"7px 12px",borderBottom:`1px solid ${palette.border}`,
                  display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
                  <span style={{fontSize:11,fontWeight:600,color:palette.textMuted}}>CAMERAS — {aiMode}</span>
                  <span style={{fontSize:10,fontWeight:600,color:backendOnline?palette.success:palette.danger}}>
                    {backendOnline?`${personCount} tracked`:"OFFLINE"}
                  </span>
                </div>

                {/* CAM-01 hero — large live feed */}
                <div style={{flex:1,position:"relative",background:"#000",overflow:"hidden",
                  cursor:"pointer",borderBottom:"2px solid #1E293B",minHeight:0}}
                  onClick={()=>setCamExpanded({id:"CAM-01",label:"Center Corridor — C-004",sublabel:"Center Area",live:true,node:"R-custsvc"})}>
                  <img src={apiUrl("/video_feed")} alt="CAM-01"
                    style={{width:"100%",height:"100%",objectFit:"contain",display:"block",
                      filter:isHazard?"sepia(40%) hue-rotate(320deg) saturate(180%)":"none"}}
                    onError={e=>{e.target.style.display="none";}}/>
                  <div style={{position:"absolute",top:6,left:6,background:"rgba(0,0,0,0.65)",
                    borderRadius:4,padding:"3px 8px",display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:9,color:"#10B981",fontWeight:700}}>● LIVE</span>
                    <span style={{fontSize:9,color:"#CBD5E1",fontWeight:600}}>CAM-01</span>
                    <span style={{fontSize:8,color:"#94A3B8"}}>Center Corridor · C-004</span>
                  </div>
                  <div style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,0.55)",
                    borderRadius:4,padding:"2px 7px",fontSize:8,color:"#94A3B8"}}>click to expand</div>
                  {isHazard&&(
                    <div style={{position:"absolute",bottom:6,left:6,background:"#DC2626",
                      borderRadius:4,padding:"2px 8px",fontSize:9,color:"#fff",fontWeight:700,
                      animation:"pulse 1s infinite"}}>HAZARD ACTIVE</div>
                  )}
                </div>

                {/* Standby strip — fixed height so it always shows */}
                <div style={{flexShrink:0,height:72,display:"grid",gridTemplateColumns:"repeat(5,1fr)",
                  gap:2,background:"#0F172A",padding:2}}>
                  {[
                    {id:"CAM-02",sublabel:"Thai Relax",      node:"R-thairelax"},
                    {id:"CAM-03",sublabel:"Public Recipe",   node:"R-publicrec"},
                    {id:"CAM-04",sublabel:"Siew Later",      node:"R-siewlater"},
                    {id:"CAM-05",sublabel:"Baskin Batman",   node:"R-baskin"},
                    {id:"CAM-06",sublabel:"Exit 4",          node:"EXIT-4"},
                  ].map(cam=>{
                    const n=nodes.find(x=>x.id===cam.node);
                    const sc=statusColor(n?.status??"normal");
                    const isAlert=n?.status==="alert";
                    return(
                      <div key={cam.id}
                        onClick={()=>setCamExpanded({...cam,label:`${cam.sublabel} — ${cam.node}`,live:false})}
                        style={{position:"relative",background:"#0A1120",cursor:"pointer",
                          border:`1px solid ${isAlert?"#DC2626":"#1E293B"}`,
                          overflow:"hidden",borderRadius:3,transition:"border-color 0.15s",
                          display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3}}
                        onMouseEnter={e=>e.currentTarget.style.borderColor="#3B82F6"}
                        onMouseLeave={e=>e.currentTarget.style.borderColor=isAlert?"#DC2626":"#1E293B"}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:sc,opacity:0.75}}/>
                        <div style={{textAlign:"center",lineHeight:1.3}}>
                          <div style={{fontSize:7,color:"#94A3B8",fontWeight:600}}>{cam.id}</div>
                          <div style={{fontSize:6,color:"#64748B"}}>{cam.sublabel}</div>
                        </div>
                        {n&&n.crowd>0&&(
                          <div style={{fontSize:7,color:sc,fontWeight:600}}>{n.crowd}p</div>
                        )}
                        {isAlert&&(
                          <div style={{position:"absolute",top:2,right:2,background:"#DC2626",
                            borderRadius:2,padding:"1px 4px",fontSize:6,color:"#fff",fontWeight:700}}>!</div>
                        )}
                      </div>
                    );
                  })}
                </div>

              </div>

              {/* Digital Twin */}
              <div style={{...card(),display:"flex",flexDirection:"column",overflow:"hidden"}}>
                <div style={{padding:"8px 12px",borderBottom:`1px solid ${palette.border}`,
                  display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
                  <span style={{fontSize:11,fontWeight:600,color:palette.textMuted}}>DYN-A* DIGITAL TWIN</span>
                  <div style={{display:"flex",gap:10,fontSize:9,color:palette.textMuted}}>
                    {[["ALERT",palette.danger],["WARNING",palette.warning],["NORMAL",palette.success]].map(([l,c])=>(
                      <span key={l} style={{display:"flex",alignItems:"center",gap:3}}>
                        <span style={{width:6,height:6,borderRadius:1,background:c,display:"inline-block"}}/>{l}
                      </span>
                    ))}
                    {manualOverride&&<span style={{color:palette.purple,fontWeight:600}}>● MANUAL LOCK</span>}
                  </div>
                </div>
                <svg viewBox="-30 -30 820 760" onClick={()=>setTwinExpanded(true)}
                  style={{flex:1,width:"100%",background:"#F8FAFC",cursor:"pointer"}}
                  title="Click to expand full command view">
                {/* ── Outer wall ── */}
                <polygon points="15.4,12.3 751.7,12.3 751.7,675.8 15.4,675.8"
                  fill="#EEF2F7" stroke="#334155" strokeWidth="2.5"/>

                {/* ── Room polygons with zone colors ── */}
                {ROOM_POLYGONS.map((r,i)=>{
                  const n = r.rid ? nodes.find(x=>x.id===r.rid) : null;
                  const hazardFill = n?.status==="alert"?"#FEE2E2":
                                     n?.id===manualBlockedNode?"#E9D5FF":
                                     n?.status==="quarantine"?"#FEF3C7":null;
                  const fillColor = hazardFill || r.fill || "white";
                  const fs = 8;
                  return(
                    <g key={i}>
                      {r.lines
                        ? <g>
                            <rect x={221.8} y={432.1} width={104.1} height={135.5}
                              fill={fillColor} stroke="none"/>
                            {r.lines.map((l,li)=><line key={li}
                              x1={parseFloat(l.split(" ")[0].split(",")[0])}
                              y1={parseFloat(l.split(" ")[0].split(",")[1])}
                              x2={parseFloat(l.split(" ")[1].split(",")[0])}
                              y2={parseFloat(l.split(" ")[1].split(",")[1])}
                              stroke="#94A3B8" strokeWidth="1.5"/>)}
                          </g>
                        : <polygon points={r.pts} fill={fillColor}
                            stroke="#94A3B8" strokeWidth="1.5"/>
                      }
                      <text x={r.cx} y={r.l2?r.cy-5:r.cy} textAnchor="middle"
                        dominantBaseline="central"
                        style={{fontSize:fs,fill:"#374151",fontFamily:"Inter,sans-serif",fontWeight:600}}>{r.l1}</text>
                      {r.l2&&<text x={r.cx} y={r.cy+7} textAnchor="middle"
                        dominantBaseline="central"
                        style={{fontSize:fs,fill:"#374151",fontFamily:"Inter,sans-serif",fontWeight:600}}>{r.l2}</text>}
                    </g>
                  );
                })}

                {/* Customer Service — open area, 3 walls only (per corrected coords) */}
                <rect x={221.7} y={432.0} width={104.1} height={135.4} fill="#FFEDD5" stroke="none"/>
                <line x1={221.7} y1={432.0} x2={221.7} y2={483.1} stroke="#94A3B8" strokeWidth="1.5"/>
                <line x1={221.7} y1={432.0} x2={325.8} y2={432.0} stroke="#94A3B8" strokeWidth="1.5"/>
                <line x1={325.8} y1={432.0} x2={325.8} y2={567.4} stroke="#94A3B8" strokeWidth="1.5"/>
                <text x={273.8} y={494.0} textAnchor="middle" dominantBaseline="central"
                  style={{fontSize:8,fill:"#374151",fontFamily:"Inter,sans-serif",fontWeight:600}}>Customer</text>
                <text x={273.8} y={504.0} textAnchor="middle" dominantBaseline="central"
                  style={{fontSize:8,fill:"#374151",fontFamily:"Inter,sans-serif",fontWeight:600}}>Service</text>

                {/* ── Corridor backbone — dashed lines ── */}
                {CORRIDOR_EDGES.map(([a,b],i)=>{
                  const pa=JUNCTIONS[a]||EXIT_POS[a]||{x:0,y:0};
                  const pb=JUNCTIONS[b]||EXIT_POS[b]||{x:0,y:0};
                  const aNode=nodes.find(x=>x.id===a);
                  const bNode=nodes.find(x=>x.id===b);
                  const hazard=(aNode?.status==="alert"||bNode?.status==="alert"||
                    aNode?.status==="quarantine"||bNode?.status==="quarantine");
                  return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                    stroke={hazard?"#EF4444":"#94A3B8"}
                    strokeWidth={hazard?2:1.5} strokeDasharray={hazard?"none":"6 4"}
                    opacity={hazard?0.8:0.5}/>;
                })}

                {/* ── Active route — animated green dashes through junctions ── */}
                {activeRoute.length>=2&&(()=>{
                  const pts=getRoutePoints(activeRoute);
                  if(!pts) return null;
                  return(<g>
                    <polyline points={pts} fill="none" stroke={palette.success}
                      strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
                      strokeDasharray="12 6" opacity="0.95"
                      style={{animation:"dash 1.2s linear infinite"}}/>
                    <polyline points={pts} fill="none" stroke={palette.success}
                      strokeWidth="14" opacity="0.08" strokeLinecap="round" strokeLinejoin="round"/>
                  </g>);
                })()}

                {/* ── Exit badges — outside walls ── */}
                {Object.entries(EXIT_POS).map(([id,pos])=>{
                  const isOnRoute=activeRoute.includes(id);
                  const bw=36, bh=14;
                  const bx=id==="EXIT-1"?pos.x-bw-6:id==="EXIT-4"?pos.x+10:pos.x-bw/2;
                  const by=id==="EXIT-2"||id==="EXIT-3"?pos.y-bh-8:id==="EXIT-5"?pos.y+10:pos.y-bh/2;
                  return(<g key={id}>
                    <circle cx={pos.x} cy={pos.y} r={isOnRoute?9:6}
                      fill={isOnRoute?"rgba(16,185,129,0.9)":"rgba(59,130,246,0.85)"}
                      stroke="#fff" strokeWidth={isOnRoute?2.5:1.5}/>
                    {isOnRoute&&<circle cx={pos.x} cy={pos.y} r={14}
                      fill="none" stroke={palette.success} strokeWidth="1.5" opacity="0.5"
                      style={{animation:"pulse 1.2s infinite"}}/>}
                    <rect x={bx} y={by} width={bw} height={bh} rx="3"
                      fill={isOnRoute?palette.success:"#2563EB"} opacity="0.92"/>
                    <text x={bx+bw/2} y={by+bh/2} textAnchor="middle" dominantBaseline="central"
                      style={{fontSize:7.5,fontWeight:800,fill:"white",fontFamily:"Inter,sans-serif"}}>{pos.label}</text>
                  </g>);
                })}

                {/* ── Store door dots + door→junction connector when on active route ── */}
                {Object.entries(DOOR_POS).map(([bid,d])=>{
                  const isStart = activeRoute[0]===bid;
                  const jid = DOOR_TO_J[bid];
                  const jpos = jid ? JUNCTIONS[jid] : null;
                  const storeDot = STORE_DOTS.find(s=>s.label===d.label);
                  const zoneColor = storeDot ? ZONE_COLORS[storeDot.zone] : "#94A3B8";
                  return(
                    <g key={bid}>
                      {/* Door→junction line (only shown when this store is route start) */}
                      {isStart && jpos && (
                        <line x1={d.x} y1={d.y} x2={jpos.x} y2={jpos.y}
                          stroke={palette.success} strokeWidth="2.5"
                          strokeDasharray="5 3" opacity="0.7"/>
                      )}
                      <circle cx={d.x} cy={d.y} r={isStart?6:3.5}
                        fill={isStart?palette.success:zoneColor}
                        stroke={isStart?"#fff":"#94A3B8"}
                        strokeWidth={isStart?2:0.8} opacity="0.9"/>
                      {isStart&&<text x={d.x} y={d.y-10} textAnchor="middle"
                        style={{fontSize:7.5,fontWeight:700,fill:palette.success,
                          fontFamily:"Inter,sans-serif"}}>{d.label}</text>}
                    </g>
                  );
                })}

                {/* ── Junction nodes — routing decision points ── */}
                {Object.entries(JUNCTIONS).map(([id,pos])=>{
                  const n=nodes.find(x=>x.id===id);
                  const isOnRoute=activeRoute.includes(id);
                  const isPending=manualBlockedNode===id+"_PENDING";
                  const isBlocked=id===manualBlockedNode||isPending;
                  const isAlert=n?.status==="alert";
                  const isTier2=n?.status==="quarantine"||n?.status==="warning";
                  const nodeColor=LUMINA_NODE_DEFS[J_TO_NODE[id]]?.color||"#94A3B8";
                  const dotColor=isPending?"#94A3B8":isBlocked?palette.purple:
                    isAlert?palette.danger:
                    isTier2?palette.warning:
                    isOnRoute?palette.success:nodeColor;
                  const r=isOnRoute||isAlert?7:4;
                  return(
                    <g key={id} style={{cursor:"pointer"}} onClick={()=>setSelectedNode(n??null)}>
                      {isAlert&&<circle cx={pos.x} cy={pos.y} r={r+5}
                        fill={palette.danger} opacity="0.18"
                        style={{animation:"pulse 1.2s infinite"}}/>}
                      <circle cx={pos.x} cy={pos.y} r={r}
                        fill={dotColor} stroke="#fff" strokeWidth="1.5" opacity="0.9"/>
                      {/* Show ID only on route or alert */}
                      {(isOnRoute||isAlert||isBlocked)&&(
                        <text x={pos.x} y={pos.y-r-3} textAnchor="middle"
                          style={{fontSize:7,fontWeight:700,fill:dotColor,fontFamily:"Inter,sans-serif"}}>{id}</text>
                      )}
                      {/* Hazard emoji */}
                      {isHazard&&isAlert&&(()=>{
                        const icon=n?.hazard==="thermal"?"🔥":n?.hazard==="fall"?"🚨":"⚠";
                        return<text x={pos.x} y={pos.y-r-12} textAnchor="middle"
                          style={{fontSize:12,animation:"hazardBlink 1.4s ease-in-out infinite"}}>{icon}</text>;
                      })()}
                      {/* Route sequence badge */}
                      {isOnRoute&&!isBlocked&&(()=>{
                        const rv=activeRoute.filter(x=>x!==manualBlockedNode);
                        const vi=rv.indexOf(id)+1;
                        if(vi<=0) return null;
                        const isL=vi===rv.length;
                        return(<g>
                          <circle cx={pos.x+r+6} cy={pos.y-r-2} r={6}
                            fill={isL?palette.success:palette.info} stroke="#fff" strokeWidth="1.5"/>
                          <text x={pos.x+r+6} y={pos.y-r-2} textAnchor="middle" dominantBaseline="central"
                            style={{fontSize:6,fontWeight:800,fill:"#fff",fontFamily:"Inter,sans-serif"}}>{vi}</text>
                        </g>);
                      })()}
                      {/* Crowd count */}
                      {(n?.crowd??0)>0&&(
                        <text x={pos.x} y={pos.y+r+8} textAnchor="middle"
                          style={{fontSize:6.5,fill:n.crowd>85?palette.danger:n.crowd>50?palette.warning:"#94A3B8",
                            fontFamily:"Inter,sans-serif",fontWeight:600}}>{n.crowd}p</text>
                      )}
                    </g>
                  );
                })}

                {activeRoute.length<=1&&(
                  <text x="383" y="340" textAnchor="middle" dominantBaseline="central"
                    style={{fontSize:12,fontWeight:700,fill:palette.danger,fontFamily:"Inter,sans-serif"}}>
                    ALL PATHS BLOCKED — MANUAL OVERRIDE REQUIRED
                  </text>
                )}
                </svg>
                {selectedNode&&(
                  <div style={{padding:"7px 12px",borderTop:`1px solid ${palette.border}`,flexShrink:0,
                    background:statusBg(selectedNode.status),display:"flex",gap:16,alignItems:"center"}}>
                    <span style={{fontWeight:700,color:statusColor(selectedNode.status),fontSize:12}}>{selectedNode.id}</span>
                    <span style={{color:palette.textMuted,fontSize:11}}>{selectedNode.zone}</span>
                    <span style={{fontSize:11}}>{selectedNode.crowd}p</span>
                    <span style={{fontSize:11,color:palette.textMuted}}>{selectedNode.temp}°C</span>
                    <span style={{fontSize:10,fontWeight:600,padding:"1px 7px",borderRadius:10,
                      background:statusBg(selectedNode.status),color:statusColor(selectedNode.status),
                      border:`1px solid ${statusColor(selectedNode.status)}44`}}>
                      {selectedNode.status.toUpperCase()}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom strip */}
            <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:10}}>
              <div style={{...card(),padding:"9px 12px",display:"flex",flexDirection:"column",gap:6}}>
                <div style={{fontSize:9,fontWeight:600,color:palette.textMuted}}>ACTIVE ROUTE</div>
                <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                  {activeRoute.map((id,i)=>{
                    const n=nodes.find(x=>x.id===id);
                    const blocked=n?.status==="quarantine"||n?.status==="alert";
                    return(
                      <span key={id} style={{display:"flex",alignItems:"center",gap:3}}>
                        <span style={{fontSize:10,fontWeight:600,padding:"1px 6px",borderRadius:4,
                          background:statusBg(n?.status??"normal"),
                          color:blocked?statusColor(n.status):statusColor(n?.status??"normal"),
                          border:`1px solid ${statusColor(n?.status??"normal")}33`,
                          opacity:blocked?0.7:1}}>
                          {blocked?`[${id}]`:id}
                        </span>
                        {i<activeRoute.length-1&&<span style={{color:palette.textMuted,fontSize:10}}>→</span>}
                      </span>
                    );
                  })}
                </div>
                <div>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:9,marginBottom:3}}>
                    <span style={{color:palette.textMuted}}>RSET</span>
                    <span><b style={{color:rsetSafe?palette.success:palette.danger}}>{rsetTotal}s</b>
                      <span style={{color:palette.textMuted}}> / ASET </span>
                      <b style={{color:palette.info}}>{rset.ASET_s??600}s</b>
                    </span>
                  </div>
                  <div style={{height:4,background:palette.grayLight,borderRadius:2}}>
                    <div style={{height:"100%",borderRadius:2,
                      width:`${Math.min(100,(rsetTotal/(rset.ASET_s??600))*100)}%`,
                      background:rsetSafe?palette.success:palette.danger,transition:"width 0.5s"}}/>
                  </div>
                </div>
                {(()=>{
                  // Pull Policy is now global (scans every node), so filtering
                  // is required — showing all ~40 nodes as GREEN badges is
                  // noise. Only surface nodes that need attention (AMBER/RED)
                  // or are on the active evacuation route.
                  const interesting = Object.entries(pullSignals).filter(([nid,info])=>
                    info.signal!=="GREEN" || activeRoute.includes(nid)
                  );
                  if (interesting.length===0) return null;
                  return(
                    <div style={{display:"flex",gap:4,flexWrap:"wrap",maxHeight:54,overflowY:"auto"}}>
                      {interesting.map(([nid,info])=>(
                        <span key={nid} style={{fontSize:8,fontWeight:700,padding:"1px 5px",borderRadius:3,
                          background:info.signal==="GREEN"?`${palette.success}18`:
                            info.signal==="AMBER"?`${palette.warning}18`:`${palette.danger}18`,
                          color:info.signal==="GREEN"?palette.success:
                            info.signal==="AMBER"?palette.warning:palette.danger}}>
                          {nid}: {info.signal}
                        </span>
                      ))}
                    </div>
                  );
                })()}
                <div style={{fontSize:9,color:palette.textMuted,display:"flex",gap:8,flexWrap:"wrap"}}>
                  <span>DYN-A* cost: <b style={{color:palette.info}}>{costScore}</b></span>
                  {isHazard&&<span style={{color:palette.danger,fontSize:8}}>
                    thermal penalty +5000 applied
                  </span>}
                </div>
              </div>
              <div style={{...card(),padding:"8px 16px",display:"flex",flexDirection:"column",
                alignItems:"center",justifyContent:"center",minWidth:130,
                background:isHazard?(pasCountdown<60?palette.dangerLight:palette.warningLight):palette.bgCard,
                border:isHazard?`1px solid ${pasCountdown<60?palette.danger:palette.warning}`:card().border}}>
                <div style={{fontSize:9,fontWeight:600,color:palette.textMuted,marginBottom:2}}>FACP PAS</div>
                <div style={{fontSize:18,fontWeight:700,lineHeight:1,cursor:"help",
                  color:isHazard?(pasCountdown<60?palette.danger:palette.warning):palette.textMuted}}
                  title="FACP Positive Alarm Sequence — 60-180s human verification window (NFPA 72). Default: 178s.">
                  {isHazard?`${pasCountdown}s`:"—"}
                </div>
                <div style={{fontSize:9,color:palette.textMuted,marginTop:2}}>
                  {fftConfirmed?"CONFIRMED":"STANDBY"}
                </div>
              </div>
              <div style={{...card(),display:"flex",flexDirection:"column",overflow:"hidden"}}>
                <div style={{padding:"6px 10px",borderBottom:`1px solid ${palette.border}`,
                  fontSize:9,fontWeight:600,color:palette.textMuted,flexShrink:0}}>EVENT LOG</div>
                <div style={{flex:1,overflowY:"auto",padding:"2px 0"}}>
                  {liveEvents.slice(0,5).map((e,i)=>(
                    <div key={i} style={{padding:"4px 10px",display:"grid",
                      gridTemplateColumns:"6px 58px 1fr",gap:6,alignItems:"start",
                      borderBottom:i<4?`1px solid ${palette.border}`:undefined}}>
                      <div style={{width:6,height:6,borderRadius:"50%",marginTop:3,
                        background:{danger:palette.danger,warning:palette.warning,
                          success:palette.success,info:palette.info}[e.level]??palette.gray}}/>
                      <span style={{fontSize:9,color:palette.textMuted,
                        fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap",paddingTop:1}}>{e.time}</span>
                      <span style={{fontSize:10,color:palette.text,lineHeight:1.4}}>
                        {e.tag&&(
                          <span style={{
                            fontSize:7,fontWeight:700,padding:"1px 4px",borderRadius:3,
                            marginRight:5,
                            background:e.tag==="PRE-EMPTIVE"?"#EFF6FF":"#FEF2F2",
                            color:e.tag==="PRE-EMPTIVE"?palette.info:palette.danger,
                            border:`1px solid ${e.tag==="PRE-EMPTIVE"?palette.info+"44":palette.danger+"44"}`,
                          }}>{e.tag}</span>
                        )}
                        {e.msg}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ══ TAB 2 — SYSTEM HEALTH ══ */}
        {tab==="health"&&(
          <div style={{flex:1,display:"grid",gridTemplateRows:"auto 1fr auto",gap:10,minHeight:0}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
              <MetricCard label="Nodes Online"    value={`${health.nodes_online}/${health.nodes_total}`} unit="" color={palette.success} icon="📡" sub="198 standby + 6 active"/>
              <MetricCard label="Uptime"          value={Math.floor((health.uptime_s??0)/60)} unit="min" color={palette.info} icon="⏱" sub="since last restart"/>
              <MetricCard label="Thermal Latency" value={health.thermal_latency_ms??0} unit="ms" color={(health.thermal_latency_ms??0)<500?palette.success:palette.danger} icon="🌡" sub="below 500ms target"/>
              <MetricCard label="FFT Latency"     value={health.fft_latency_ms??0} unit="ms" color={(health.fft_latency_ms??0)<500?palette.success:palette.danger} icon="🔊" sub="below 500ms target"/>
            </div>
            <div style={{...card(),display:"flex",flexDirection:"column",overflow:"hidden",cursor:"pointer"}}
              onClick={()=>setNodeMapExpanded(true)}>
              <div style={{padding:"8px 12px",borderBottom:`1px solid ${palette.border}`,
                fontSize:11,fontWeight:600,color:palette.textMuted,flexShrink:0,
                display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span>NODE MAP — Click anywhere to expand full detail</span>
                <div style={{display:"flex",gap:12,alignItems:"center"}}>
                  <div style={{display:"flex",gap:12,fontSize:9,color:palette.textMuted}}>
                    {[["ALERT",palette.danger],["QUARANTINE",palette.warning],["WARNING","#CA8A04"],["ONLINE",palette.success]].map(([l,c])=>(
                      <span key={l} style={{display:"flex",alignItems:"center",gap:3}}>
                        <span style={{width:7,height:7,borderRadius:"50%",background:c,display:"inline-block"}}/>{l}
                      </span>
                    ))}
                  </div>
                  <span style={{fontSize:9,fontWeight:600,color:palette.info}}>expand ⤢</span>
                </div>
              </div>
              <div style={{flex:1,position:"relative",overflow:"hidden"}}>
                <svg viewBox="-20 -20 800 740" preserveAspectRatio="xMidYMid meet"
                  style={{width:"100%",height:"100%",background:"#F8FAFC"}}>
                  {Array.from({length:9},(_,i)=>(<line key={`gv${i}`} x1={i*95} y1={-20} x2={i*95} y2={720} stroke="#E2E8F0" strokeWidth="1"/>))}
                  {Array.from({length:9},(_,i)=>(<line key={`gh${i}`} x1={-20} y1={i*90} x2={780} y2={i*90} stroke="#E2E8F0" strokeWidth="1"/>))}
                  {/* Faint floor-plan room outlines — spatial context so Lumina
                      node positions can be read against actual store layout,
                      not a blank grid. Very low opacity to stay subordinate
                      to the node dots, which remain the primary focus. */}
                  <g opacity="0.35">
                    {ROOM_POLYGONS.map((r,i)=>(
                      <g key={`room${i}`}>
                        <polygon points={r.pts} fill={r.fill} stroke="#94A3B8" strokeWidth="1"/>
                        {r.l1&&<text x={r.cx} y={r.l2?r.cy-4:r.cy} textAnchor="middle" dominantBaseline="central"
                          style={{fontSize:6,fill:"#64748B",fontFamily:"Inter,sans-serif",fontWeight:600}}>{r.l1}</text>}
                        {r.l2&&<text x={r.cx} y={r.cy+5} textAnchor="middle" dominantBaseline="central"
                          style={{fontSize:6,fill:"#64748B",fontFamily:"Inter,sans-serif",fontWeight:600}}>{r.l2}</text>}
                      </g>
                    ))}
                  </g>
                  {/* Corridor backbone — spatial context only, not interactive */}
                  {CORRIDOR_EDGES.map(([a,b],i)=>{
                    const pa=JUNCTIONS[a]||EXIT_POS[a]; const pb=JUNCTIONS[b]||EXIT_POS[b];
                    if(!pa||!pb) return null;
                    return <line key={`ce${i}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
                      stroke="#E2E8F0" strokeWidth="1" strokeDasharray="4 4"/>;
                  })}
                  {/* Store doors — small dots showing exact shop locations */}
                  {Object.entries(DOOR_POS).map(([bid,pos])=>(
                    <g key={bid}>
                      <circle cx={pos.x} cy={pos.y} r="2.5" fill="#CBD5E1" stroke="#94A3B8" strokeWidth="0.75"/>
                    </g>
                  ))}
                  {/* 6 physical Lumina hardware nodes — matches expanded modal exactly */}
                  {Object.entries(LUMINA_NODE_DEFS).map(([nid,nodeDef])=>{
                    const m=health.battery[nid]??{pct:85,next_service:"N/A"};
                    const bc=m.pct<60?palette.danger:m.pct<75?palette.warning:palette.success;
                    const coveredJ=Object.entries(J_TO_NODE).filter(([,n])=>n===nid).map(([j])=>j);
                    const worst=coveredJ.map(j=>nodes.find(x=>x.id===j)).filter(Boolean)
                      .sort((a,b)=>(b.status==="alert"?3:b.status==="quarantine"?2:b.status==="warning"?1:0)-
                                    (a.status==="alert"?3:a.status==="quarantine"?2:a.status==="warning"?1:0))[0];
                    const c=statusColor(worst?.status??"normal");
                    const isSel=selectedNode?.id===nid;
                    const totalCrowd=coveredJ.reduce((s,j)=>s+(nodes.find(x=>x.id===j)?.crowd??0),0);
                    return(
                      <g key={nid} style={{cursor:"pointer"}}
                        onClick={()=>setSelectedNode(p=>p?.id===nid?null:{id:nid,zone:nodeDef.label,status:worst?.status??"normal",crowd:totalCrowd,temp:worst?.temp??27,velocity:worst?.velocity??0,pull:worst?.pull_signal??"GREEN"})}>
                        {isSel&&<circle cx={nodeDef.cx} cy={nodeDef.cy} r="16" fill={c} opacity="0.15"/>}
                        <circle cx={nodeDef.cx} cy={nodeDef.cy} r={isSel?10:8}
                          fill={nodeDef.color} stroke="#fff" strokeWidth="1.5"
                          style={worst?.status==="alert"?{animation:"pulse 1s infinite"}:{}}/>
                        <circle cx={nodeDef.cx} cy={nodeDef.cy} r={isSel?10:8} fill="none" stroke={c} strokeWidth="2"/>
                        <g>
                          {/* Battery icon: outline body + terminal nub flush on
                              the right + inner fill bar scaled to pct. Previous
                              version drew two disconnected solid rects with the
                              nub floating above-right of the body instead of
                              attached to it, rendering as an unrecognizable
                              colored flag rather than a battery. */}
                          <rect x={nodeDef.cx+9} y={nodeDef.cy-13.5} width={9} height={5} rx="1"
                            fill="none" stroke={bc} strokeWidth="0.8"/>
                          <rect x={nodeDef.cx+18} y={nodeDef.cy-12.1} width={1.2} height={2.2} rx="0.4" fill={bc}/>
                          <rect x={nodeDef.cx+9.8} y={nodeDef.cy-12.7} width={Math.max(0.5,7.4*(m.pct/100))} height={3.4} rx="0.5" fill={bc}/>
                        </g>
                        <text x={nodeDef.cx} y={nodeDef.cy+15} textAnchor="middle"
                          style={{fontSize:"8px",fill:palette.text,fontFamily:"Inter,sans-serif",fontWeight:700}}>{nid}</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              {selectedNode&&(
                <div style={{padding:"8px 14px",borderTop:`1px solid ${palette.border}`,flexShrink:0,
                  background:statusBg(selectedNode.status),
                  display:"grid",gridTemplateColumns:"auto auto 1fr auto auto auto auto",
                  gap:16,alignItems:"center"}}>
                  <span style={{fontWeight:700,color:statusColor(selectedNode.status)}}>{selectedNode.id}</span>
                  <span style={{color:palette.textMuted,fontSize:11}}>{selectedNode.zone}</span>
                  <span/>
                  <span style={{fontSize:11}}><b>{selectedNode.crowd}</b> pax</span>
                  <span style={{fontSize:11}}><b>{selectedNode.temp}</b>°C</span>
                  <span style={{fontSize:11,color:(selectedNode.velocity??0)>2?palette.warning:palette.textMuted}}>
                    vel {selectedNode.velocity??0}</span>
                  <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:10,
                    background:statusBg(selectedNode.status),color:statusColor(selectedNode.status),
                    border:`1px solid ${statusColor(selectedNode.status)}44`}}>
                    {selectedNode.status.toUpperCase()}</span>
                </div>
              )}
            </div>
            <div style={{...card(),overflow:"hidden",flexShrink:0}}>
              <div style={{padding:"7px 12px",borderBottom:`1px solid ${palette.border}`,
                display:"flex",justifyContent:"space-between",alignItems:"center",
                fontSize:10,fontWeight:600,color:palette.textMuted}}>
                <span>NODE MAINTENANCE — NFPA 72 battery threshold: 60%</span>
                <span style={{fontSize:9,fontWeight:700,padding:"2px 8px",borderRadius:4,
                  background:fftConfirmed?palette.successLight:palette.grayLight,
                  color:fftConfirmed?palette.successDark:palette.gray,
                  border:`1px solid ${fftConfirmed?palette.success:palette.border}`}}
                  title="RAMO 520Hz ADA directional beacon — activates on FACP confirmation">
                  RAMO 520Hz: {fftConfirmed?"ACTIVE":"STANDBY"}
                </span>
              </div>
              {(()=>{
                const PER_PAGE = 3;
                // Build sorted list — urgent maintenance first
                const lumiNodes = Object.entries(LUMINA_NODE_DEFS).map(([nid,nodeDef])=>{
                  const m = health.battery[nid]??{pct:85,next_service:"N/A"};
                  const coveredJ = Object.entries(J_TO_NODE).filter(([,n])=>n===nid).map(([j])=>j);
                  const worstStatus = coveredJ
                    .map(j=>nodes.find(x=>x.id===j))
                    .filter(Boolean)
                    .sort((a,b)=>
                      (b.status==="alert"?3:b.status==="quarantine"?2:b.status==="warning"?1:0)-
                      (a.status==="alert"?3:a.status==="quarantine"?2:a.status==="warning"?1:0)
                    )[0]?.status || "normal";
                  // Priority score — lower = more urgent
                  const priority = worstStatus==="alert"?0 : m.pct<60?1 :
                    worstStatus==="quarantine"?2 : worstStatus==="warning"?3 : m.pct<75?4 : 5;
                  return {nid, nodeDef, m, worstStatus, priority};
                }).sort((a,b)=>a.priority-b.priority);

                const totalPages = Math.ceil(lumiNodes.length/PER_PAGE);
                const page = Math.min(nodeHealthPage, totalPages-1);
                const visible = lumiNodes.slice(page*PER_PAGE, (page+1)*PER_PAGE);

                return(
                  <div>
                    <div style={{display:"grid",gridTemplateColumns:`repeat(${PER_PAGE},1fr)`,alignItems:"start"}}>
                      {visible.map(({nid,nodeDef,m,worstStatus},i)=>{
                        const bc = m.pct<60?palette.danger:m.pct<75?palette.warning:palette.success;
                        const statusCol = worstStatus==="alert"?palette.danger:
                          worstStatus==="quarantine"?palette.warning:
                          worstStatus==="warning"?"#CA8A04":palette.success;
                        const urgent = m.pct<60 || worstStatus==="alert";
                        return(
                          <div key={nid} style={{padding:"6px 10px",
                            borderRight:i<PER_PAGE-1?`1px solid ${palette.border}`:"none",
                            background:urgent?"#FFF5F5":"transparent",
                            borderTop:urgent?`2px solid ${palette.danger}`:"2px solid transparent"}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                              <span style={{fontWeight:700,fontSize:10,color:nodeDef.color}}>{nid}</span>
                              {urgent
                                ? <span style={{fontSize:7,color:palette.danger,fontWeight:700,
                                    padding:"1px 4px",background:"#FEE2E2",borderRadius:3}}>URGENT</span>
                                : m.pct<75
                                  ? <span style={{fontSize:7,color:palette.warning,fontWeight:600}}>MONITOR</span>
                                  : <span style={{fontSize:7,color:palette.success,fontWeight:600}}>OK</span>
                              }
                            </div>
                            <div style={{fontSize:8.5,color:"#475569",marginBottom:3,fontWeight:500}}>{nodeDef.label}</div>
                            {/* Battery bar */}
                            <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                              <div style={{flex:1,height:4,background:"#E2E8F0",borderRadius:2}}>
                                <div style={{height:"100%",width:`${m.pct}%`,background:bc,borderRadius:2,
                                  transition:"width 0.5s"}}/>
                              </div>
                              <span style={{fontSize:8,color:bc,fontWeight:700,minWidth:24}}>{m.pct}%</span>
                            </div>
                            <div style={{fontSize:7.5,color:palette.textMuted,lineHeight:1.5}}>
                              Next service: <b style={{color:m.pct<60?palette.danger:palette.text}}>{m.next_service}</b>
                              {" · "}
                              <span style={{color:statusCol,fontWeight:600}}>● {worstStatus.toUpperCase()}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {/* Pagination */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                      padding:"5px 10px",borderTop:`1px solid ${palette.border}`,
                      background:"#FAFBFC"}}>
                      <span style={{fontSize:8,color:palette.textMuted}}>
                        Sorted by maintenance urgency · {lumiNodes.filter(n=>n.m.pct<60||n.worstStatus==="alert").length} urgent
                      </span>
                      <div style={{display:"flex",alignItems:"center",gap:4,userSelect:"none"}}>
                        <button onClick={()=>setNodeHealthPage(p=>Math.max(0,p-1))}
                          disabled={page===0}
                          style={{background:"none",border:`1px solid ${palette.border}`,borderRadius:4,
                            width:22,height:22,cursor:page===0?"default":"pointer",
                            color:page===0?"#CBD5E1":palette.info,fontSize:12,lineHeight:1}}>◀</button>
                        <span style={{fontSize:9,color:palette.textMuted,minWidth:40,textAlign:"center"}}>
                          {page*PER_PAGE+1}–{Math.min((page+1)*PER_PAGE,lumiNodes.length)} / {lumiNodes.length}
                        </span>
                        <button onClick={()=>setNodeHealthPage(p=>Math.min(totalPages-1,p+1))}
                          disabled={page>=totalPages-1}
                          style={{background:"none",border:`1px solid ${palette.border}`,borderRadius:4,
                            width:22,height:22,cursor:page>=totalPages-1?"default":"pointer",
                            color:page>=totalPages-1?"#CBD5E1":palette.info,fontSize:12,lineHeight:1}}>▶</button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* ══ TAB 3 — ANALYTICS ══ */}
        {tab==="analytics"&&(
          <div style={{flex:1,display:"flex",flexDirection:"column",gap:10,minHeight:0,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,flexShrink:0}}>
              <MetricCard label="Total Footfall" value={nodes.reduce((s,n)=>s+n.crowd,0)} unit="pax" color={palette.info} icon="👣" sub="live across all nodes"/>
              <MetricCard label="Peak Node"      value={nodes.reduce((a,n)=>n.crowd>a.crowd?n:a,nodes[0])?.id??"—"} unit="" color={palette.warning} icon="📍" sub="highest occupancy"/>
              <MetricCard label="Avg Occupancy"  value={Math.round(nodes.reduce((s,n)=>s+n.crowd,0)/Math.max(nodes.length,1))} unit="pax" color={palette.success} icon="📊" sub="system average"/>
              <MetricCard label="Active Alerts"  value={nodes.filter(n=>n.status==="alert").length} unit="" color={nodes.some(n=>n.status==="alert")?palette.danger:palette.success} icon="🔥" sub="thermal anomalies"/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1.5fr 1fr",gap:10,flex:1,minHeight:0,overflow:"hidden"}}>
              <div style={{...card(),padding:"12px 14px",display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden"}}>
                <div style={{fontSize:10,fontWeight:600,color:palette.textMuted,marginBottom:10}}>
                  OCCUPANCY BY LOCATION — RANKED
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:6,
                  flex:1,overflowY:"auto",paddingRight:4,minHeight:0}}>
                  {[...nodes].filter(n=>!n.id.startsWith("EXIT")).sort((a,b)=>b.crowd-a.crowd).map(n=>{
                    const pct=Math.min(100,Math.round((n.crowd/100)*100));
                    // Bar colour reflects crowd density level — consistent with Fruin LOS thresholds
                    // Alert/quarantine status shown via node label, not bar colour
                    const bc=n.status==="alert"?palette.danger:
                             n.status==="warning"?palette.warning:
                             n.crowd>85?palette.danger:
                             n.crowd>60?palette.warning:palette.success;
                    return(
                      <div key={n.id}>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
                          <span style={{fontWeight:600,color:palette.text}}>{n.id}
                            <span style={{fontWeight:400,color:palette.textMuted,marginLeft:6}}>{n.zone?.split("(")[0]?.trim()}</span>
                          </span>
                          <span style={{color:bc,fontWeight:700}}>{n.crowd}p
                            {(n.velocity??0)!==0&&(
                              <span style={{color:palette.textMuted,fontWeight:400,marginLeft:6}}>
                                {n.velocity>0?`+${n.velocity}`:n.velocity}/rdg
                              </span>
                            )}
                          </span>
                        </div>
                        <div style={{height:6,background:palette.grayLight,borderRadius:3}}>
                          <div style={{height:"100%",width:`${pct}%`,background:bc,
                            borderRadius:3,transition:"width 0.8s ease"}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:10,minHeight:0,overflowY:"auto"}}>
                <ChartSlider
                  title="CROWD VELOCITY"
                  idx={velCardIdx}
                  setIdx={setVelCardIdx}
                  cards={nodes.map(n=>({
                    nodeId: n.id,
                    zone:   n.zone ?? n.id,
                    data:   velHistoryPN[n.id] ?? Array(12).fill(0),
                    color:  (n.velocity??0)>5 ? palette.danger : (n.velocity??0)>2 ? palette.warning : palette.info,
                    current:(n.velocity??0)>0 ? `+${(n.velocity??0).toFixed(1)}` : (n.velocity??0).toFixed(1),
                    unit:   "/rdg",
                  }))}
                />
                <ChartSlider
                  title="THERMAL TREND"
                  idx={tempCardIdx}
                  setIdx={setTempCardIdx}
                  cards={nodes.map(n=>({
                    nodeId: n.id,
                    zone:   n.zone ?? n.id,
                    data:   tempHistoryPN[n.id] ?? Array(12).fill(27),
                    color:  (n.temp??27)>50 ? palette.danger : (n.temp??27)>40 ? palette.warning : palette.info,
                    current:(n.temp??27).toFixed(1),
                    unit:   "°C",
                  }))}
                />
              </div>
            </div>
            <div style={{...card(),padding:"8px 12px",flexShrink:0}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:10,fontWeight:600,color:palette.textMuted}}>
                  OCCUPANCY SIGNALS
                </div>
                <button onClick={()=>{
                  const a=document.createElement("a");
                  a.href=apiUrl("/download_log"); a.download="Lumina_Report.csv";
                  document.body.appendChild(a); a.click(); document.body.removeChild(a);
                  pushEvent("Report download initiated","info");
                }} style={{background:palette.purpleLight,border:`1px solid ${palette.purple}`,
                  borderRadius:6,padding:"3px 8px",color:palette.purple,
                  fontSize:9,fontWeight:600,cursor:"pointer"}}>Export CSV</button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                {[
                  {label:"High Traffic",  color:palette.danger,  nodes:nodes.filter(n=>n.crowd>60&&n.id.startsWith("J")), sub:"above 60 pax — DOOH / kiosk", dir:-1},
                  {label:"HVAC Reduce",   color:palette.success, nodes:nodes.filter(n=>n.crowd<10&&n.id.startsWith("J")), sub:"below 10 pax — unoccupied", dir:1},
                  {label:"HVAC Increase", color:palette.warning, nodes:nodes.filter(n=>n.crowd>70&&n.id.startsWith("J")), sub:"above 70 pax — peak load", dir:-1},
                ].map(({label,color,nodes:zn,sub,dir})=>(
                  <div key={label} style={{background:palette.bgCard2,borderRadius:6,
                    padding:"5px 8px",borderLeft:`2px solid ${color}`}}>
                    <div style={{fontSize:9,fontWeight:600,color:palette.text}}>{label}</div>
                    {zn.length>0
                      ? <div style={{display:"flex",flexWrap:"wrap",gap:3,marginTop:3}}>
                          {/* Most relevant 3 shown inline — fixed height, no scroll.
                              High Traffic / HVAC Increase: busiest first (highest crowd).
                              HVAC Reduce: emptiest first (lowest crowd) — those are the
                              strongest candidates for actually cutting HVAC output.
                              Full list available via "View all". */}
                          {[...zn].sort((a,b)=>dir*(b.crowd-a.crowd)).slice(0,3).map(n=>(
                            <span key={n.id} style={{fontSize:8,fontWeight:600,padding:"1px 5px",
                              borderRadius:3,background:`${color}15`,color,
                              border:`1px solid ${color}33`}}>{n.id} — {n.zone?.split("(")[0]?.trim()||n.id}</span>
                          ))}
                          {zn.length>3&&
                            <button onClick={()=>setOccupancyExpandedCat(label)}
                              style={{fontSize:8,color:palette.info,fontWeight:600,
                                background:"transparent",border:"none",cursor:"pointer",padding:"1px 3px"}}>
                              +{zn.length-3} more — View all
                            </button>
                          }
                        </div>
                      : <div style={{fontSize:10,fontWeight:700,color,marginTop:2}}>None</div>
                    }
                    <div style={{fontSize:8,color:palette.textMuted,marginTop:2}}>{sub}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── OCCUPANCY SIGNALS — FULL LIST MODAL ── */}
        {occupancyExpandedCat&&(()=>{
          const catDef = {
            "High Traffic":  {color:palette.danger,  nodes:nodes.filter(n=>n.crowd>60&&n.id.startsWith("J")), sub:"above 60 pax — DOOH / kiosk", dir:-1},
            "HVAC Reduce":   {color:palette.success, nodes:nodes.filter(n=>n.crowd<10&&n.id.startsWith("J")), sub:"below 10 pax — unoccupied", dir:1},
            "HVAC Increase": {color:palette.warning, nodes:nodes.filter(n=>n.crowd>70&&n.id.startsWith("J")), sub:"above 70 pax — peak load", dir:-1},
          }[occupancyExpandedCat];
          if (!catDef) return null;
          const sorted = [...catDef.nodes].sort((a,b)=>catDef.dir*(b.crowd-a.crowd));
          return(
            <div style={{position:"fixed",inset:0,zIndex:1000,background:"rgba(0,0,0,0.45)",
              display:"flex",alignItems:"center",justifyContent:"center"}}
              onClick={()=>setOccupancyExpandedCat(null)}>
              <div style={{background:"#fff",borderRadius:12,width:"90vw",maxWidth:560,
                maxHeight:"80vh",display:"flex",flexDirection:"column",overflow:"hidden"}}
                onClick={e=>e.stopPropagation()}>
                <div style={{padding:"10px 16px",borderBottom:`1px solid ${palette.border}`,
                  display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0,
                  borderLeft:`3px solid ${catDef.color}`}}>
                  <div>
                    <span style={{fontWeight:700,fontSize:13,color:palette.text}}>{occupancyExpandedCat}</span>
                    <span style={{marginLeft:10,fontSize:10,color:palette.textMuted}}>{catDef.sub}</span>
                    <span style={{marginLeft:10,fontSize:10,fontWeight:600,color:catDef.color}}>{sorted.length} nodes</span>
                  </div>
                  <button onClick={()=>setOccupancyExpandedCat(null)} style={{background:"transparent",
                    border:`1px solid ${palette.border}`,borderRadius:6,padding:"4px 10px",
                    fontSize:11,cursor:"pointer",color:palette.text}}>Close</button>
                </div>
                <div style={{flex:1,overflowY:"auto",padding:"10px 16px",
                  display:"flex",flexDirection:"column",gap:6}}>
                  {sorted.map(n=>(
                    <div key={n.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                      padding:"6px 10px",background:palette.bgCard2,borderRadius:6,
                      borderLeft:`2px solid ${catDef.color}`}}>
                      <span style={{fontSize:11,fontWeight:600,color:palette.text}}>
                        {n.id} — {n.zone?.split("(")[0]?.trim()||n.id}
                      </span>
                      <span style={{fontSize:11,fontWeight:700,color:catDef.color}}>{n.crowd}p</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
