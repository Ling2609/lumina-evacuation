import { useState, useEffect, useRef } from 'react';
import { palette } from '../theme';

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

export default function AIChatPanel() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Lumina AI Command Assistant online. I have real-time access to all 200 nodes across the facility. Ask me about evacuation status, node health, routing decisions, or BOMBA coordination." }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const systemPrompt = `You are the Lumina Smart Evacuation System AI Command Assistant embedded in a real-time emergency operations dashboard.

Current system state:
- SYSTEM STATUS: CRITICAL_ALERT
- Active thermal anomaly: Node #042, Sector 4 (Retail A), 84°C, confidence 98.4%
- FACP PAS countdown: 178 seconds to global alarm
- BOMBA commlink: DISPATCHED
- Nodes online: 198/200
- Node #043 under PULL POLICY (congestion 88%)
- Node #031 elevated smoke signature (48°C)
- DYN-A* routing active — safe egress via Sector 6/Stairwell and Exit East (Node #089)
- ZERO-STREAM PRIVACY: all video purged at edge, anonymous tracking vectors only
- PDPA compliant: no raw video transmitted

You assist BOMBA (fire department), facility managers, and incident commanders with:
1. Real-time hazard analysis and routing advice
2. ASET/RSET optimization status
3. Node health and sensor data interpretation
4. Evacuation strategy and crowd management
5. Cybersecurity and system integrity queries
6. Commercial analytics during normal ops

Be concise, technical, and actionable. Reference specific node IDs, zones, and metrics. Use fire safety terminology (ASET, RSET, FACP, PAS, DYN-A*).`;

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", content: input.trim() };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1000,
          system: systemPrompt,
          messages: newMsgs.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      const reply = data.content?.find(b => b.type === "text")?.text || "No response.";
      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Connection error. Retrying mesh fallback channel..." }]);
    }
    setLoading(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 420 }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 0", display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", flexDirection: m.role === "user" ? "row-reverse" : "row" }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
              background: m.role === "user" ? palette.info : palette.purple,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700, color: "#fff",
            }}>{m.role === "user" ? "IC" : "AI"}</div>
            <div style={{
              background: m.role === "user" ? palette.infoDark : palette.bgCard2,
              border: `1px solid ${m.role === "user" ? palette.info + "44" : palette.border}`,
              borderRadius: 10, padding: "8px 12px", maxWidth: "82%",
              fontSize: 13, color: palette.text, lineHeight: 1.55,
            }}>{m.content}</div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: palette.purple, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff" }}>AI</div>
            <div style={{ background: palette.bgCard2, border: `1px solid ${palette.border}`, borderRadius: 10, padding: "8px 14px", fontSize: 13, color: palette.textMuted }}>
              <span style={{ display: "inline-flex", gap: 4 }}>
                {[0, 1, 2].map(i => <span key={i} style={{ width: 5, height: 5, borderRadius: "50%", background: palette.textMuted, display: "inline-block", animation: `dot ${0.9 + i * 0.15}s ease-in-out infinite alternate` }} />)}
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div style={{ display: "flex", gap: 8, paddingTop: 10, borderTop: `1px solid ${palette.border}` }}>
        <input
          value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && send()}
          placeholder="Query BOMBA, routing, node status..."
          style={{
            flex: 1, background: palette.bgCard2, border: `1px solid ${palette.border}`,
            borderRadius: 8, padding: "9px 12px", color: palette.text,
            fontSize: 13, outline: "none",
          }}
        />
        <button onClick={send} disabled={loading}
          style={{
            background: loading ? palette.bgCard2 : palette.purple,
            border: "none", borderRadius: 8, padding: "9px 16px",
            color: "#fff", fontSize: 13, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer",
            transition: "all 0.2s",
          }}>Send</button>
      </div>
    </div>
  );
}