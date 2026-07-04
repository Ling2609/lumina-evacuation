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
#   5. Route avoids J7 after thermal hazard
#   6. RESET restores NORMAL state
#   7. /api/block_node quarantines J4 and returns a new route
#   8. /download_log responds with CSV data
#   9. MQTT topic is reachable (broker connectivity)
#  10. All routing nodes present in /api/status response
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
        expected_nodes = 36  # 17 junctions + 16 store doors + 3 exits
        j_count  = sum(1 for n in nodes if n.startswith("J"))
        b_count  = sum(1 for n in nodes if n.startswith("B"))
        ex_count = sum(1 for n in nodes if n.startswith("EXIT"))
        if j_count == 17 and b_count == 16 and ex_count == 3:
            ok(f"All {len(nodes)} nodes present (17J + 16B + 3EXIT)", f"{j_count}J {b_count}B {ex_count}EXIT")
        elif len(nodes) > 0:
            warn(f"Node count {len(nodes)} (expected {expected_nodes})", f"J={j_count} B={b_count} EXIT={ex_count}")
        else:
            fail("No nodes in /api/status response", "Backend may not have initialised yet")

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
            if route2 and "J7" not in route2:
                ok("DYN-A* route avoids J7 (fire zone)", " → ".join(route2))
            elif "J7" in (route2 or []):
                fail("Route still passes through J7 (fire zone)", " → ".join(route2))
            else:
                warn("No route returned after trigger", "DYN-A* may still be calculating")

            j7_node = status2.get("nodes", {}).get("J7", {})
            if j7_node.get("status") == "alert":
                ok("J7 status is 'alert'")
            else:
                fail(f"J7 status is '{j7_node.get('status')}' after trigger", "Expected 'alert'")

    # ── TEST 4: Block node ────────────────────────────────────────────────────
    section("4. Manual Node Override (/api/block_node)")

    # First reset to clear hazard state so block gives a different route
    get("/reset")
    time.sleep(0.5)

    # J12 has real redundancy (J11/J13/J14 all connect to it) — use it to verify
    # DYN-A* actually reroutes around a blocked node when an alternate exists.
    block_resp = post("/api/block_node", {"node_id": "J12"}, "POST /api/block_node")
    if not block_resp:
        fail("/api/block_node not responding")
    else:
        if block_resp.get("blocked") == "J12" or block_resp.get("status") == "success":
            ok("Node J12 quarantined successfully")
        elif block_resp.get("new_route"):
            ok("Node J12 quarantined successfully (route returned)")
        else:
            fail(f"block_node unexpected response", str(block_resp))

        new_route = block_resp.get("new_route", [])
        if new_route and "J12" not in new_route:
            ok("New route avoids J12", " → ".join(new_route))
        elif "J12" in (new_route or []):
            fail("New route still includes J12", " → ".join(new_route))
        else:
            warn("No route returned from block_node")

    get("/reset")
    time.sleep(0.5)

    # B9/B10 (Mamadini, Public Recipe) connect ONLY to J4 — no alternate path
    # exists (J16 was removed entirely; no physical hardware node there).
    # Blocking J4 as impassable (the default) should now correctly produce
    # a genuine no_route / shelter-in-place result, NOT a route that still
    # walks through the blocked node — that soft-block behavior was the
    # pre-Area-of-Refuge design, superseded once impassable blocks were added.
    block_resp = post("/api/block_node", {"node_id": "J4", "start": "B9"}, "POST /api/block_node")
    if not block_resp:
        fail("/api/block_node not responding")
    else:
        no_route  = block_resp.get("no_route", False)
        new_route = block_resp.get("new_route", [])
        if no_route and not new_route:
            ok("J4 block (impassable): correctly reports no_route — B9/B10 have no alternate path (Area of Refuge)")
        elif new_route and "J4" in new_route:
            fail("J4 block: route still passes through the blocked node — impassable exclusion not applied", str(new_route))
        elif new_route and "J4" not in new_route:
            warn("J4 block: found a route avoiding J4 — unexpected, check whether B9/B10 gained a new connection", str(new_route))
        else:
            warn("No route and no no_route flag returned from block_node (J4) — response shape may have changed")

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
    # NOT using the get() helper here — it always tries to .decode() the
    # response as UTF-8 text, which throws on binary XLSX content and gets
    # silently swallowed, making a genuinely working endpoint look "not
    # responding." Fetching the raw bytes directly and checking for the ZIP
    # file signature (XLSX is a ZIP archive — "PK" magic bytes) confirms a
    # real, valid workbook without needing openpyxl installed just to test.
    try:
        import urllib.request
        req = urllib.request.Request(f"{BASE}/download_log")
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read()
            content_type = r.headers.get("Content-Type", "")
        if raw[:2] == b"PK":
            ok("/download_log responding with a valid XLSX file", f"{len(raw)} bytes")
        elif "spreadsheet" in content_type or "excel" in content_type:
            warn("/download_log responded but content doesn't look like a valid XLSX",
                 f"content-type={content_type}, {len(raw)} bytes")
        else:
            warn("/download_log response type unexpected", f"content-type={content_type}")
    except Exception as e:
        warn("/download_log not responding", f"Export Report button will fail — {e}")

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
            live_node_status, update_crowd, heuristic, JUNCTION_COORDS
        )

        # Normal path
        for nid in live_node_status:
            live_node_status[nid]["status"] = "normal"
            live_node_status[nid]["hazard"] = None
        path, cost = calculate_safest_route("J4", verbose=False)
        assert path and path[0] == "J4" and path[-1].startswith("EXIT"), "No path to exit"
        ok("DYN-A* finds path in normal mode", " → ".join(path))

        # Fire path
        live_node_status["J7"]["status"] = "alert"
        live_node_status["J7"]["hazard"] = "thermal"
        path2, cost2 = calculate_safest_route("J4", verbose=False)
        assert "J7" not in path2, "Fire route passes through J7"
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

    # ── TEST 9: Multi-hazard simultaneous tracking ───────────────────────────
    # Covers a real, previously-shipped bug: a global (not per-node) sequence
    # counter meant any concurrent action on ANY node could wrongly discard a
    # different node's genuine trigger response. Symptom was "only ever 2
    # hazards work" — a 3rd trigger would silently vanish while 2 were
    # already active. This test directly reproduces 3 simultaneous hazards
    # and checks all 3 are actually tracked, not just the check that used to
    # pass by accident with only 1-2 active.
    section("9. Multi-Hazard Simultaneous Tracking")
    get("/api/set_system_mode/simulation")
    get("/reset")
    time.sleep(0.3)

    post("/api/sim_trigger", {"event_type": "fire", "node_id": "J7"})
    time.sleep(0.3)
    post("/api/sim_trigger", {"event_type": "fallen", "node_id": "J8"})
    time.sleep(0.3)
    post("/api/sim_trigger", {"event_type": "crowd", "node_id": "J14"})
    time.sleep(0.3)

    hazards = get("/api/active_hazards", "GET /api/active_hazards")
    if hazards:
        tracked = {p["node_id"] for p in hazards.get("per_node_routes", [])}
        if {"J7", "J8", "J14"}.issubset(tracked):
            ok("All 3 simultaneous hazards tracked", f"tracked={sorted(tracked)}")
        else:
            fail("Not all 3 hazards tracked — the 'only 2 hazards work' regression",
                 f"expected J7,J8,J14 — got {sorted(tracked)}")

    # Cancel the middle one, then trigger a fresh 4th — this is the exact
    # "cancel then trigger" sequence that broke earlier this session.
    post("/api/cancel_sim_trigger", {"node_id": "J8"})
    time.sleep(0.3)
    post("/api/sim_trigger", {"event_type": "fallen", "node_id": "J12"})
    time.sleep(0.3)
    hazards2 = get("/api/active_hazards")
    if hazards2:
        tracked2 = {p["node_id"] for p in hazards2.get("per_node_routes", [])}
        if tracked2 == {"J7", "J14", "J12"}:
            ok("Cancel-then-trigger-new correctly updates tracked set", f"tracked={sorted(tracked2)}")
        elif "J8" in tracked2:
            fail("Cancelled hazard J8 still appears in tracking", f"tracked={sorted(tracked2)}")
        elif "J12" not in tracked2:
            fail("Freshly triggered J12 missing — the exact 'trigger after cancel fails' regression",
                 f"tracked={sorted(tracked2)}")
        else:
            warn("Unexpected tracked set after cancel+retrigger", f"tracked={sorted(tracked2)}")

    get("/reset")
    time.sleep(0.3)

    # ── TEST 10: Hazard severity distinction (fallen vs thermal) ────────────
    # Covers a real shipped bug: calculate_dynamic_cost checked
    # `hazard=="thermal" or status=="alert"`, and fallen hazards ALSO set
    # status="alert", so fallen nodes were silently getting the full 5000
    # thermal penalty stacked on top of their own 300 fallen penalty —
    # totally undermining "fire=hard block, fallen=soft penalty."
    section("10. Hazard Severity Distinction (Fallen must not match Thermal)")
    try:
        from routing_engine import live_node_status as _lns, calculate_dynamic_cost, PENALTY
        for nid in _lns:
            _lns[nid]["status"] = "normal"
            _lns[nid]["hazard"] = None

        _lns["J8"]["status"] = "alert"
        _lns["J8"]["hazard"] = "fall"
        fallen_cost = calculate_dynamic_cost("J8")
        if fallen_cost == PENALTY["fallen"]:
            ok(f"Fallen node cost is exactly PENALTY['fallen']", f"cost={fallen_cost}")
        elif fallen_cost >= PENALTY.get("thermal", 5000):
            fail("Fallen node incorrectly carries thermal-level cost",
                 f"cost={fallen_cost} (expected {PENALTY['fallen']}) — status=='alert' bug may have regressed")
        else:
            warn(f"Fallen cost is {fallen_cost}, expected exactly {PENALTY['fallen']}")

        _lns["J8"]["status"] = "normal"
        _lns["J8"]["hazard"] = None
        _lns["J7"]["status"] = "alert"
        _lns["J7"]["hazard"] = "thermal"
        thermal_cost = calculate_dynamic_cost("J7")
        if thermal_cost >= PENALTY.get("thermal", 5000):
            ok("Thermal node still correctly carries full thermal penalty", f"cost={thermal_cost}")
        else:
            fail("Thermal penalty regression — fire node cost too low", f"cost={thermal_cost}")

        _lns["J7"]["status"] = "normal"
        _lns["J7"]["hazard"] = None
    except Exception as e:
        fail("Hazard severity test error", str(e))

    # ── TEST 11: Crowd hard-block escalation + debounce ──────────────────────
    # Covers the crowd-crush hard-block feature added this session: sustained
    # 80+ pax for 3 consecutive readings should hard-block like fire; a
    # single spike or jitter around the threshold should NOT.
    section("11. Crowd Hard-Block Escalation")
    try:
        from routing_engine import update_crowd, live_node_status as _lns2, CORRIDOR_CAPACITY

        update_crowd("J9", 0)
        _lns2["J9"]["capacity_streak"] = 0
        update_crowd("J9", 85)
        if not _lns2["J9"]["impassable"]:
            ok("Single crowd spike does NOT hard-block (debounce working)")
        else:
            fail("Single spike incorrectly hard-blocked — debounce not working")

        for c in [82, 78, 84]:  # jitter around threshold, never 3 in a row
            update_crowd("J9", c)
        if not _lns2["J9"]["impassable"]:
            ok("Jitter around threshold does NOT hard-block")
        else:
            fail("Threshold jitter incorrectly hard-blocked")

        for c in [82, 85, 88]:  # genuinely sustained
            update_crowd("J9", c)
        if _lns2["J9"]["impassable"]:
            ok("Sustained 3-reading crush correctly hard-blocks", f"streak={_lns2['J9']['capacity_streak']}")
        else:
            fail("Sustained crush did NOT hard-block — escalation broken")

        # Release: must clear both impassable AND the streak counter, or a
        # fresh hazard on the same node could re-trigger almost instantly
        update_crowd("J9", 0)
        if not _lns2["J9"]["impassable"] and _lns2["J9"]["capacity_streak"] == 0:
            ok("Crowd hard-block correctly releases and resets streak")
        else:
            fail("Crowd hard-block did not fully release",
                 f"impassable={_lns2['J9']['impassable']} streak={_lns2['J9']['capacity_streak']}")
    except Exception as e:
        fail("Crowd escalation test error", str(e))

    # ── TEST 12: Reconciliation endpoint sanity ──────────────────────────────
    # /api/active_hazards must return correct data unconditionally, including
    # while manual_override is active — unlike /api/status's per_node_routes
    # field, which the background loop skips updating during manual override.
    section("12. Reconciliation Endpoint (/api/active_hazards)")
    get("/reset")
    time.sleep(0.3)
    get("/api/set_system_mode/simulation")
    post("/api/sim_trigger", {"event_type": "crowd", "node_id": "J15"})
    time.sleep(0.3)
    post("/api/block_node", {"node_id": "J12", "start": "J15"})  # forces manual_override=True
    time.sleep(0.3)
    hazards3 = get("/api/active_hazards", "GET /api/active_hazards (during manual override)")
    if hazards3:
        tracked3 = {p["node_id"] for p in hazards3.get("per_node_routes", [])}
        if "J15" in tracked3:
            ok("active_hazards correctly returns data during manual override", f"tracked={sorted(tracked3)}")
        else:
            fail("active_hazards missing hazard during manual override — mode gating regression",
                 f"tracked={sorted(tracked3)}")

    get("/reset")
    time.sleep(0.3)

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
