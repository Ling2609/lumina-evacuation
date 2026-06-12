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

const FALLBACK_NODES = nodeData.map(n => ({ ...n, velocity: 0, pull: "GREEN" }));
const apiUrl = path => `http://${FLASK_IP}:${FLASK_PORT}${path}`;

// ─── FLOOR PLAN GEOMETRY ─────────────────────────────────────────────────────
const ROOM_DEFS = {
  "N-011": { x:40,  y:210, w:185, h:150, label:"Lobby",      sub:"N-011" },
  "N-031": { x:250, y:210, w:185, h:150, label:"Office",     sub:"N-031" },
  "N-042": { x:40,  y:30,  w:185, h:165, label:"Retail A",   sub:"N-042" },
  "N-043": { x:250, y:30,  w:185, h:165, label:"Corridor B", sub:"N-043" },
  "N-067": { x:460, y:30,  w:185, h:165, label:"Stairwell",  sub:"N-067" },
  "N-089": { x:460, y:210, w:185, h:150, label:"Exit East",  sub:"N-089" },
};
const CORRIDORS = [
  {from:"N-011",to:"N-042"},{from:"N-011",to:"N-031"},
  {from:"N-042",to:"N-043"},{from:"N-043",to:"N-067"},
  {from:"N-031",to:"N-067"},{from:"N-067",to:"N-089"},
  {from:"N-043",to:"N-089"},  // direct Corridor B → Exit East (matches FACILITY_GRAPH)
];
const rc = id => { const r=ROOM_DEFS[id]; return r?{x:r.x+r.w/2,y:r.y+r.h/2}:{x:0,y:0}; };

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
  const d = entry.data, max = Math.max(...d, 1), w = 100, h = 50;
  const pts  = d.map((v,i) => `${(i/(d.length-1))*w},${h-(v/max)*h}`).join(" ");
  const area = `${pts} ${w},${h} 0,${h}`;
  const gid  = `sg${entry.nodeId}${title.replace(/\s/g,"")}`;
  return (
    <div style={{background:palette.bgCard,border:`1px solid ${palette.border}`,borderRadius:10,
      padding:"12px 14px",flex:1,display:"flex",flexDirection:"column",gap:4}}>
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
          const lx=w-2.5, ly=Math.max(2.5, Math.min(h-2.5, h-(d[d.length-1]/max)*h));
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
  const [activeRoute,   setActiveRoute]   = useState(["N-011","N-042","N-043","N-089"]);
  const [pasCountdown,  setPasCountdown]  = useState(178);
  const [personCount,   setPersonCount]   = useState(0);
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
  const [manualOverride,  setManualOverride]  = useState(false);
  const [manualBlockedNode, setManualBlockedNode] = useState(null); // only this node gets purple
  const [health, setHealth] = useState({
    uptime_s:0, yolo_loaded:false, mqtt_connected:false,
    camera_open:false, nodes_online:198, nodes_total:200,
    thermal_latency_ms:0, fft_latency_ms:0,
    battery:{
      "N-011":{pct:94,next_service:"Aug 10"},
      "N-031":{pct:87,next_service:"Aug 01"},
      "N-042":{pct:72,next_service:"Jul 15"},
      "N-043":{pct:81,next_service:"Aug 05"},
      "N-067":{pct:96,next_service:"Aug 12"},
      "N-089":{pct:63,next_service:"Jul 01"},
    },
  });

  const lastThermalRef    = useRef("NORMAL");
  const lastFftRef        = useRef("SILENT");
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
        setAiMode(d.ai_mode??"DIORAMA");
        if (!manualOverrideRef.current) {
          // AUTO mode — backend drives everything
          setIsHazard(d.system_state==="HAZARD");
          setThermalState(d.thermal_state??"NORMAL");
          setFftState(d.fft_state??"SILENT");
          setFftConfirmed(d.facp_confirmed??false);
          if (d.current_route?.length) setActiveRoute(d.current_route);
          if (d.pull_signals) setPullSignals(d.pull_signals);
          if (d.rset) setRset(d.rset);
          if (d.cost_score !== undefined) setCostScore(d.cost_score);
          if (d.nodes) {
            const pm = Object.fromEntries(FALLBACK_NODES.map(n=>[n.id,{x:n.x,y:n.y,zone:n.zone}]));
            const merged = Object.entries(d.nodes).map(([id,v])=>({
              id, zone:pm[id]?.zone??id, x:pm[id]?.x??50, y:pm[id]?.y??50,
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
          const thermalNode = d.nodes ? Object.entries(d.nodes).find(([,v])=>v.hazard==="thermal")?.[0] : "N-042";
          pushEvent(`Thermal anomaly at ${thermalNode||"N-042"} — quarantine projected`,"danger","REACTIVE");
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
        if(p.person_count!==undefined) setPersonCount(p.person_count);
        if(p.status==="CRITICAL"){
          setIsHazard(true); setHazardType(p.hazard_type??"HAZARD");
          setPasCountdown(178);
          if(p.hazard_type==="FALL DETECTED"){
            pushEvent(`Fall detected — buffer zone active, evacuees redirected`,"danger","REACTIVE");
          } else {
            pushEvent(`CRITICAL: ${p.hazard_type}`,"danger","REACTIVE");
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
    setIsHazard(false); setPasCountdown(178); setFftConfirmed(false); setPullSignals({});
    setActiveRoute(["N-011","N-042","N-043","N-089"]);
    pushEvent("RESET — manual override released, returning to AUTO mode","info");
    try{ await fetch(apiUrl("/reset")); } catch{ /* offline */ }
  };

  const triggerFire=async()=>{
    // No physical thermal sensor in this prototype — fire is triggered manually
    // for demonstration. Fall detection (camera) works independently and
    // does not require this trigger.
    pushEvent("DEMO: Fire simulation triggered at N-042 — thermal classifier active","danger","REACTIVE");
    try{ await fetch(apiUrl("/trigger")); } catch{ pushEvent("Trigger failed — backend offline","danger"); }
  };

  const toggleAiMode=async()=>{
    const m=aiMode==="DIORAMA"?"ENTERPRISE":"DIORAMA";
    try{ await fetch(apiUrl(`/api/set_mode/${m}`)); } catch{ /* offline */ }
    setAiMode(m);
  };

  const overridePath=async()=>{
    if(!isHazard){ alert("Cannot override during normal operations."); return; }
    const target=selectedNode?.id??"N-031";
    // Only reject if THIS node was already manually blocked by BOMBA
    if(target===manualBlockedNode){
      alert(`${target} is already manually blocked. Press RESET to release it.`); return;
    }
    setManualOverride(true);
    try{
      const r=await fetch(apiUrl("/api/block_node"),{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({node_id:target})});
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
  // Animated route segments — break only at the BOMBA-blocked node.
  // Uses manualBlockedNode (not node.status) as single source of truth,
  // so stale backend statuses never affect the animation.
  const safeRouteSegments = activeRoute.reduce((segs, id) => {
    if (id === manualBlockedNode) { segs.push([]); }
    else {
      if (!segs.length) segs.push([]);
      segs[segs.length-1].push(id);
    }
    return segs;
  }, []).filter(s=>s.length>1);

  const roomFill=id=>{
    const n=nodes.find(x=>x.id===id); if(!n) return "#F8FAFC";
    if(n.id===manualBlockedNode) return palette.purpleLight;
    return {alert:"#FEF2F2",quarantine:"#FFFBEB",warning:"#FEFCE8",normal:"#F0FDF4"}[n.status]??"#F8FAFC";
  };
  const roomBorder=id=>{
    const n=nodes.find(x=>x.id===id); if(!n) return palette.border;
    if(n.id===manualBlockedNode) return palette.purple;
    return {alert:palette.danger,quarantine:palette.warning,warning:"#CA8A04",normal:palette.border}[n.status]??palette.border;
  };
  const crowdDots=id=>{
    const n=nodes.find(x=>x.id===id);
    const count=Math.min(6,Math.round((n?.crowd??0)/15));
    const r=ROOM_DEFS[id]; if(!r) return [];
    return Array.from({length:count},(_,i)=>({
      x:r.x+22+(i%3)*30, y:r.y+r.h-26-Math.floor(i/3)*22,
    }));
  };

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
                <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style={{width:"100%",height:"100%"}}>
                  {Array.from({length:11},(_,i)=>(<line key={`gv${i}`} x1={i*10} y1={0} x2={i*10} y2={100} stroke="#E2E8F0" strokeWidth="0.3"/>))}
                  {Array.from({length:11},(_,i)=>(<line key={`gh${i}`} x1={0} y1={i*10} x2={100} y2={i*10} stroke="#E2E8F0" strokeWidth="0.3"/>))}
                  {nodes.length>0&&[["N-011","N-042"],["N-011","N-031"],["N-042","N-043"],
                    ["N-043","N-067"],["N-031","N-067"],["N-067","N-089"]].map(([a,b],i)=>{
                    const na=nodes.find(x=>x.id===a),nb=nodes.find(x=>x.id===b);
                    if(!na||!nb) return null;
                    return <line key={i} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
                      stroke="#CBD5E1" strokeWidth="0.8" strokeDasharray="2 1.5"/>;
                  })}
                  {nodes.map(n=>{
                    const c=statusColor(n.status);
                    const isSel=selectedNode?.id===n.id;
                    const m=health.battery[n.id]??{pct:85,next_service:"N/A"};
                    const bc=m.pct<60?palette.danger:m.pct<75?palette.warning:palette.success;
                    return(
                      <g key={n.id} style={{cursor:"pointer"}}
                        onClick={()=>setSelectedNode(p=>p?.id===n.id?null:n)}>
                        {isSel&&<circle cx={n.x} cy={n.y} r="7" fill={c} opacity="0.15"/>}
                        <circle cx={n.x} cy={n.y} r={isSel?5.5:4}
                          fill={c} stroke="#fff" strokeWidth="1"
                          style={n.status==="alert"?{animation:"pulse 1s infinite"}:{}}/>
                        <g>
                          {/* battery body */}
                          <rect x={n.x+2.5} y={n.y-6} width={4.5} height={2.8} rx="0.5" fill={bc} opacity="0.9"/>
                          {/* nub on right */}
                          <rect x={n.x+7} y={n.y-5.2} width={1} height={1.2} rx="0.3" fill={bc} opacity="0.9"/>
                        </g>
                        <text x={n.x} y={n.y+8} textAnchor="middle"
                          style={{fontSize:"3.5px",fill:palette.text,fontFamily:"Inter,sans-serif",fontWeight:600}}>
                          {n.id}</text>
                        <text x={n.x} y={n.y+12} textAnchor="middle"
                          style={{fontSize:"3px",fill:palette.textMuted,fontFamily:"Inter,sans-serif"}}>
                          {n.crowd}p · {n.temp}°C</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div style={{overflow:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,minWidth:520}}>
                  <thead>
                    <tr style={{background:palette.bgCard2,position:"sticky",top:0,zIndex:1}}>
                      {["Node","Zone","Status","Crowd","Velocity","Temp","Pull","Battery","Next Svc","Hazard"].map(h=>(
                        <th key={h} style={{padding:"9px 10px",textAlign:"left",fontSize:10,
                          color:palette.textMuted,fontWeight:600,whiteSpace:"nowrap",
                          borderBottom:`1px solid ${palette.border}`}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {nodes.map((n,i)=>{
                      const m=health.battery[n.id]??{pct:85,next_service:"N/A"};
                      const bc=m.pct<60?palette.danger:m.pct<75?palette.warning:palette.success;
                      const sc=statusColor(n.status);
                      const isSel=selectedNode?.id===n.id;
                      return(
                        <tr key={n.id} onClick={()=>setSelectedNode(p=>p?.id===n.id?null:n)}
                          style={{borderBottom:`1px solid ${palette.border}`,cursor:"pointer",
                            background:isSel?statusBg(n.status):i%2===0?"transparent":`${palette.bgCard2}55`}}>
                          <td style={{padding:"9px 10px",fontWeight:700,color:palette.info,whiteSpace:"nowrap"}}>{n.id}</td>
                          <td style={{padding:"9px 10px",color:palette.textMuted,fontSize:10}}>{n.zone}</td>
                          <td style={{padding:"9px 10px"}}>
                            <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:4,
                              background:statusBg(n.status),color:sc,
                              border:`1px solid ${sc}33`,whiteSpace:"nowrap"}}>{n.status.toUpperCase()}</span>
                          </td>
                          <td style={{padding:"9px 10px",color:n.crowd>70?palette.warning:palette.text,fontWeight:600}}>{n.crowd}p</td>
                          <td style={{padding:"9px 10px",color:(n.velocity??0)>2?palette.warning:palette.textMuted,whiteSpace:"nowrap"}}>
                            {(n.velocity??0)>0?`+${n.velocity}`:n.velocity??0}/rdg</td>
                          <td style={{padding:"9px 10px",color:n.temp>50?palette.danger:palette.text,whiteSpace:"nowrap"}}>{n.temp}°C</td>
                          <td style={{padding:"9px 10px"}}>
                            <span style={{fontSize:10,fontWeight:700,
                              color:n.pull==="GREEN"?palette.success:palette.danger}}>{n.pull??"—"}</span>
                          </td>
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
                            color:n.hazard?palette.danger:palette.success,whiteSpace:"nowrap"}}>
                            {n.hazard?n.hazard.toUpperCase():"NONE"}</td>
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
              <svg viewBox="0 0 700 420" style={{width:"100%",height:"100%",background:"#F8FAFC"}}>
                {Array.from({length:8},(_,i)=>(<line key={`v${i}`} x1={i*100} y1={0} x2={i*100} y2={420} stroke="#E2E8F0" strokeWidth="0.5"/>))}
                {Array.from({length:6},(_,i)=>(<line key={`h${i}`} x1={0} y1={i*84} x2={700} y2={i*84} stroke="#E2E8F0" strokeWidth="0.5"/>))}
                {CORRIDORS.map((c,i)=>{
                  const isOnRoute = activeRoute.includes(c.from) && activeRoute.includes(c.to) &&
                    activeRoute.indexOf(c.to) === activeRoute.indexOf(c.from)+1;
                  const sig = pullSignals[c.from];
                  const offRouteBlocked = !isOnRoute && (
                    nodes.find(x=>x.id===c.from)?.status==="alert"||
                    nodes.find(x=>x.id===c.to)?.status==="alert"||
                    nodes.find(x=>x.id===c.from)?.status==="quarantine"||
                    nodes.find(x=>x.id===c.to)?.status==="quarantine"
                  );
                  const f=rc(c.from),t=rc(c.to);
                  // Skip static line on active route — animated polyline handles it
                  if (isOnRoute) return null;
                  return <line key={i} x1={f.x} y1={f.y} x2={t.x} y2={t.y}
                    stroke={offRouteBlocked||sig?.signal==="RED"?palette.danger:"#CBD5E1"}
                    strokeWidth="1.5" strokeDasharray="5 3" opacity="0.7"/>;
                })}
                {safeRouteSegments.map((seg,si)=>{
                  const pts=seg.map(id=>{const c=rc(id);return`${c.x},${c.y}`;}).join(" ");
                  return(<g key={si}>
                    <polyline points={pts} fill="none" stroke={palette.success}
                      strokeWidth="3" strokeDasharray="10 5" opacity="0.9"
                      style={{animation:"dash 1.5s linear infinite"}}/>
                    <polyline points={pts} fill="none" stroke={palette.success} strokeWidth="8" opacity="0.07"/>
                  </g>);
                })}
                {Object.entries(ROOM_DEFS).map(([id,r])=>{
                  const n=nodes.find(x=>x.id===id);
                  const isAlert=n?.status==="alert";
                  const isSel=selectedNode?.id===id;
                  const centre=rc(id);
                  const ridx=activeRoute.indexOf(id);
                  const isBlocked=id===manualBlockedNode;
                  return(
                    <g key={id} style={{cursor:"pointer"}} onClick={()=>setSelectedNode(n??null)}>
                      {isAlert&&<rect x={r.x-5} y={r.y-5} width={r.w+10} height={r.h+10}
                        rx="10" fill={palette.danger} opacity="0.08"
                        style={{animation:"pulse 1.2s infinite"}}/>}
                      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="7"
                        fill={roomFill(id)} stroke={isSel?palette.info:roomBorder(id)} strokeWidth={isSel?2:1}/>
                      <text x={r.x+r.w/2} y={r.y+28} textAnchor="middle"
                        style={{fontSize:13,fontWeight:600,
                          fill:n?.status==="alert"?palette.danger:
                               (n?.id===manualBlockedNode)?palette.purple:
                               n?.status==="quarantine"?palette.warning:palette.text,
                          fontFamily:"Inter,sans-serif"}}>{r.label}</text>
                      <text x={r.x+r.w/2} y={r.y+44} textAnchor="middle"
                        style={{fontSize:10,fill:"#64748B",fontFamily:"Inter,sans-serif"}}>{r.sub}</text>
                      <text x={r.x+r.w-8} y={r.y+18} textAnchor="end"
                        style={{fontSize:11,fill:n?.crowd>70?palette.warning:palette.gray,
                          fontFamily:"Inter,sans-serif"}}>{n?.crowd??0}p</text>
                      {isHazard&&n?.status==="alert"&&(()=>{
                        const icon = n?.hazard==="thermal"?"🔥":n?.hazard==="fall"?"🚨":n?.hazard==="smoke"?"💨":"⚠";
                        const label = n?.hazard==="thermal"?"FIRE":n?.hazard==="fall"?"FALL":n?.hazard==="smoke"?"SMOKE":"ALERT";
                        const col = n?.hazard==="fall"?palette.warning:palette.danger;
                        const cx = r.x+r.w/2, cy = r.y+r.h/2;
                        return(
                          <g style={{pointerEvents:"none"}}>
                            <text x={cx} y={cy-4} textAnchor="middle" dominantBaseline="central"
                              style={{fontSize:60,opacity:0.22}}>{icon}</text>
                            <text x={cx} y={cy+r.h/2-14} textAnchor="middle"
                              style={{fontSize:13,fontWeight:800,fill:col,
                                fontFamily:"Inter,sans-serif",letterSpacing:"0.12em"}}>
                              {label}
                            </text>
                          </g>
                        );
                      })()}
                      {crowdDots(id).map((dot,di)=>(
                        <circle key={di} cx={dot.x} cy={dot.y} r="4.5" fill={palette.info} opacity="0.5"/>
                      ))}
                      {ridx>=0&&!isBlocked&&(()=>{
                        // Only exclude the BOMBA-blocked node — all other route nodes get a label
                        // (alert nodes on the route are still passable — DYN-A* chose this path)
                        const routeVisible = activeRoute.filter(rid=>rid!==manualBlockedNode);
                        const visibleIdx   = routeVisible.indexOf(id)+1;
                        const visibleTotal = routeVisible.length;
                        if(visibleIdx<=0) return null;
                        return(
                          <g>
                            <circle cx={centre.x} cy={centre.y}
                              r={visibleIdx===1||visibleIdx===visibleTotal?12:8}
                              fill={visibleIdx===visibleTotal?palette.success:visibleIdx===1?palette.warning:palette.info}
                              opacity="0.9"/>
                            <text x={centre.x} y={centre.y+1} textAnchor="middle" dominantBaseline="central"
                              style={{fontSize:9,fontWeight:700,fill:"#fff",fontFamily:"Inter,sans-serif"}}>
                              {visibleIdx}
                            </text>
                          </g>
                        );
                      })()}
                    </g>
                  );
                })}
              </svg>
              <div style={{borderLeft:`1px solid ${palette.border}`,display:"flex",
                flexDirection:"column",overflow:"hidden",minWidth:255,maxWidth:280}}>
                <div style={{padding:"8px 12px",borderBottom:`1px solid ${palette.border}`,flexShrink:0}}>
                  <div style={{fontSize:9,fontWeight:600,color:palette.textMuted,marginBottom:6}}>ACTIVE ROUTE</div>
                  <div style={{display:"flex",flexDirection:"column",gap:3}}>
                    {activeRoute.map((id,i)=>{
                      const n=nodes.find(x=>x.id===id);
                      const sc=statusColor(n?.status??"normal");
                      return(
                        <div key={id} style={{display:"flex",alignItems:"center",gap:5}}>
                          <div style={{width:14,height:14,borderRadius:"50%",flexShrink:0,
                            background:i===0?palette.warningLight:i===activeRoute.length-1?palette.successLight:palette.infoLight,
                            border:`1px solid ${i===0?palette.warning:i===activeRoute.length-1?palette.success:palette.info}`,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            fontSize:7,fontWeight:700,
                            color:i===0?palette.warning:i===activeRoute.length-1?palette.success:palette.info,
                          }}>{i+1}</div>
                          <span style={{fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:4,
                            background:statusBg(n?.status??"normal"),color:sc,
                            border:`1px solid ${sc}33`}}>{id}</span>
                          <span style={{fontSize:9,color:palette.textMuted,flex:1,
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {n?.zone?.split("/").pop()?.trim()??id}</span>
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
                  <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:5}}>
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
                          }}>{n.id}{isBomba?" ✕":""}</button>
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
                  {[
                    {label:"Route A",desc:"Office → Stairwell",     path:["N-011","N-031","N-067","N-089"],safe:true},
                    {label:"Route B",desc:"Corridor B → Stairwell", path:["N-011","N-042","N-043","N-067","N-089"],
                      safe:!nodes.find(n=>n.id==="N-042")?.status?.includes("alert")},
                    {label:"Route C",desc:"Lobby → Stairwell",      path:["N-011","N-067","N-089"],safe:true},
                  ].map(opt=>{
                    const isActive=JSON.stringify(activeRoute)===JSON.stringify(opt.path);
                    return(
                      <button key={opt.label} onClick={()=>{
                        // Quick routes only suggest a path — system stays in AUTO mode
                        // so real sensor triggers still work after BOMBA selects a route
                        setActiveRoute(opt.path);
                        setManualBlockedNode(null);
                        pushEvent(`BOMBA: ${opt.label} suggested — ${opt.path.join(" → ")}. AUTO mode active.`,"info","PRE-EMPTIVE");
                      }} style={{width:"100%",marginBottom:4,
                        background:isActive?palette.purpleLight:opt.safe?palette.successLight:palette.warningLight,
                        border:`1px solid ${isActive?palette.purple:opt.safe?palette.success:palette.warning}`,
                        borderRadius:5,padding:"4px 8px",cursor:"pointer",
                        display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div><span style={{fontSize:10,fontWeight:700,
                          color:isActive?palette.purple:opt.safe?palette.successDark:palette.warningDark}}>
                          {opt.label} {isActive?"(ACTIVE)":""}
                        </span>
                        <span style={{fontSize:9,color:palette.textMuted,marginLeft:6}}>{opt.desc}</span></div>
                        <span style={{fontSize:8,fontWeight:700,flexShrink:0,
                          color:opt.safe?palette.success:palette.warning}}>
                          {opt.safe?"CLEAR":"CAUTION"}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{padding:"8px 12px",flex:1}}>
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
            {label:"PERSONS",value:`${personCount}`,color:palette.info},
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
                  onClick={()=>setCamExpanded({id:"CAM-01",label:"Lobby — N-011",sublabel:"Lobby",live:true,node:"N-011"})}>
                  <img src={apiUrl("/video_feed")} alt="CAM-01"
                    style={{width:"100%",height:"100%",objectFit:"contain",display:"block",
                      filter:isHazard?"sepia(40%) hue-rotate(320deg) saturate(180%)":"none"}}
                    onError={e=>{e.target.style.display="none";}}/>
                  <div style={{position:"absolute",top:6,left:6,background:"rgba(0,0,0,0.65)",
                    borderRadius:4,padding:"3px 8px",display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:9,color:"#10B981",fontWeight:700}}>● LIVE</span>
                    <span style={{fontSize:9,color:"#CBD5E1",fontWeight:600}}>CAM-01</span>
                    <span style={{fontSize:8,color:"#94A3B8"}}>Lobby · N-011</span>
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
                    {id:"CAM-02",sublabel:"Retail A",   node:"N-042"},
                    {id:"CAM-03",sublabel:"Corridor B", node:"N-043"},
                    {id:"CAM-04",sublabel:"Office",     node:"N-031"},
                    {id:"CAM-05",sublabel:"Stairwell",  node:"N-067"},
                    {id:"CAM-06",sublabel:"Exit East",  node:"N-089"},
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
                <svg viewBox="0 0 700 390" onClick={()=>setTwinExpanded(true)}
                  style={{flex:1,width:"100%",background:"#F8FAFC",cursor:"pointer"}}
                  title="Click to expand full command view">
                  <g opacity="0.5">
                    <rect x="670" y="4" width="26" height="18" rx="3" fill="#E0E7FF"/>
                    <text x="683" y="14" textAnchor="middle" dominantBaseline="central"
                      style={{fontSize:9,fill:"#4338CA",fontFamily:"Inter,sans-serif",fontWeight:600}}>⤢</text>
                  </g>
                  {Array.from({length:8},(_,i)=>(<line key={`v${i}`} x1={i*100} y1={0} x2={i*100} y2={390} stroke="#E2E8F0" strokeWidth="0.5"/>))}
                  {Array.from({length:5},(_,i)=>(<line key={`h${i}`} x1={0} y1={i*80} x2={700} y2={i*80} stroke="#E2E8F0" strokeWidth="0.5"/>))}
                  {CORRIDORS.map((c,i)=>{
                    const isOnRoute = activeRoute.includes(c.from) && activeRoute.includes(c.to) &&
                      activeRoute.indexOf(c.to) === activeRoute.indexOf(c.from)+1;
                    const sig = pullSignals[c.from];
                    const offRouteBlocked = !isOnRoute && (
                      nodes.find(x=>x.id===c.from)?.status==="alert"||
                      nodes.find(x=>x.id===c.to)?.status==="alert"||
                      nodes.find(x=>x.id===c.from)?.status==="quarantine"||
                      nodes.find(x=>x.id===c.to)?.status==="quarantine"
                    );
                    const f=rc(c.from),t=rc(c.to);
                    if (isOnRoute) return null;
                    return <line key={i} x1={f.x} y1={f.y} x2={t.x} y2={t.y}
                      stroke={offRouteBlocked||sig?.signal==="RED"?palette.danger:"#CBD5E1"}
                      strokeWidth="1.5" strokeDasharray="5 3" opacity="0.6"/>;
                  })}
                  {safeRouteSegments.map((seg,si)=>{
                    const pts=seg.map(id=>{const c=rc(id);return`${c.x},${c.y}`;}).join(" ");
                    return(<g key={si}>
                      <polyline points={pts} fill="none" stroke={palette.success}
                        strokeWidth="2.5" strokeDasharray="10 5" opacity="0.85"
                        style={{animation:"dash 1.5s linear infinite"}}/>
                      <polyline points={pts} fill="none" stroke={palette.success} strokeWidth="6" opacity="0.08"/>
                    </g>);
                  })}
                  {Object.entries(ROOM_DEFS).map(([id,r])=>{
                    const n=nodes.find(x=>x.id===id);
                    const isAlert=n?.status==="alert";
                    const isSel=selectedNode?.id===id;
                    const centre=rc(id);
                    const routeIdx=activeRoute.indexOf(id);
                    const isBlocked=id===manualBlockedNode;
                    return(
                      <g key={id} style={{cursor:"pointer"}} onClick={()=>setSelectedNode(n??null)}>
                        {isAlert&&<rect x={r.x-4} y={r.y-4} width={r.w+8} height={r.h+8}
                          rx="9" fill={palette.danger} opacity="0.08"
                          style={{animation:"pulse 1.2s infinite"}}/>}
                        <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="6"
                          fill={roomFill(id)} stroke={isSel?palette.info:roomBorder(id)}
                          strokeWidth={isSel?1.5:0.8}/>
                        <text x={r.x+r.w/2} y={r.y+22} textAnchor="middle"
                          style={{fontSize:11,fontWeight:600,
                            fill:n?.status==="alert"?palette.danger:
                                 (n?.id===manualBlockedNode)?palette.purple:
                                 n?.status==="quarantine"?palette.warning:palette.text,
                            fontFamily:"Inter,sans-serif"}}>{r.label}</text>
                        <text x={r.x+r.w/2} y={r.y+35} textAnchor="middle"
                          style={{fontSize:9,fill:"#64748B",fontFamily:"Inter,sans-serif"}}>{r.sub}</text>
                        <text x={r.x+r.w-6} y={r.y+14} textAnchor="end"
                          style={{fontSize:9,fill:n?.crowd>70?palette.warning:palette.gray,
                            fontFamily:"Inter,sans-serif"}}>{n?.crowd??0}p</text>
                        {(n?.velocity??0)>2&&(
                          <text x={r.x+6} y={r.y+14} textAnchor="start"
                            style={{fontSize:8,fill:(n?.velocity??0)>5?palette.danger:palette.warning,
                              fontFamily:"Inter,sans-serif",fontWeight:700}}>
                            +{n.velocity.toFixed(1)}
                          </text>
                        )}
                        {crowdDots(id).map((dot,di)=>(
                          <circle key={di} cx={dot.x} cy={dot.y} r="3.5" fill={palette.info} opacity="0.55"/>
                        ))}
                        {isHazard&&n?.status==="alert"&&(()=>{
                          const icon = n?.hazard==="thermal"?"🔥":n?.hazard==="fall"?"🚨":n?.hazard==="smoke"?"💨":"⚠";
                          const label = n?.hazard==="thermal"?"FIRE":n?.hazard==="fall"?"FALL":n?.hazard==="smoke"?"SMOKE":"ALERT";
                          const col = n?.hazard==="fall"?palette.warning:palette.danger;
                          const cx = r.x+r.w/2, cy = r.y+r.h/2;
                          return(
                            <g style={{pointerEvents:"none"}}>
                              <text x={cx} y={cy-2} textAnchor="middle" dominantBaseline="central"
                                style={{fontSize:46,opacity:0.22}}>{icon}</text>
                              <text x={cx} y={cy+r.h/2-12} textAnchor="middle"
                                style={{fontSize:11,fontWeight:800,fill:col,
                                  fontFamily:"Inter,sans-serif",letterSpacing:"0.12em"}}>
                                {label}
                              </text>
                            </g>
                          );
                        })()}
                        {routeIdx>=0&&!isBlocked&&(()=>{
                          const routeVisible = activeRoute.filter(rid=>rid!==manualBlockedNode);
                          const visibleIdx   = routeVisible.indexOf(id)+1;
                          const visibleTotal = routeVisible.length;
                          if(visibleIdx<=0) return null;
                          return(
                            <g>
                              <circle cx={centre.x} cy={centre.y}
                                r={visibleIdx===1||visibleIdx===visibleTotal?9:6}
                                fill={visibleIdx===visibleTotal?palette.success:visibleIdx===1?palette.warning:palette.info}
                                opacity="0.9"/>
                              <text x={centre.x} y={centre.y+1} textAnchor="middle" dominantBaseline="central"
                                style={{fontSize:8,fontWeight:700,fill:"#fff",fontFamily:"Inter,sans-serif"}}>
                                {visibleIdx}
                              </text>
                            </g>
                          );
                        })()}
                      </g>
                    );
                  })}
                  {activeRoute.length<=1&&(
                    <text x="350" y="195" textAnchor="middle" dominantBaseline="central"
                      style={{fontSize:13,fontWeight:700,fill:palette.danger,fontFamily:"Inter,sans-serif"}}>
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
                {Object.keys(pullSignals).length>0&&(
                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                    {Object.entries(pullSignals).map(([nid,info])=>(
                      <span key={nid} style={{fontSize:8,fontWeight:700,padding:"1px 5px",borderRadius:3,
                        background:info.signal==="GREEN"?`${palette.success}18`:`${palette.danger}18`,
                        color:info.signal==="GREEN"?palette.success:palette.danger}}>
                        {nid}: {info.signal}
                      </span>
                    ))}
                  </div>
                )}
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
                <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"
                  style={{width:"100%",height:"100%",background:"#F8FAFC"}}>
                  {Array.from({length:11},(_,i)=>(<line key={`gv${i}`} x1={i*10} y1={0} x2={i*10} y2={100} stroke="#E2E8F0" strokeWidth="0.3"/>))}
                  {Array.from({length:11},(_,i)=>(<line key={`gh${i}`} x1={0} y1={i*10} x2={100} y2={i*10} stroke="#E2E8F0" strokeWidth="0.3"/>))}
                  {nodes.length>0&&[["N-011","N-042"],["N-011","N-031"],["N-042","N-043"],
                    ["N-043","N-067"],["N-031","N-067"],["N-067","N-089"]].map(([a,b],i)=>{
                    const na=nodes.find(x=>x.id===a),nb=nodes.find(x=>x.id===b);
                    if(!na||!nb) return null;
                    return <line key={i} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
                      stroke="#CBD5E1" strokeWidth="0.6" strokeDasharray="2 1.5"/>;
                  })}
                  {nodes.map(n=>{
                    const c=statusColor(n.status);
                    const isSel=selectedNode?.id===n.id;
                    const m=health.battery[n.id]??{pct:85,next_service:"N/A"};
                    const bc=m.pct<60?palette.danger:m.pct<75?palette.warning:palette.success;
                    return(
                      <g key={n.id} style={{cursor:"pointer"}}
                        onClick={e=>{e.stopPropagation();setSelectedNode(p=>p?.id===n.id?null:n);}}>
                        {isSel&&<circle cx={n.x} cy={n.y} r="5.5" fill={c} opacity="0.2"/>}
                        <circle cx={n.x} cy={n.y} r={isSel?4:3} fill={c} stroke="#fff" strokeWidth="0.8"
                          style={n.status==="alert"?{animation:"pulse 1s infinite"}:{}}/>
                        <g>
                          {/* battery body */}
                          <rect x={n.x+2} y={n.y-4.5} width={3.2} height={2} rx="0.4" fill={bc} opacity="0.9"/>
                          {/* nub on right */}
                          <rect x={n.x+5.2} y={n.y-4} width={0.8} height={1} rx="0.2" fill={bc} opacity="0.9"/>
                        </g>
                        <text x={n.x} y={n.y+7} textAnchor="middle"
                          style={{fontSize:"3.5px",fill:palette.textMuted,fontFamily:"Inter,sans-serif"}}>{n.id}</text>
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
            <div style={{...card(),overflow:"hidden"}}>
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
              <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)"}}>
                {nodes.map((n,i)=>{
                  const m=health.battery[n.id]??{pct:85,next_service:"N/A"};
                  const bc=m.pct<60?palette.danger:m.pct<75?palette.warning:palette.success;
                  return(
                    <div key={n.id} style={{padding:"8px 10px",borderRight:i<5?`1px solid ${palette.border}`:"none"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                        <span style={{fontWeight:700,fontSize:10,color:palette.info}}>{n.id}</span>
                        {m.pct<60&&<span style={{fontSize:9,color:palette.danger,fontWeight:600}}>LOW</span>}
                      </div>
                      <div style={{height:3,background:palette.grayLight,borderRadius:2,marginBottom:3}}>
                        <div style={{height:"100%",width:`${m.pct}%`,background:bc,borderRadius:2}}/>
                      </div>
                      <div style={{fontSize:9,color:bc,fontWeight:600}}>{m.pct}%</div>
                      <div style={{fontSize:9,color:palette.textMuted,marginTop:2}}>Next: {m.next_service}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ══ TAB 3 — ANALYTICS ══ */}
        {tab==="analytics"&&(
          <div style={{flex:1,display:"grid",gridTemplateRows:"auto 1fr auto",gap:10,minHeight:0,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,flexShrink:0}}>
              <MetricCard label="Total Footfall" value={nodes.reduce((s,n)=>s+n.crowd,0)} unit="pax" color={palette.info} icon="👣" sub="live across all nodes"/>
              <MetricCard label="Peak Node"      value={nodes.reduce((a,n)=>n.crowd>a.crowd?n:a,nodes[0])?.id??"—"} unit="" color={palette.warning} icon="📍" sub="highest occupancy"/>
              <MetricCard label="Avg Occupancy"  value={Math.round(nodes.reduce((s,n)=>s+n.crowd,0)/Math.max(nodes.length,1))} unit="pax" color={palette.success} icon="📊" sub="system average"/>
              <MetricCard label="Active Alerts"  value={nodes.filter(n=>n.status==="alert").length} unit="" color={nodes.some(n=>n.status==="alert")?palette.danger:palette.success} icon="🔥" sub="thermal anomalies"/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1.5fr 1fr",gap:10,minHeight:0}}>
              <div style={{...card(),padding:"12px 14px",overflow:"hidden"}}>
                <div style={{fontSize:10,fontWeight:600,color:palette.textMuted,marginBottom:10}}>
                  LIVE OCCUPANCY — ALL NODES
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {nodes.map(n=>{
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
                            <span style={{fontWeight:400,color:palette.textMuted,marginLeft:6}}>{n.zone}</span>
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
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
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
                  {label:"High Traffic",  color:palette.danger,  nodes:nodes.filter(n=>n.crowd>60), sub:"above 60 pax — DOOH / kiosk"},
                  {label:"HVAC Reduce",   color:palette.success, nodes:nodes.filter(n=>n.crowd<10), sub:"below 10 pax — unoccupied"},
                  {label:"HVAC Increase", color:palette.warning, nodes:nodes.filter(n=>n.crowd>70), sub:"above 70 pax — peak load"},
                ].map(({label,color,nodes:zn,sub})=>(
                  <div key={label} style={{background:palette.bgCard2,borderRadius:6,
                    padding:"5px 8px",borderLeft:`2px solid ${color}`}}>
                    <div style={{fontSize:9,fontWeight:600,color:palette.text}}>{label}</div>
                    <div style={{fontSize:10,fontWeight:700,color}}>{zn.length>0?zn.map(n=>n.id).join(", "):"None"}</div>
                    <div style={{fontSize:8,color:palette.textMuted,marginTop:1}}>{sub}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
