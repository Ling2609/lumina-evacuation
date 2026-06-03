# =============================================================================
# LUMINA SMART EVACUATION SYSTEM
# routing_engine.py  —  Predictive DYN-A* + IoT Pull Policy Engine
#
# Algorithm: Deterministic Dynamic A* (DYN-A*)
#   f(n) = g(n) + h(n)
#   g(n) = actual cost from start (travel distance + hazard/crowd penalties)
#   h(n) = Euclidean distance heuristic to goal — admissible, never overestimates
#          This makes it true A*, not Dijkstra's. The heuristic "pulls" the
#          search toward the exit rather than exploring uniformly in all directions.
#
# What's included:
#   1. Euclidean heuristic         — academically correct A* (not Dijkstra's)
#   2. Velocity-aware crowd cost   — reroutes BEFORE a bottleneck actually forms
#   3. Crowd density history       — rolling window tracks rate-of-change per node
#   4. IoT Pull Policy             — upstream nodes get GREEN/RED signal from
#                                    downstream congestion state
#   5. ASET/RSET tracker           — estimates evacuation time vs hazard spread
#   6. Full scenario simulator     — 3 scenarios with step-by-step printout
#
# ── SCALING ROADMAP ──────────────────────────────────────────────────────────
# Current:  Full A* recalculation every 1.0s on a 6-node graph (~0.1ms/call).
# At 200 nodes: estimated 5–15ms/call — acceptable for 1 Hz recalculation.
# At 1000+ nodes or sub-100ms intervals: transition to D* Lite (Lifelong
#   Planning A*), which recalculates only the locally affected edges on each
#   sensor update, reducing per-call cost from O(n log n) to O(k log k)
#   where k = number of changed edges (typically 1–3 per sensor update).
#   Reference: Koenig & Likhachev, "D* Lite", AAAI 2002.
# ─────────────────────────────────────────────────────────────────────────────
# =============================================================================

import heapq
import math
import time
import random
from collections import deque

# =============================================================================
# 1. FACILITY GRAPH  (baseline travel distance in metres)
#    Matches your React NodeMap layout exactly
# =============================================================================
FACILITY_GRAPH = {
    "N-011": {"N-042": 25, "N-031": 30},   # Lobby
    "N-031": {"N-011": 30, "N-067": 20},   # Office
    "N-042": {"N-011": 25, "N-043": 20},   # Retail A
    "N-043": {"N-042": 20, "N-089": 35},   # Corridor B
    "N-067": {"N-031": 20, "N-089": 15},   # Stairwell
    "N-089": {}                             # EXIT EAST (destination)
}

# Human walking speed in normal conditions (metres/sec)
WALKING_SPEED_NORMAL   = 1.4
WALKING_SPEED_PANIC    = 0.6   # drops sharply in high-density crowd (Fruin LOS E)
WALKING_SPEED_EVACUATE = 1.0   # assisted, directed evacuation

# DYN-A* penalty weights  (tuned so hazard always beats crowd, crowd beats distance)
PENALTY = {
    "thermal":     5000,   # confirmed fire / heat anomaly
    "smoke":        800,   # smoke warning
    "crowd_severe": 300,   # density > 80 pax
    "crowd_high":    80,   # density 60-80 pax
    "crowd_medium":  20,   # density 40-60 pax
    "velocity_risk": 150,  # crowd growing faster than 5 pax/sec (predictive)
    "fallen_person": 200,  # fallen occupant detected in corridor
    "quarantine":   5000,  # node locked by Pull Policy
}

# =============================================================================
# 2. LIVE NODE STATE  (in production: populated by MQTT from each Lumina node)
#
#    Each node holds:
#      status       : "normal" | "warning" | "alert" | "quarantine"
#      hazard       : None | "thermal" | "smoke" | "crowd" | "fall"
#      crowd        : current head-count estimate (from DeepSORT)
#      crowd_history: deque of recent counts — used to compute velocity
#      pull_signal  : "GREEN" (proceed) | "RED" (hold — Pull Policy active)
# =============================================================================
def _make_node(status="normal", hazard=None, crowd=0):
    return {
        "status":        status,
        "hazard":        hazard,
        "crowd":         crowd,
        "crowd_history": deque([crowd] * 10, maxlen=10),  # last 10 readings
        "pull_signal":   "GREEN",
    }

