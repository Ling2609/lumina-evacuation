import { useEffect, useRef } from "react";
import { palette } from "../theme";

// These percentages match your NodeMap exactly
const nodeCoords = {
  "N-011": { x: 0.15, y: 0.60 }, // Lobby
  "N-042": { x: 0.30, y: 0.35 }, // Retail A (Hazard Zone)
  "N-043": { x: 0.52, y: 0.35 }, // Corridor B
  "N-031": { x: 0.40, y: 0.65 }, // Office (Safe Alternate)
  "N-067": { x: 0.72, y: 0.55 }, // Stairwell
  "N-089": { x: 0.85, y: 0.75 }  // Exit East
};

export default function RoutingCanvas({ 
  personCount = 15, 
  isHazard = false, 
  // Default route until Python sends a new one
  currentRoute = ["N-011", "N-042", "N-043", "N-089"] 
}) {
  const canvasRef = useRef(null);
  const agentsRef = useRef([]);
  const rafRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const resize = () => {
      canvas.width = canvas.parentElement.clientWidth;
      canvas.height = canvas.parentElement.clientHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = () => {
      const { width: W, height: H } = canvas;
      const agents = agentsRef.current;

      // Spawn agents at the first node in the current route
      const startNode = nodeCoords[currentRoute[0]] || {x: 0.15, y: 0.5};

      while (agents.length < personCount) {
        agents.push({
          x: startNode.x + (Math.random() * 0.05 - 0.025),
          y: startNode.y + (Math.random() * 0.05 - 0.025),
          targetIndex: 1, // Move to the second node in the route
          speed: 0.002 + Math.random() * 0.0015
        });
      }
      while (agents.length > personCount) agents.pop();

      // Draw Environment
      ctx.fillStyle = isHazard ? "#120404" : palette.bgCard2;
      ctx.fillRect(0, 0, W, H);
      
      // Draw Nodes and Paths (Visualizing the DYN-A* Graph)
      ctx.strokeStyle = palette.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      // Lobby to Retail to Corridor to Exit
      ctx.moveTo(0.15*W, 0.60*H); ctx.lineTo(0.30*W, 0.35*H); ctx.lineTo(0.52*W, 0.35*H); ctx.lineTo(0.85*W, 0.75*H);
      // Lobby to Office to Stairwell to Exit
      ctx.moveTo(0.15*W, 0.60*H); ctx.lineTo(0.40*W, 0.65*H); ctx.lineTo(0.72*W, 0.55*H); ctx.lineTo(0.85*W, 0.75*H);
      ctx.stroke();

      // Draw Hazard Zone
      if (isHazard) {
        const pulse = 0.5 + Math.sin(Date.now() / 300) * 0.25;
        const hazardNode = nodeCoords["N-042"];
        
        ctx.fillStyle = `rgba(226,75,74,${pulse * 0.3})`;
        ctx.beginPath();
        ctx.arc(hazardNode.x * W, hazardNode.y * H, H * 0.15, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.fillStyle = palette.success;
        ctx.font = `bold ${Math.max(10, W * 0.018)}px monospace`;
        ctx.fillText("<<< DYN-A* REROUTING", W * 0.5, H * 0.2);
      }

      // Draw Exits
      ctx.fillStyle = palette.success;
      ctx.fillRect(W * 0.82, H * 0.70, W * 0.06, H * 0.1);
      ctx.font = `bold 10px monospace`;
      ctx.fillStyle = "#fff";
      ctx.fillText("EXIT", W * 0.85, H * 0.76);

      // Draw and Move Agents along the real Python Route
      ctx.fillStyle = palette.info;
      agents.forEach(a => {
        // If the route updated and they are on an invalid index, reset them
        if (a.targetIndex >= currentRoute.length) {
           a.targetIndex = currentRoute.length - 1;
        }

        const targetNodeId = currentRoute[a.targetIndex];
        const targetCoords = nodeCoords[targetNodeId];

        if (targetCoords) {
            const dx = targetCoords.x - a.x;
            const dy = targetCoords.y - a.y;
            const dist = Math.sqrt(dx*dx + dy*dy);

            // Move towards target
            if (dist > 0.02) {
                a.x += (dx / dist) * a.speed;
                a.y += (dy / dist) * a.speed;
            } else if (a.targetIndex < currentRoute.length - 1) {
                // Reached node, target the next one
                a.targetIndex += 1;
            } else {
                // Reached the exit, respawn at lobby
                a.x = startNode.x + (Math.random() * 0.05 - 0.025);
                a.y = startNode.y + (Math.random() * 0.05 - 0.025);
                a.targetIndex = 1;
            }
        }
        
        ctx.beginPath();
        ctx.arc(a.x * W, a.y * H, 4, 0, Math.PI * 2);
        ctx.fill();
      });

      rafRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(rafRef.current);
    };
  }, [personCount, isHazard, currentRoute]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", borderRadius: "8px" }} />;
}