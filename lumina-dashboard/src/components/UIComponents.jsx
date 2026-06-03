import { palette } from '../theme';

export function MetricCard({ label, value, unit, color, icon, sub }) {
  return (
    <div style={{
      background: palette.bgCard, border: `1px solid ${palette.border}`,
      borderRadius: 12, padding: "16px 18px",
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 11, color: palette.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{label}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: palette.text, lineHeight: 1 }}>
            {value}<span style={{ fontSize: 13, fontWeight: 400, color: palette.textMuted, marginLeft: 4 }}>{unit}</span>
          </div>
          {sub && <div style={{ fontSize: 11, color, marginTop: 4 }}>{sub}</div>}
        </div>
        <div style={{ fontSize: 22, color, opacity: 0.8 }}>{icon}</div>
      </div>
    </div>
  );
}

export function StatusBadge({ status }) {
  const map = {
    alert: { bg: palette.dangerLight, color: palette.dangerDark, label: "ALERT" },
    quarantine: { bg: palette.warningLight, color: palette.warningDark, label: "QUARANTINE" },
    warning: { bg: "#FFF3CD", color: "#856404", label: "WARNING" },
    normal: { bg: palette.successLight, color: palette.successDark, label: "ONLINE" },
  };
  const s = map[status] || map.normal;
  return (
    <span style={{
      background: s.bg, color: s.color,
      fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
      padding: "2px 8px", borderRadius: 4,
    }}>{s.label}</span>
  );
}

export function MiniChart({ data, color, height = 40 }) {
  const max = Math.max(...data, 1);
  const w = 100, h = height;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  const area = `${pts} ${w},${h} 0,${h}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={height} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`g${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#g${color.replace("#", "")})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export function Tab({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? palette.purple : "transparent",
      border: `1px solid ${active ? palette.purple : palette.border}`,
      borderRadius: 7, padding: "6px 16px", color: active ? "#fff" : palette.textMuted,
      fontSize: 12, fontWeight: active ? 600 : 400, cursor: "pointer",
      transition: "all 0.15s",
    }}>{label}</button>
  );
}