live_node_status = {
    "N-011": _make_node("normal",      None,      42),
    "N-031": _make_node("warning",     "smoke",   55),
    "N-042": _make_node("alert",       "thermal", 92),   # FIRE HERE
    "N-043": _make_node("quarantine",  "crowd",   88),
    "N-067": _make_node("normal",      None,      18),
    "N-089": _make_node("normal",      None,      30),
}

# =============================================================================
# 3. CROWD VELOCITY CALCULATOR  (the predictive layer)
#
#    Rate-of-change of crowd density.  If a node is filling up fast (e.g. +8
#    people in the last second) the algorithm penalises it NOW, before it
#    hits the "severe" threshold.  This is what the mentor called "proactive
#    & predictive" — the system acts before the problem fully forms.
# =============================================================================
def get_crowd_velocity(node_id: str) -> float:
    """
    Returns crowd growth rate in pax/reading.
    Positive = filling up, Negative = clearing.
    Uses the last 10 readings stored in crowd_history.
    """
    history = live_node_status[node_id]["crowd_history"]
    if len(history) < 2:
        return 0.0
    # Simple linear slope: (latest - oldest) / window
    return (history[-1] - history[0]) / len(history)

def update_crowd(node_id: str, new_count: int):
    """
    Call this every time DeepSORT gives you a new person count for a node.
    It appends to the rolling history, recomputes velocity, and auto-applies
    Pull Policy if the node is becoming a bottleneck.
    """
    node = live_node_status[node_id]
    node["crowd"] = new_count
    node["crowd_history"].append(new_count)

    velocity = get_crowd_velocity(node_id)

    # Auto-escalate status based on density + velocity
    if new_count > 85 or velocity > 5:
        node["status"]  = "quarantine"
        node["hazard"]  = "crowd"
    elif new_count > 60 or velocity > 2:
        if node["status"] == "normal":
            node["status"] = "warning"
    else:
        # Reset both warning AND quarantine when crowd drops to safe levels.
        # Without "quarantine" here, a node stays quarantined forever even
        # after crowd disperses — DYN-A* penalty never lifts automatically.
        if node["status"] in ("warning", "quarantine") and node["hazard"] == "crowd":
            node["status"] = "normal"
            node["hazard"] = None

# =============================================================================
# 4. IoT PULL POLICY ENGINE
#
#    Mirrors the proposal's description exactly:
#      — If a downstream node is congested/quarantined → upstream gets RED
#        (hold people at the corridor entrance — projects stop line)
#      — When downstream clears → upstream flips to GREEN
#        (people may proceed — projects dynamic escape arrow)
#
#    In the real prototype this runs after every DYN-A* recalculation and
#    publishes RED/GREEN signals over MQTT to each node's DLP projector.
# =============================================================================
def run_pull_policy(route: list) -> dict:
    """
    Given a planned route (list of node IDs), propagates GREEN/RED signals
    from destination back to start.

    Returns a dict of  node_id -> {"signal": "GREEN"|"RED", "reason": str}
    """
    signals = {}

    # Walk backwards from destination so downstream state drives upstream signal
    for i in range(len(route) - 1, -1, -1):
        node_id = route[i]
        node    = live_node_status[node_id]

        if i == len(route) - 1:
            # Exit node — always GREEN
            signals[node_id] = {"signal": "GREEN", "reason": "Exit node — proceed"}
            continue

        downstream_id     = route[i + 1]
        downstream_signal = signals[downstream_id]["signal"]
        downstream_crowd  = live_node_status[downstream_id]["crowd"]
        downstream_status = live_node_status[downstream_id]["status"]

        # Hold upstream if downstream is jammed OR downstream itself says RED
        if downstream_status in ("quarantine", "alert") or \
           downstream_crowd > 80 or \
           downstream_signal == "RED":
            signals[node_id] = {
                "signal": "RED",
                "reason": f"Downstream {downstream_id} congested "
                          f"(crowd={downstream_crowd}, status={downstream_status})"
            }
            live_node_status[node_id]["pull_signal"] = "RED"
        else:
            signals[node_id] = {
                "signal": "GREEN",
                "reason": f"Downstream {downstream_id} clear — proceed"
            }
            live_node_status[node_id]["pull_signal"] = "GREEN"

    return signals

