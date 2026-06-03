# =============================================================================
# LUMINA SMART EVACUATION SYSTEM
# test_integration.py — Pre-Demo Integration Test
#
# Run BEFORE every demo:  python test_integration.py
#
# What it checks:
#   1. Flask backend is running and healthy
#   2. YOLO model loaded, camera open
#   3. Normal state — correct defaults
#   4. TRIGGER fires hazard, DYN-A* reroutes away from fire node
#   5. Route avoids N-042 after thermal hazard
#   6. RESET restores NORMAL state
#   7. /api/block_node quarantines a node and returns a new route
#   8. /download_log responds with CSV data
#   9. MQTT topic is reachable (broker connectivity)
#  10. All 6 nodes present in /api/status response
#
# If everything passes: system is demo-ready.
# If anything fails:    fix it before the judges arrive.
# =============================================================================

import sys
import time
import json
import socket

# ─── CONFIG ──────────────────────────────────────────────────────────────────
BASE     = "http://127.0.0.1:5001"
TIMEOUT  = 4   # seconds per request

# ─── TERMINAL COLOURS ────────────────────────────────────────────────────────
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
RESET  = "\033[0m"

passed = 0
failed = 0
warnings = 0

def ok(label, detail=""):
    global passed
    passed += 1
    print(f"  {GREEN}✓{RESET}  {label}" + (f"  {DIM}{detail}{RESET}" if detail else ""))

def fail(label, detail=""):
    global failed
    failed += 1
    print(f"  {RED}✗{RESET}  {BOLD}{label}{RESET}" + (f"  {RED}{detail}{RESET}" if detail else ""))

def warn(label, detail=""):
    global warnings
    warnings += 1
    print(f"  {YELLOW}⚠{RESET}  {label}" + (f"  {DIM}{detail}{RESET}" if detail else ""))

def section(title):
    print(f"\n{CYAN}{BOLD}  {title}{RESET}")
    print(f"  {'─' * 55}")


# ─── HTTP HELPER ─────────────────────────────────────────────────────────────
def get(path, label=None):
    try:
        import urllib.request
        req = urllib.request.Request(f"{BASE}{path}")
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read().decode()
            return json.loads(body) if body.strip().startswith("{") or body.strip().startswith("[") else body
    except Exception as e:
        if label:
            fail(label, str(e))
        return None

