import { palette } from '../theme';

export default function NodeMap({ nodes, onSelect, selected }) {
  return (
    <div style={{ position: "relative", background: palette.bgCard2, borderRadius: 12, border: `1px solid ${palette.border}`, overflow: "hidden", aspectRatio: "16/9" }}>
      <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gridTemplateRows: "repeat(3,1fr)", opacity: 0.04 }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} style={{ border: "1px solid #fff" }} />
        ))}
      </div>
      <div style={{ position: "absolute", top: 10, left: 14, fontSize: 10, color: palette.textMuted, letterSpacing: "0.1em", textTransform: "uppercase" }}>Floor Plan — Live Node View</div>
      {nodes.map(node => {
        const colors = { alert: palette.danger, quarantine: palette.warning, warning: "#FAAB1A", normal: palette.success };
        const c = colors[node.status];
        const isSelected = selected?.id === node.id;
        return (
          <div key={node.id} onClick={() => onSelect(node)}
            style={{
              position: "absolute", left: `${node.x}%`, top: `${node.y}%`,
              transform: "translate(-50%,-50%)",
              cursor: "pointer",
            }}>
            <div style={{
              width: isSelected ? 18 : 14, height: isSelected ? 18 : 14,
              borderRadius: "50%", background: c,
              boxShadow: `0 0 ${node.status === "alert" ? "16px 4px" : "8px 2px"} ${c}55`,
              border: `2px solid ${isSelected ? "#fff" : c}`,
              transition: "all 0.2s",
              animation: node.status === "alert" ? "pulse 1.2s infinite" : "none",
            }} />
            <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", whiteSpace: "nowrap", fontSize: 9, color: palette.textMuted, background: "rgba(10,14,26,0.85)", padding: "1px 5px", borderRadius: 3 }}>{node.id}</div>
          </div>
        );
      })}
      <div style={{ position: "absolute", bottom: 10, right: 14, display: "flex", gap: 12, fontSize: 10, color: palette.textMuted }}>
        {[["ALERT", palette.danger], ["QUARANTINE", palette.warning], ["WARNING", "#FAAB1A"], ["ONLINE", palette.success]].map(([l, c]) => (
          <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, display: "inline-block" }} />{l}
          </span>
        ))}
      </div>
    </div>
  );
}