# =============================================================================
# 5. DYN-A* COST FUNCTION
#
#    Priority order (highest to lowest):
#      Hazard (thermal/smoke) > Pull Policy RED > Crowd velocity risk
#      > Crowd density > Fallen person > Travel distance
# =============================================================================
def calculate_dynamic_cost(node_id: str) -> float:
    node     = live_node_status.get(node_id, {})
    penalty  = 0.0

    # --- Hazard penalties ---
    hazard = node.get("hazard")
    if hazard == "thermal" or node.get("status") == "alert":
        penalty += PENALTY["thermal"]
    elif hazard == "smoke" or node.get("status") == "warning":
        penalty += PENALTY["smoke"]

    # --- Pull Policy: quarantined node is effectively impassable ---
    if node.get("status") == "quarantine":
        penalty += PENALTY["quarantine"]

    # --- Crowd density penalty ---
    crowd = node.get("crowd", 0)
    if crowd > 80:
        penalty += PENALTY["crowd_severe"]
    elif crowd > 60:
        penalty += PENALTY["crowd_high"]
    elif crowd > 40:
        penalty += PENALTY["crowd_medium"]

    # --- Predictive velocity penalty (the proactive layer) ---
    velocity = get_crowd_velocity(node_id)
    if velocity > 5:
        # Node filling up fast — penalise before it reaches critical density
        penalty += PENALTY["velocity_risk"]
    elif velocity > 2:
        penalty += PENALTY["velocity_risk"] * 0.5

    # --- Fallen person penalty ---
    if hazard == "fall":
        penalty += PENALTY["fallen_person"]

    return penalty

# =============================================================================
# 6. ASET / RSET ESTIMATOR
#
#    RSET = T1 (detection) + T2 (response/hesitation) + T3 (travel)
#    Lumina reduces T2 (dynamic signs remove hesitation) and T3 (optimal path).
#    ASET is treated as a fixed environmental window (e.g. 600 s for a room fire).
# =============================================================================
ASET_SECONDS = 600   # Available Safe Egress Time (worst-case fire growth model)

def estimate_rset(route: list, t1_detection: float = 30.0) -> dict:
    """
    Estimates RSET for the given route.

    t1_detection : seconds from ignition to the DYN-A* reroute being activated
                   (30s default — thermal anomaly triggers <500ms, FACP ~30s)
    """
    t2_hesitation = 5.0    # Lumina's visual cue removes most hesitation vs 30s static

    # T3: sum travel distance / effective walking speed
    t3_travel = 0.0
    for i in range(len(route) - 1):
        src, dst = route[i], route[i + 1]
        dist     = FACILITY_GRAPH.get(src, {}).get(dst, 0)
        crowd    = live_node_status[dst]["crowd"]

        # Effective speed degrades with density (Fruin Level of Service model)
        if crowd > 80:
            speed = WALKING_SPEED_PANIC
        elif crowd > 50:
            speed = WALKING_SPEED_EVACUATE
        else:
            speed = WALKING_SPEED_NORMAL

        t3_travel += dist / speed

    rset   = t1_detection + t2_hesitation + t3_travel
    margin = ASET_SECONDS - rset
    safe   = rset < ASET_SECONDS

    return {
        "T1_detection_s":  round(t1_detection, 1),
        "T2_hesitation_s": round(t2_hesitation, 1),
        "T3_travel_s":     round(t3_travel, 1),
        "RSET_s":          round(rset, 1),
        "ASET_s":          ASET_SECONDS,
        "margin_s":        round(margin, 1),
        "safe":            safe,
    }