def post(path, data, label=None):
    try:
        import urllib.request
        payload = json.dumps(data).encode()
        req = urllib.request.Request(
            f"{BASE}{path}", data=payload,
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read().decode()
            return json.loads(body) if body.strip().startswith("{") else body
    except Exception as e:
        if label:
            fail(label, str(e))
        return None


# =============================================================================
# TESTS
# =============================================================================
def run_tests():
    print(f"""
{BOLD}{CYAN}
  ██╗     ██╗   ██╗███╗   ███╗██╗███╗   ██╗ █████╗
  ██╗     ██║   ██║████╗ ████║██║████╗  ██║██╔══██╗
  ██║     ██║   ██║██╔████╔██║██║██╔██╗ ██║███████║
  ██║     ██║   ██║██║╚██╔╝██║██║██║╚██╗██║██╔══██║
  ███████╗╚██████╔╝██║ ╚═╝ ██║██║██║ ╚████║██║  ██║
  ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝
{RESET}
  {BOLD}Pre-Demo Integration Test{RESET}
  {DIM}Run this before every presentation. All tests must pass.{RESET}
""")

    # ── TEST 1: Backend health ────────────────────────────────────────────────
    section("1. Backend Health Check")
    health = get("/api/health", "GET /api/health")
    if health is None:
        fail("Flask backend not reachable — is lumina_live_stream.py running?")
        print(f"\n  {RED}FATAL: Backend offline. Start Flask first, then re-run this test.{RESET}\n")
        print(f"  {DIM}Command: python lumina_live_stream.py{RESET}\n")
        sys.exit(1)

    ok("Flask backend reachable")

    if health.get("yolo_loaded"):
        ok("YOLO model loaded", f"ai_mode={health.get('ai_mode','?')}")
    else:
        fail("YOLO model NOT loaded", "Check model file path in lumina_live_stream.py")

    if health.get("camera_open"):
        ok("Camera open")
    else:
        warn("Camera not open", "Demo will show offline placeholder — connect camera before pitching")

    if health.get("mqtt_connected"):
        ok("MQTT broker connected")
    else:
        fail("MQTT broker NOT connected", "Check Wi-Fi and broker.hivemq.com reachability")

    uptime = health.get("uptime_s", 0)
    ok(f"System uptime", f"{uptime:.1f}s")

    nodes_online = health.get("nodes_online", 0)
    ok(f"Nodes online", f"{nodes_online}/{health.get('nodes_total',200)}")

    # ── TEST 2: /api/status defaults ─────────────────────────────────────────
    section("2. Normal State Verification")
    status = get("/api/status", "GET /api/status")
    if not status:
        fail("No response from /api/status")
    else:
        ok("/api/status responding")

        state = status.get("system_state", "?")
        if state == "NORMAL":
            ok("system_state is NORMAL")
        else:
            warn(f"system_state is {state}", "Run /reset before testing")

        nodes = status.get("nodes", {})
        if len(nodes) == 6:
            ok("All 6 nodes present in response", ", ".join(nodes.keys()))
        else:
            fail(f"Expected 6 nodes, got {len(nodes)}", str(list(nodes.keys())))

        route = status.get("current_route", [])
        if route:
            ok("current_route present", " → ".join(route))
        else:
            warn("current_route empty", "Route will be blank until DYN-A* runs")

        t_lat = status.get("thermal_latency_ms", 0)
        f_lat = status.get("fft_latency_ms", 0)
        if t_lat > 0 and t_lat < 500:
            ok(f"Thermal latency", f"{t_lat}ms — within 500ms target")
        elif t_lat == 0:
            warn("Thermal latency is 0", "Classifier may not have run yet")
        else:
            fail(f"Thermal latency {t_lat}ms exceeds 500ms target")

        if f_lat > 0 and f_lat < 500:
            ok(f"FFT latency", f"{f_lat}ms — within 500ms target")
        elif f_lat == 0:
            warn("FFT latency is 0", "Classifier may not have run yet")
        else:
            fail(f"FFT latency {f_lat}ms exceeds 500ms target")

    # ── TEST 3: TRIGGER → hazard routing ─────────────────────────────────────
    section("3. Hazard Trigger + DYN-A* Rerouting")
    trigger_resp = get("/trigger", "GET /trigger")
    if not trigger_resp:
        fail("TRIGGER endpoint not responding")
    else:
        ok("TRIGGER endpoint responding")
        time.sleep(0.8)   # let DYN-A* recalculate

        status2 = get("/api/status")
        if status2:
            state2 = status2.get("system_state", "?")
            if state2 == "HAZARD":
                ok("system_state changed to HAZARD")
            else:
                fail(f"system_state is still {state2} after TRIGGER", "Expected HAZARD")

            route2 = status2.get("current_route", [])
            if route2 and "N-042" not in route2:
                ok("DYN-A* route avoids N-042 (fire zone)", " → ".join(route2))
            elif "N-042" in (route2 or []):
                fail("Route still passes through N-042 (fire zone)", " → ".join(route2))
            else:
                warn("No route returned after trigger", "DYN-A* may still be calculating")

            n042 = status2.get("nodes", {}).get("N-042", {})
            if n042.get("status") == "alert":
                ok("N-042 status is 'alert'")
            else:
                fail(f"N-042 status is '{n042.get('status')}' after trigger", "Expected 'alert'")

    # ── TEST 4: Block node ────────────────────────────────────────────────────
    section("4. Manual Node Override (/api/block_node)")

    # First reset to clear hazard state so block gives a different route
    get("/reset")
    time.sleep(0.5)

    block_resp = post("/api/block_node", {"node_id": "N-031"}, "POST /api/block_node")
    if not block_resp:
        fail("/api/block_node not responding")
    else:
        if block_resp.get("status") == "success":
            ok("Node N-031 quarantined successfully")
        else:
            fail(f"block_node returned: {block_resp.get('status')}", str(block_resp))

        new_route = block_resp.get("new_route", [])
        if new_route and "N-031" not in new_route:
            ok("New route avoids N-031", " → ".join(new_route))
        elif "N-031" in (new_route or []):
            fail("New route still includes N-031", " → ".join(new_route))
        else:
            warn("No route returned from block_node")

    # ── TEST 5: RESET ─────────────────────────────────────────────────────────
    section("5. System Reset")
    get("/reset")
    time.sleep(0.5)
    status3 = get("/api/status")
    if status3:
        if status3.get("system_state") == "NORMAL":
            ok("system_state restored to NORMAL after reset")
        else:
            fail(f"system_state is {status3.get('system_state')} after reset")

        all_normal = all(
            v.get("status") == "normal"
            for v in status3.get("nodes", {}).values()
        )
        if all_normal:
            ok("All nodes returned to 'normal' status")
        else:
            non_normal = [k for k,v in status3.get("nodes",{}).items() if v.get("status")!="normal"]
            fail(f"Nodes not reset: {non_normal}")

    # ── TEST 6: Download log ───────────────────────────────────────────────────
    section("6. Export Report (/download_log)")
    log_resp = get("/download_log")
    if log_resp is not None:
        ok("/download_log responding", "CSV export ready")
    else:
        warn("/download_log not responding", "Export Report button will fail — check endpoint")

    # ── TEST 7: MQTT broker reachability ──────────────────────────────────────
    section("7. Network Connectivity")
    try:
        s = socket.create_connection(("broker.hivemq.com", 1883), timeout=3)
        s.close()
        ok("HiveMQ broker reachable", "broker.hivemq.com:1883")
    except Exception as e:
        fail("HiveMQ broker NOT reachable", f"{e} — ESP32 and React MQTT will fail")

    try:
        s = socket.create_connection(("broker.hivemq.com", 8000), timeout=3)
        s.close()
        ok("HiveMQ WebSocket port reachable", "port 8000 — needed for React dashboard")
    except Exception as e:
        fail("HiveMQ WebSocket port NOT reachable", f"{e}")

    # ── TEST 8: Routing engine standalone ────────────────────────────────────
    section("8. Routing Engine Standalone Verification")
    try:
        from routing_engine import (
            calculate_safest_route, run_pull_policy, estimate_rset,
            live_node_status, update_crowd, heuristic, NODE_COORDS
        )

        # Normal path
        for nid in live_node_status:
            live_node_status[nid]["status"] = "normal"
            live_node_status[nid]["hazard"] = None
        path, cost = calculate_safest_route("N-011", "N-089", verbose=False)
        assert path and path[-1] == "N-089", "No path to exit"
        ok("DYN-A* finds path in normal mode", " → ".join(path))

        # Fire path
        live_node_status["N-042"]["status"] = "alert"
        live_node_status["N-042"]["hazard"] = "thermal"
        path2, cost2 = calculate_safest_route("N-011", "N-089", verbose=False)
        assert "N-042" not in path2, "Fire route passes through N-042"
        ok("DYN-A* avoids fire node", " → ".join(path2))

        # Heuristic admissibility
        from routing_engine import FACILITY_GRAPH
        inadmissible = [
            f"{a}→{b}" for a, nbrs in FACILITY_GRAPH.items()
            for b, dist in nbrs.items()
            if heuristic(a, b) > dist
        ]
        if not inadmissible:
            ok("Heuristic is admissible — A* optimality guaranteed")
        else:
            fail("Heuristic inadmissible pairs found", str(inadmissible))

        # RSET
        signals = run_pull_policy(path2)
        rset = estimate_rset(path2)
        assert rset["RSET_s"] < rset["ASET_s"], "RSET exceeds ASET — unsafe"
        ok("RSET < ASET — safe evacuation window", f"RSET={rset['RSET_s']}s ASET={rset['ASET_s']}s")

    except ImportError as e:
        fail("routing_engine.py not importable", str(e))
    except AssertionError as e:
        fail("Routing assertion failed", str(e))
    except Exception as e:
        fail("Routing engine error", str(e))

    # ─── SUMMARY ─────────────────────────────────────────────────────────────
    total = passed + failed + warnings
    print(f"""
  {'═' * 57}
  {BOLD}RESULTS:{RESET}  {GREEN}{passed} passed{RESET}  {YELLOW}{warnings} warnings{RESET}  {RED}{failed} failed{RESET}  / {total} total
  {'═' * 57}""")

    if failed == 0 and warnings == 0:
        print(f"""
  {GREEN}{BOLD}ALL TESTS PASSED — SYSTEM IS DEMO-READY{RESET}

  You may now:
    1. Change FLASK_IP in App.jsx to your Wi-Fi IP
    2. Flash ESP32 with hotspot credentials
    3. Open the dashboard and verify MQTT shows LIVE
""")
    elif failed == 0:
        print(f"""
  {YELLOW}{BOLD}PASSED WITH WARNINGS — Review warnings above before demo{RESET}
  Warnings are non-blocking but may affect demo quality.
""")
    else:
        print(f"""
  {RED}{BOLD}TESTS FAILED — Do NOT demo until all failures are resolved{RESET}
  Fix the {RED}{failed}{RESET} failure(s) above, then re-run this script.
""")
    return failed == 0


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