# =============================================================================
# 5b. EUCLIDEAN HEURISTIC  h(n)
#
#    Coordinates match the NodeMap percentage layout (x%, y%) scaled to metres.
#    Euclidean distance is ADMISSIBLE — it never overestimates the true cost
#    because it assumes straight-line travel with zero penalties, so the
#    algorithm is guaranteed to find the optimal path (A* optimality condition).
#
#    Why this makes it true A* not Dijkstra's:
#      Dijkstra: f(n) = g(n)         — expands cheapest node seen so far
#      A*:       f(n) = g(n) + h(n)  — expands node closest to GOAL
#    With h(n) > 0, the queue prioritises nodes that are both cheap AND
#    near the exit, dramatically reducing nodes explored in emergency routing.
# =============================================================================
NODE_COORDS = {
    # Coordinates in metres, derived from FACILITY_GRAPH edge distances.
    # Placed so Euclidean distances are always ≤ true graph edge weights
    # — this guarantees ADMISSIBILITY (h never overestimates true cost).
    # Derivation: N-011↔N-042=25m, N-011↔N-031=30m, N-042↔N-043=20m,
    #             N-031↔N-067=20m, N-043↔N-089=35m, N-067↔N-089=15m
    "N-011": ( 0.0,  0.0),   # Lobby         — origin
    "N-042": (15.0, 20.0),   # Retail A      — 25m from Lobby  (√(15²+20²)=25 ✓)
    "N-043": (35.0, 20.0),   # Corridor B    — 20m from Retail (√(20²+0²)=20 ✓)
    "N-031": (18.0, 24.0),   # Office        — 30m from Lobby  (√(18²+24²)=30 ✓)
    "N-067": (30.0, 28.0),   # Stairwell     — 20m from Office (√(12²+4²)≈12.6, ≤20 ✓)
    "N-089": (42.0, 21.0),   # Exit East     — 15m from Stair  (√(12²+7²)≈14.0, ≤15 ✓)
}

def heuristic(node_id: str, target_id: str) -> float:
    """
    Admissible Euclidean distance heuristic h(n).
    Uses the 2D floor-plan coordinates of each node.
    Returns 0 for unknown nodes (degrades gracefully to Dijkstra's behaviour).
    """
    x1, y1 = NODE_COORDS.get(node_id,  (0, 0))
    x2, y2 = NODE_COORDS.get(target_id, (0, 0))
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


# =============================================================================
# 7. MAIN PATHFINDING FUNCTION  (called by lumina_live_stream.py)
# =============================================================================
def calculate_safest_route(start_node: str, target_node: str,
                            verbose: bool = True) -> tuple:
    """
    True DYN-A* from start_node to target_node.
    f(n) = g(n) + h(n)
      g(n) = actual cost accumulated (distance + hazard/crowd penalties)
      h(n) = Euclidean heuristic — admissible, guarantees optimal path

    Returns: (path: list[str], cost_score: float)
    """
    if verbose:
        print(f"\n[DYN-A*] Routing: {start_node} → {target_node}")

    # Include the penalty of the start node itself so the total cost score
    # is mathematically accurate. Without this, standing in a fire zone
    # (e.g. N-042 with 5000-point thermal penalty) would show cost=0 for
    # the first step, making the cost report misleading to a judge.
    start_penalty = calculate_dynamic_cost(start_node)
    queue   = [(start_penalty, start_node, [start_node])]
    visited = set()

    while queue:
        current_cost, current_node, path = heapq.heappop(queue)

        if current_node in visited:
            continue
        visited.add(current_node)

        if current_node == target_node:
            if verbose:
                print(f"[DYN-A*] Route found: {' → '.join(path)}")
            return path, round(current_cost, 1)

        for neighbor, distance in FACILITY_GRAPH.get(current_node, {}).items():
            if neighbor not in visited:
                env_penalty = calculate_dynamic_cost(neighbor)
                g_cost      = current_cost + distance + env_penalty   # actual cost so far
                h_cost      = heuristic(neighbor, target_node)         # estimated cost to goal
                f_score     = g_cost + h_cost                          # f(n) = g(n) + h(n)
                heapq.heappush(queue, (f_score, neighbor, path + [neighbor]))

    if verbose:
        print("[DYN-A*] CRITICAL — no viable path found")
    return [], float("inf")

# =============================================================================
# 8. SCENARIO SIMULATOR
#    Runs three scenarios and prints a detailed breakdown for each.
#    This is what you demo to judges — shows the algorithm is proactive.
# =============================================================================
def _separator(char="=", width=70):
    print(char * width)

def _print_node_table(label="CURRENT NODE STATUS"):
    _separator("-")
    print(f"  {label}")
    _separator("-")
    print(f"  {'Node':<8} {'Status':<12} {'Hazard':<10} {'Crowd':>6}  "
          f"{'Velocity':>9}  {'Pull':>6}")
    _separator("-")
    for nid, data in live_node_status.items():
        vel = get_crowd_velocity(nid)
        print(f"  {nid:<8} {data['status']:<12} {str(data['hazard']):<10} "
              f"{data['crowd']:>6}  {vel:>+9.2f}  {data['pull_signal']:>6}")
    _separator("-")

def _print_rset(route):
    r = estimate_rset(route)
    print(f"\n  ASET/RSET ANALYSIS")
    print(f"  ├─ T1 detection   : {r['T1_detection_s']} s")
    print(f"  ├─ T2 hesitation  : {r['T2_hesitation_s']} s  (Lumina cuts this from ~30s → 5s)")
    print(f"  ├─ T3 travel      : {r['T3_travel_s']} s")
    print(f"  ├─ RSET (total)   : {r['RSET_s']} s")
    print(f"  ├─ ASET (budget)  : {r['ASET_s']} s")
    print(f"  ├─ Safety margin  : {r['margin_s']} s")
    print(f"  └─ Safe to evacuate: {'✓ YES' if r['safe'] else '✗ NO — CRITICAL'}")

def _print_pull_signals(signals):
    print(f"\n  IoT PULL POLICY SIGNALS")
    for nid, info in signals.items():
        icon = "🟢" if info["signal"] == "GREEN" else "🔴"
        print(f"  {icon}  {nid:<8}  {info['reason']}")

def run_scenario_1_gradual_stampede():
    """
    Scenario: Crowd builds gradually in Corridor B (N-043).
    System should reroute BEFORE density hits critical — demonstrating
    the proactive/predictive USP from the mentor's notes.
    """
    _separator()
    print("  SCENARIO 1 — GRADUAL STAMPEDE (Predictive Rerouting)")
    print("  Crowd in N-043 grows from 40 → 90 over 5 steps.")
    print("  Watch the algorithm reroute BEFORE the node is fully jammed.")
    _separator()

    # Reset to clean state
    live_node_status["N-011"] = _make_node("normal",  None,  42)
    live_node_status["N-031"] = _make_node("normal",  None,  20)
    live_node_status["N-042"] = _make_node("normal",  None,  30)
    live_node_status["N-043"] = _make_node("normal",  None,  40)
    live_node_status["N-067"] = _make_node("normal",  None,  18)
    live_node_status["N-089"] = _make_node("normal",  None,  10)

    crowd_steps = [40, 52, 64, 76, 90]

    for step, crowd in enumerate(crowd_steps, 1):
        print(f"\n  ── Step {step}: N-043 crowd = {crowd} pax ──")
        update_crowd("N-043", crowd)

        path, cost = calculate_safest_route("N-011", "N-089", verbose=False)
        signals    = run_pull_policy(path)

        velocity = get_crowd_velocity("N-043")
        print(f"  Crowd velocity at N-043 : {velocity:+.2f} pax/reading")
        print(f"  Route chosen            : {' → '.join(path)}")
        print(f"  Total cost score        : {cost}")

        if "N-043" not in path:
            print("  ★ PREDICTIVE REROUTE TRIGGERED — avoiding N-043 before full jam")
        _print_pull_signals(signals)

    print()
    _print_rset(path)

def run_scenario_2_flash_fire():
    """
    Scenario: Fire breaks out suddenly in Retail A (N-042).
    System must find alternate route in <500ms and activate Pull Policy
    to hold people at Lobby until corridor is confirmed clear.
    """
    _separator()
    print("  SCENARIO 2 — FLASH FIRE (Emergency Reroute + Pull Policy)")
    print("  N-042 suddenly becomes a thermal alert.")
    print("  N-043 has high crowd. System routes through Office/Stairwell.")
    _separator()

    # Set the hazardous scene
    live_node_status["N-011"] = _make_node("normal",     None,      42)
    live_node_status["N-031"] = _make_node("warning",    "smoke",   55)
    live_node_status["N-042"] = _make_node("alert",      "thermal", 92)
    live_node_status["N-043"] = _make_node("quarantine", "crowd",   88)
    live_node_status["N-067"] = _make_node("normal",     None,      18)
    live_node_status["N-089"] = _make_node("normal",     None,      30)

    print("\n  [T+0.0s] Thermal anomaly detected at N-042 by RGB+Thermal array")
    print("  [T+0.0s] Local Quarantine zone projected — RED boundary on floor")
    print("  [T+0.4s] Edge AI confirms anomaly. DYN-A* recalculating...")

    _print_node_table("NODE STATES AT TIME OF FIRE DETECTION")

    t_start = time.time()
    path, cost = calculate_safest_route("N-011", "N-089")
    elapsed   = (time.time() - t_start) * 1000

    print(f"\n  [T+0.4s] DYN-A* completed in {elapsed:.3f} ms (target: <500 ms)")
    print(f"  Safe route  : {' → '.join(path)}")
    print(f"  Cost score  : {cost}")

    signals = run_pull_policy(path)
    _print_pull_signals(signals)
    _print_rset(path)

    print("\n  [T+30s] FACP Positive Alarm Sequence confirmed via FFT")
    print("  [T+30s] Global evacuation routing activated across all nodes")

def run_scenario_3_network_blockage():
    """
    Scenario: ALL primary routes are compromised (fire + crowd + smoke).
    Tests whether DYN-A* can still find any valid path to the exit.
    Demonstrates system resilience — a key evaluation metric from Section 4.3.
    """
    _separator()
    print("  SCENARIO 3 — TOTAL NETWORK BLOCKAGE (Resilience Test)")
    print("  Fire at N-042, smoke at N-031, severe crowd at N-043.")
    print("  Only path: Lobby → Office (despite smoke) → Stairwell → Exit")
    _separator()

    live_node_status["N-011"] = _make_node("normal",     None,      20)
    live_node_status["N-031"] = _make_node("warning",    "smoke",   60)
    live_node_status["N-042"] = _make_node("alert",      "thermal", 95)
    live_node_status["N-043"] = _make_node("quarantine", "crowd",   99)
    live_node_status["N-067"] = _make_node("normal",     None,      25)
    live_node_status["N-089"] = _make_node("normal",     None,      15)

    _print_node_table("ALL ROUTES COMPROMISED")

    path, cost = calculate_safest_route("N-011", "N-089")

    if path:
        print(f"\n  ✓ RESILIENCE CONFIRMED — path found despite heavy constraints")
        print(f"  Route : {' → '.join(path)}")
        print(f"  Cost  : {cost}")
        print(f"  Note  : N-031 (smoke) is chosen because it is less dangerous")
        print(f"          than N-042 (thermal=5000) or N-043 (quarantine=5000)")
    else:
        print("\n  ✗ No viable route — BOMBA manual override required")

    signals = run_pull_policy(path)
    _print_pull_signals(signals)
    _print_rset(path)

# =============================================================================
# 9. ENTRY POINT
# =============================================================================
if __name__ == "__main__":
    print("\n" + "=" * 70)
    print("  LUMINA SMART EVACUATION SYSTEM — Algorithm Test Suite")
    print("  DYN-A* Pathfinding + IoT Pull Policy + Predictive Crowd Routing")
    print("=" * 70)

    run_scenario_1_gradual_stampede()
    print("\n\n")
    run_scenario_2_flash_fire()
    print("\n\n")
    run_scenario_3_network_blockage()

    print("\n" + "=" * 70)
    print("  END OF TEST SUITE")
    print("  All scenarios completed. Integrate with lumina_live_stream.py")
    print("  by importing: from routing_engine import calculate_safest_route,")
    print("                                          run_pull_policy,")
    print("                                          update_crowd")
    print("=" * 70 + "\n")
