# =============================================================================
# LUMINA SMART EVACUATION SYSTEM
# routing_engine.py — Capacity-Constrained DYN-A* + 3-Tier Pull Policy
#
# ARCHITECTURE:
#   - 20 junction nodes (J1-J20) + 5 exit nodes = 25 routing nodes
#   - Store doors (B1-B16) are display-only — NOT routing nodes
#   - Routes follow corridor junctions ONLY (no diagonals, no skipping)
#   - Each edge has a capacity limit (Fruin LOS D = 80 pax)
#   - Hysteresis: route only changes if new path is ≥20% cheaper
#   - 3-Tier escalation: NORMAL → PRE_CRUSH → CRITICAL
#
# FACP INTEGRATION:
#   - Fire in store → FACP signals Lumina → nearest junction marked ALERT
#   - Fire in corridor → thermal sensor on node detects directly
#   - FFT microphone: hardware failsafe, confirms GLOBAL_EVACUATION regardless
#
# NODE PLACEMENT (6 physical Lumina nodes):
#   Node A: J2/J3  → West corridor  (sees B1 Siew Later, B2 BawangTea)
#   Node B: J4/J6  → Central cross  (sees B3 ChillZone, B4 Empty, B5 ThaiRelax)
#   Node C: J8/J9  → East corridor  (sees B6 Female WR, B7 Male WR, B8 AliBarber)
#   Node D: J15 → South-Central  (B9 Mamadini / B10 Public Recipe now connect
#   directly to J4 — no physical J16 hardware node in the real installation)
#   Node E: J18/J19→ South-West    (sees B11 Meating, B12 Baskin, B13 CustSvc)
#   Node F: J12/J13→ East-South    (sees B14 MS.DIY, B15 SofaSoGood, B16 ReadMe)
# =============================================================================

import heapq
import math
import time
from collections import deque

# =============================================================================
# 1. JUNCTION COORDINATES (SVG 760x693, scaled from 1234x1126)
#    sx=760/1234=0.6159, sy=693/1126=0.6158
# =============================================================================
sx, sy = 760/1234, 693/1126

def _s(x, y):
    return (round(x*sx, 1), round(y*sy, 1))

JUNCTION_COORDS = {
    "J1":  _s(195, 539), "J2":  _s(195, 429), "J3":  _s(334, 429),
    "J4":  _s(618, 429),
    "J7":  _s(740, 429), "J8":  _s(945, 429),  "J9":  _s(945, 272),
    "J10": _s(945, 141), "J11": _s(945, 580),  "J12": _s(945, 762),
    "J13": _s(1138,762), "J14": _s(771, 762),  "J15": _s(618, 762),
    "J17": _s(618, 937),  "J18": _s(334, 937),
    "J19": _s(334, 830), "J20": _s(334, 754),
}

EXIT_COORDS = {
    "EXIT-1": _s(25,  539),
    "EXIT-3": _s(945,  20),
    "EXIT-4": _s(1220, 762),
}

# Store door coordinates (display only — NOT routing nodes)
DOOR_COORDS = {
    "B1":  _s(195, 356),  # Siew Later
    "B2":  _s(334, 356),  # BawangTea
    "B3":  _s(618, 356),  # Chill Zone — merged into B4 (Empty Space) unit, same door
    "B4":  _s(618, 356),  # Empty Space
    "B5":  _s(740, 356),  # Thai Relax
    "B6":  _s(1072,141),  # Female Washroom
    "B7":  _s(1072,272),  # Male Washroom
    "B8":  _s(1040,580),  # Ali Barber
    "B9":  _s(644, 610),  # Mamadini
    "B10": _s(529, 610),  # Public Recipe
    "B11": _s(191, 754),  # Meating Room
    "B12": _s(191, 937),  # Baskin Batman
    "B13": _s(442, 830),  # Customer Service
    "B14": _s(771, 815),  # MS. DIY
    "B15": _s(945, 815),  # SofaSoGood
    "B16": _s(1138,815),  # ReadMe Bookstore
}

DOOR_LABELS = {
    "B1":"Office A",
    "B2":"Meeting Room 1",
    "B3":"Meeting Room 2",
    "B4":"Office B",
    "B5":"Manager Room",
    "B6":"Meeting Room 3",
    "B7":"Meeting Room 4",
    "B8":"CEO Room",
    "B9":"COO Room",
    "B10":"CTO Room",
    "B11":"CFO Room",
    "B12":"Meeting Room 5",
    "B13":"Reception",
    "B14":"Office C",
    "B15":"Meeting Room 6",
    "B16":"Office D",
}

# Junction zone names — mirrors data.js's nodeData labels, kept here so the
# backend CSV export can resolve human-readable names without depending on
# the frontend. Without this, download_log() fell back to raw IDs (J1, B1)
# for every row since live_node_status entries carry no "zone" field.
JUNCTION_LABELS = {
    "J1":"West Corridor (Exit 1 approach)","J2":"West Corridor Upper","J3":"Left-Center Junction",
    "J4":"Central Crossroad",
    "J7":"Center-Right Junction","J8":"East Corridor Upper","J9":"East Corridor (Exit 3 branch)",
    "J10":"Exit 3 Junction","J11":"East Corridor Lower","J12":"East-South Junction",
    "J13":"Exit 4 Junction","J14":"Bottom-Right Junction","J15":"South-Center Junction",
    "J17":"Bottom Corridor Right","J18":"South-West Lower Junction",
    "J19":"South-West Junction","J20":"Left Lower Junction",
}

def resolve_node_name(nid: str) -> str:
    """Single source of truth for human-readable node names in reports/CSV."""
    if nid in DOOR_LABELS: return DOOR_LABELS[nid]
    if nid in JUNCTION_LABELS: return JUNCTION_LABELS[nid]
    return nid  # EXIT-1..5 and anything unrecognized fall back to raw id

# Which junction a store door connects to (nearest corridor junction)
DOOR_TO_JUNCTION = {
    "B1": "J2",  "B2": "J3",  "B3": "J4",  "B4": "J4",
    "B5": "J7",  "B6": "J10", "B7": "J9",  "B8": "J11",
    "B9": "J4", "B10":"J4", "B11":"J20", "B12":"J18",
    "B13":"J19", "B14":"J14", "B15":"J12", "B16":"J13",
}

# ── Store event handling ──────────────────────────────────────────────────
# When FACP signals fire in store Bx, or Lumina thermal detects heat in corridor:
# 1. Mark the nearest junction as alert
# 2. Route people OUT from that store's door through the junction chain to exit

def facp_store_alert(door_id: str, hazard_type: str = "thermal"):
    """
    Called when FACP signals hazard in a specific store (Bx).
    Marks the nearest junction as alert so DYN-A* avoids it.
    Returns the affected junction ID.
    """
    junction_id = DOOR_TO_JUNCTION.get(door_id)
    if not junction_id:
        return None
    live_node_status[junction_id]["status"] = "alert"
    live_node_status[junction_id]["hazard"] = hazard_type
    # Thermal (fire) hard-blocks, consistent with the thermal sensor thread
    # and sim-triggered fire — a real fire genuinely can't be walked through.
    # Fall stays soft (people can step around someone on the ground).
    live_node_status[junction_id]["impassable"] = (hazard_type == "thermal")
    return junction_id

def facp_store_clear(door_id: str):
    """Clear alert for a store's nearest junction."""
    junction_id = DOOR_TO_JUNCTION.get(door_id)
    if not junction_id:
        return None
    live_node_status[junction_id]["status"] = "normal"
    live_node_status[junction_id]["hazard"] = None
    live_node_status[junction_id]["impassable"] = False
    live_node_status[junction_id]["shelter_in_place"] = False
    return junction_id

def route_from_store(door_id: str, verbose: bool = True) -> tuple:
    """
    Calculate evacuation route starting FROM a store door.
    The route goes: door → nearest junction → ... → safest exit.
    The door position is prepended as a display waypoint in the returned path.
    """
    junction_id = DOOR_TO_JUNCTION.get(door_id)
    if not junction_id:
        return [], float("inf")
    path, cost = calculate_safest_route(junction_id, verbose=verbose)
    if path:
        # Prepend door ID so SVG can draw door→junction line
        full_path = [door_id] + path
        return full_path, cost
    return [], float("inf")

def get_store_evacuation_info(door_id: str) -> dict:
    """
    Returns human-readable evacuation info for a store.
    Used by dashboard to show "Thai Relax → Exit 2 via J7→J4→J6"
    """
    junction_id = DOOR_TO_JUNCTION.get(door_id)
    label = DOOR_LABELS.get(door_id, door_id)
    if not junction_id:
        return {"store": label, "door": door_id, "junction": None, "route": []}
    path, cost = calculate_safest_route(junction_id, verbose=False)
    return {
        "store":      label,
        "door":       door_id,
        "junction":   junction_id,
        "route":      [door_id] + path,
        "exit":       path[-1] if path else None,
        "cost":       cost if cost != float("inf") else None,
        "rset":       estimate_rset(path) if path else None,
    }

# Which Lumina node covers each junction
# Which Lumina node covers each junction
JUNCTION_TO_NODE = {
    "J1": "NODE-A", "J2": "NODE-A", "J3": "NODE-A",
    "J4": "NODE-B",
    "J7": "NODE-B", "J8": "NODE-C", "J9": "NODE-C",
    "J10":"NODE-C", "J11":"NODE-C",
    "J15":"NODE-D",
    "J18":"NODE-E", "J19":"NODE-E", "J20":"NODE-E",
    "J12":"NODE-F", "J13":"NODE-F", "J14":"NODE-F", "J17":"NODE-F",
}

LUMINA_NODES = {
    "NODE-A": {"label":"West Corridor",    "junctions":["J1","J2","J3"],          "stores":["B1","B2"]},
    "NODE-B": {"label":"Central Crossroad","junctions":["J4","J7"],                "stores":["B3","B4","B5","B9","B10"]},
    "NODE-C": {"label":"East Corridor",    "junctions":["J8","J9","J10","J11"],    "stores":["B6","B7","B8"]},
    "NODE-D": {"label":"South-Central",    "junctions":["J15"],                    "stores":[]},
    "NODE-E": {"label":"South-West",       "junctions":["J18","J19","J20"],        "stores":["B11","B12","B13"]},
    "NODE-F": {"label":"East-South",       "junctions":["J12","J13","J14","J17"], "stores":["B14","B15","B16"]},
}

# =============================================================================
# 2. FACILITY GRAPH — train-map topology, no diagonals, no skipping
#    Every junction connects only to its direct horizontal/vertical neighbours
#    Distances in metres (SVG px × 50/760)
# =============================================================================
# Store door pixel coords for distance calculation
_DOOR_PX = {
    "B1":(195,356),"B2":(334,356),"B3":(618,356),"B4":(618,356),"B5":(740,356),
    "B6":(1072,141),"B7":(1072,272),"B8":(1040,580),"B9":(644,610),"B10":(529,610),
    "B11":(191,754),"B12":(191,937),"B13":(442,830),"B14":(771,815),
    "B15":(945,815),"B16":(1138,815),
}

def _dist(a, b):
    # Strip _stub suffix used for door→junction distance lookup
    a_key = a.replace("_stub","")
    b_key = b.replace("_stub","")
    all_coords = {**JUNCTION_COORDS, **EXIT_COORDS}
    # Convert door px to SVG coords
    sx,sy = 760/1234, 693/1126
    for k,v in _DOOR_PX.items():
        all_coords[k] = (round(v[0]*sx,1), round(v[1]*sy,1))
    if a_key not in all_coords or b_key not in all_coords:
        return 5.0  # default short distance for unknown
    ax,ay = all_coords[a_key]; bx,by = all_coords[b_key]
    return round(math.sqrt(((ax-bx)*50/760)**2+((ay-by)*50/760)**2), 1)

FACILITY_GRAPH = {
    # West corridor (vertical)
    "J1":  {"EXIT-1":_dist("J1","EXIT-1"), "J2":_dist("J1","J2")},
    "J2":  {"J1":_dist("J2","J1"),         "J3":_dist("J2","J3"),   "B1":_dist("B1","J2")},
    # Main horizontal corridor
    "J3":  {"J2":_dist("J3","J2"),   "J4":_dist("J3","J4"),   "J20":_dist("J3","J20"), "B2":_dist("B2","J3")},
    "J4":  {"J3":_dist("J4","J3"),   "J7":_dist("J4","J7"),  "B4":_dist("B4","J4"), "B9":_dist("B9","J4"), "B10":_dist("B10","J4")},
    # Main horizontal continued
    "J7":  {"J4":_dist("J7","J4"),   "J8":_dist("J7","J8"),  "B5":_dist("B5","J7")},
    "J8":  {"J7":_dist("J8","J7"),   "J9":_dist("J8","J9"),   "J11":_dist("J8","J11")},
    # Right vertical (J9→J10→EXIT-3)
    "J9":  {"J8":_dist("J9","J8"),   "J10":_dist("J9","J10"), "B7":_dist("B7","J9")},
    "J10": {"J9":_dist("J10","J9"),  "EXIT-3":_dist("J10","EXIT-3"), "B6":_dist("B6","J10")},
    # Right vertical continued (J11→J12)
    "J11": {"J8":_dist("J11","J8"),  "J12":_dist("J11","J12"), "B8":_dist("B8","J11")},
    "J12": {"J11":_dist("J12","J11"),"J13":_dist("J12","J13"),"J14":_dist("J12","J14"), "B15":_dist("B15","J12")},
    "J13": {"J12":_dist("J13","J12"),"EXIT-4":_dist("J13","EXIT-4"), "B16":_dist("B16","J13")},
    # Bottom horizontal
    "J14": {"J12":_dist("J14","J12"),"J15":_dist("J14","J15"), "B14":_dist("B14","J14")},
    # NOTE: J16 removed entirely — no physical hardware node there. B9 (Mamadini)
    # and B10 (Public Recipe) now connect directly to J4.
    "J15": {"J14":_dist("J15","J14"),"J17":_dist("J15","J17")},
    # Bottom corridor (J17→J18)
    "J17": {"J15":_dist("J17","J15"),"J18":_dist("J17","J18")},
    "J18": {"J17":_dist("J18","J17"),"J19":_dist("J18","J19"), "B12":_dist("B12","J18")},
    "J19": {"J18":_dist("J19","J18"),"J20":_dist("J19","J20"), "B13":_dist("B13","J19")},
    "J20": {"J19":_dist("J20","J19"),"J3":_dist("J20","J3"),  "B11":_dist("B11","J20")},
    # Exits (destinations only)
    "EXIT-1":{}, "EXIT-3":{}, "EXIT-4":{},
    # Store doors — connect to nearest junction only (orthogonal, no skipping)
    # B3 (Chill Zone) merged into B4 (Empty Space) as one physical unit — same door/junction
    "B1":{"J2":_dist("B1_stub","J2")},   "B2":{"J3":_dist("B2_stub","J3")},
    "B3":{"J4":_dist("B4_stub","J4")},   "B4":{"J4":_dist("B4_stub","J4")},
    "B5":{"J7":_dist("B5_stub","J7")},   "B6":{"J10":_dist("B6_stub","J10")},
    "B7":{"J9":_dist("B7_stub","J9")},   "B8":{"J11":_dist("B8_stub","J11")},
    "B9":{"J4":_dist("B9_stub","J4")}, "B10":{"J4":_dist("B10_stub","J4")},
    "B11":{"J20":_dist("B11_stub","J20")},"B12":{"J18":_dist("B12_stub","J18")},
    "B13":{"J19":_dist("B13_stub","J19")},"B14":{"J14":_dist("B14_stub","J14")},
    "B15":{"J12":_dist("B15_stub","J12")},"B16":{"J13":_dist("B16_stub","J13")},
}

EXITS = ["EXIT-1","EXIT-3","EXIT-4"]

# Static junction -> physical corridor mapping, by nearest-exit straight-line
# distance (NOT live route, which is crowd-dependent and would make the
# ESP32's home-corridor assignment flicker as routes change).
# Maps to the 5 physical LED corridors on the ESP32 strip (C-001..C-005).
EXIT_TO_CORRIDOR = {
    "EXIT-1": "C-001", "EXIT-3": "C-003",
    "EXIT-4": "C-004",
}
J_TO_CORRIDOR = {
    "J1":"C-001","J2":"C-001","J3":"C-001","J18":"C-001","J19":"C-001","J20":"C-001",
    "J4":"C-003","J7":"C-003","J8":"C-003","J9":"C-003","J10":"C-003",
    "J11":"C-004","J12":"C-004","J13":"C-004","J14":"C-004","J15":"C-004","J17":"C-004",
}

# Physical rank of each junction within its corridor's LED strip, ordered
# by distance-to-exit (rank 0 = nearest the exit, increasing inward).
# Used to compute chase direction: if a route visits a corridor's nodes in
# increasing rank order, the chase points toward the exit (dir=1, normal);
# if decreasing, the evacuee is moving away from that corridor's exit and
# the chase must reverse (dir=-1) so the LEDs don't point the wrong way.
J_CORRIDOR_RANK = {
    "J1":1, "J2":2, "J3":3, "J20":4, "J19":5, "J18":6,   # C-001, EXIT-1 side = J1
    "J10":1, "J9":2, "J8":3, "J7":4, "J4":5,             # C-003, EXIT-3 side = J10
    "J13":1, "J12":2, "J11":3, "J14":4, "J15":5, "J17":6,# C-004, EXIT-4 side = J13
}

# Fruin LOS D capacity per corridor segment (pax)
CORRIDOR_CAPACITY = 80

# Genuine crowd crush (at/above CORRIDOR_CAPACITY) is now a HARD block,
# same as fire — real crowd crushes are lethal (Itaewon, Hillsborough), not
# just "undesirable." Debounced with a streak requirement + release margin,
# same dead-zone pattern already used for the crowd icon/status flicker fix,
# so a count wobbling right at 80 doesn't cause the corridor to flicker
# open/blocked every reading.
CORRIDOR_CAPACITY_HARD_BLOCK_STREAK = 3   # consecutive over-capacity readings before hard-blocking
CORRIDOR_CAPACITY_RELEASE_MARGIN    = 10  # pax below capacity required before releasing the block

# =============================================================================
# 3. 3-TIER ESCALATION CONSTANTS
# =============================================================================
TIER1_CROWD   = 50   # NORMAL — stealth, monitor only
TIER2_CROWD   = 85   # PRE_CRUSH — pull policy activates upstream
TIER3_CROWD   = 999  # CRITICAL — fire/fall — global evacuation
VELOCITY_STOP = 0.5  # m/s — crowd stopped = crush forming

PENALTY = {
    "thermal":    5000,
    "crowd_over_capacity": 2000,  # high but finite — always find a path
    "crowd_severe":  400,
    "crowd_high":     80,
    "fallen":        300,
    "quarantine":   5000,
}

HYSTERESIS_THRESHOLD = 0.20  # new route must be 20% cheaper to switch

WALKING_SPEED_NORMAL   = 1.4   # m/s
WALKING_SPEED_EVACUATE = 1.0
WALKING_SPEED_PANIC    = 0.6
ASET_SECONDS           = 600

# =============================================================================
# 4. LIVE NODE STATE  (junctions only)
# =============================================================================
def _make_junction():
    return {
        "status":           "normal",  # normal | warning | alert | quarantine
        "hazard":           None,      # thermal | crowd | fall | smoke | collapsed
        "impassable":       False,     # TRUE physical block (structural collapse) —
                                        # excluded from the graph entirely, unlike
                                        # "quarantine" which is a heavy but finite
                                        # penalty (crowded/dangerous but still walkable
                                        # if there's truly no other way).
        "shelter_in_place": False,     # TRUE when no route exists at all from here —
                                        # occupants should stay put (Area of Refuge)
                                        # and wait for rescue rather than attempt a
                                        # route that doesn't exist. Independent of
                                        # "status" so it doesn't collide with the
                                        # existing normal/warning/alert/quarantine
                                        # color logic already used throughout the UI.
        "crowd":            0,
        "crowd_history":    deque([0]*10, maxlen=10),
        "capacity_streak":  0,          # consecutive readings >= CORRIDOR_CAPACITY,
                                         # used to debounce the crowd-crush hard block
        "velocity":         0.0,       # m/s crowd flow
        "pull_signal":      "GREEN",   # GREEN | AMBER | RED
        "tier":             1,         # 1=normal, 2=pre_crush, 3=critical
    }

DOOR_IDS = [f"B{i}" for i in range(1, 17)]
live_node_status = {nid: _make_junction() for nid in list(FACILITY_GRAPH.keys())}

# Active route + hysteresis tracking
_current_route      = []
_current_route_cost = float("inf")

# =============================================================================
# 5. CROWD VELOCITY & UPDATE
# =============================================================================
def get_crowd_velocity(junction_id: str) -> float:
    h = live_node_status[junction_id]["crowd_history"]
    if len(h) < 2: return 0.0
    # Simple linear regression over last 5 readings
    vals = list(h)[-5:]
    n = len(vals)
    mean_x = (n-1)/2
    mean_y = sum(vals)/n
    num = sum((i-mean_x)*(v-mean_y) for i,v in enumerate(vals))
    den = sum((i-mean_x)**2 for i in range(n))
    return round(num/den if den>0 else 0.0, 2)

CROWD_CLEAR_MARGIN = 10  # pax — crowd status won't clear until count drops this far
                          # below TIER1_CROWD, not just 1 pax under it. Without this,
                          # camera jitter (±1-2 pax frame-to-frame) near the 50-pax
                          # threshold caused the crowd icon to flicker on/off rapidly
                          # while the route (which has its own 20% cost hysteresis)
                          # stayed showing the already-rerouted state — a visible
                          # desync between the icon and the route line.

def update_crowd(junction_id: str, count: int):
    node = live_node_status[junction_id]
    node["crowd"] = count
    node["crowd_history"].append(count)
    vel = get_crowd_velocity(junction_id)
    node["velocity"] = vel

    # Capture this BEFORE the tier-escalation block below potentially
    # clears node["hazard"] to None within this same call — otherwise the
    # release check further down would never match, and a crowd-caused hard
    # block would stay stuck True forever once hazard cleared first.
    _hazard_was_crowd = (node["hazard"] == "crowd")

    # 3-Tier escalation
    if node["status"] in ("alert",) and node["hazard"] in ("thermal","fall"):
        node["tier"] = 3
    elif count >= TIER2_CROWD or (count >= TIER1_CROWD and abs(vel) < VELOCITY_STOP):
        node["tier"] = 2
        if node["status"] == "normal":
            node["status"] = "quarantine" if count >= CORRIDOR_CAPACITY else "warning"
            node["hazard"] = "crowd"
    elif count < (TIER1_CROWD - CROWD_CLEAR_MARGIN):
        # Clearly below threshold — safe to clear the crowd hazard/icon
        node["tier"] = 1
        if node["hazard"] == "crowd":
            node["status"] = "normal"
            node["hazard"] = None
    else:
        # In the dead zone between (TIER1 - margin) and TIER1/TIER2 — hold
        # whatever state we're already in. Prevents flicker from minor
        # camera-count jitter right at the boundary.
        node["tier"] = 2 if node["hazard"] == "crowd" else 1

    # Sustained crush-level crowd (>= CORRIDOR_CAPACITY) escalates to a HARD
    # block, same treatment as fire — a genuine crush is dangerous enough
    # that routing should stop sending MORE people into it, not just add a
    # cost penalty. Debounced via a streak counter so a count wobbling at
    # the boundary doesn't flicker the block on/off every reading. Scoped
    # strictly to a crowd-caused block (via _hazard_was_crowd, captured
    # BEFORE the block above could clear it) so this never touches or
    # releases a block caused by fire or a manual BOMBA block — those are
    # managed entirely by their own separate code paths.
    if count >= CORRIDOR_CAPACITY:
        node["capacity_streak"] = node.get("capacity_streak", 0) + 1
        if node["capacity_streak"] >= CORRIDOR_CAPACITY_HARD_BLOCK_STREAK and not node["impassable"]:
            node["impassable"] = True
    else:
        node["capacity_streak"] = 0
        if node["impassable"] and _hazard_was_crowd \
           and count < (CORRIDOR_CAPACITY - CORRIDOR_CAPACITY_RELEASE_MARGIN):
            node["impassable"] = False

# =============================================================================
# 6. DYNAMIC COST FUNCTION (capacity-constrained)
# =============================================================================


# =============================================================================
# 6. DYNAMIC COST FUNCTION — capacity-constrained with velocity bonus
# =============================================================================
def calculate_dynamic_cost(node_id: str) -> float:
    """
    Edge_Cost = Crowd_Penalty - Velocity_Bonus + Hazard_Penalty
    Velocity bonus: moving crowd costs LESS (flowing corridor = safe to enter)
    Stopped crowd costs MORE (bottleneck = danger of crush)
    Capacity capped at 2000 (finite) — A* always finds a path, never abandons.
    """
    node = live_node_status.get(node_id, {})

    # Exits: 0 cost unless blocked by BOMBA
    if node_id in EXITS:
        if node.get("status") in ("quarantine", "alert"):
            return PENALTY["quarantine"]
        return 0.0

    # Store doors: tiny base cost (short door-to-junction step)
    if node_id.startswith("B"):
        if node.get("hazard") == "thermal" or node.get("status") == "alert":
            return PENALTY["thermal"]
        return 0.5

    cost   = 0.0
    hazard = node.get("hazard")
    status = node.get("status", "normal")
    crowd  = node.get("crowd", 0)
    vel    = get_crowd_velocity(node_id)

    # Hazard penalties
    # BUG FIX: this previously read `hazard=="thermal" or status=="alert"`.
    # Fallen-person nodes ALSO get status="alert" (set by the sim trigger),
    # so that condition was silently applying the full 5000-point THERMAL
    # penalty to fallen hazards too, stacking on top of their own correct
    # 300-point fallen penalty — 5300 total, nearly as severe as fire
    # itself. This directly contradicted the intended design (fire = hard
    # block, fallen = mild soft penalty) without ever showing up as an
    # obviously wrong number anywhere — it just quietly made routes through
    # a fallen-person node cross the 9000 "too risky to count" threshold far
    # more easily than intended, showing up as unexplained "no route"
    # results. Checking hazard=="thermal" alone is correct and sufficient —
    # a genuinely on-fire node always has hazard=="thermal" set alongside
    # its status, so nothing is lost by removing the status=="alert" branch.
    if hazard == "thermal":
        cost += PENALTY["thermal"]
    if status == "quarantine":
        cost += PENALTY["quarantine"]
    if hazard == "fall":
        cost += PENALTY["fallen"]

    # Crowd density penalty (Fruin LOS) — capped at 2000 so graph stays connected
    if crowd >= CORRIDOR_CAPACITY:
        cost += PENALTY["crowd_over_capacity"]   # 2000 — finite, not infinity
    elif crowd >= TIER2_CROWD:
        cost += PENALTY["crowd_severe"]
    elif crowd >= TIER1_CROWD:
        cost += PENALTY["crowd_high"]

    # Velocity adjustment:
    # +velocity = people moving = reward (subtract cost)
    # zero/negative = bottleneck = penalise extra
    if vel > WALKING_SPEED_EVACUATE:
        cost -= min(30.0, vel * 8.0)      # max 30pt discount for flowing crowd
    elif vel <= 0.0 and crowd > TIER1_CROWD:
        cost += 50.0                        # extra penalty for stopped dense crowd

    return max(0.0, cost)

# =============================================================================
# 7. HEURISTIC — admissible Euclidean distance
# =============================================================================
def heuristic(a: str, b: str) -> float:
    # Include door (B-node) SVG coordinates so heuristic doesn't fall back
    # to (0,0) for store nodes — previously caused 32+ admissibility violations.
    # Deflated by 0.99 to absorb floating-point rounding errors in pre-rounded
    # graph distances (all violations were h/dist ≤ 1.02x, purely numerical).
    _door_c = {k: (round(v[0]*sx, 1), round(v[1]*sy, 1)) for k, v in _DOOR_PX.items()}
    all_c = {**JUNCTION_COORDS, **EXIT_COORDS, **_door_c}
    ax,ay = all_c.get(a,(0,0)); bx,by = all_c.get(b,(0,0))
    return 0.97 * math.sqrt(((ax-bx)*50/760)**2+((ay-by)*50/760)**2)

# =============================================================================
# 8. DYN-A* WITH HYSTERESIS
# =============================================================================
def calculate_safest_route(start_junction: str, target: str = None,
                            verbose: bool = True) -> tuple:
    global _current_route, _current_route_cost
    # NOTE: deliberately does NOT reject an impassable start_junction here.
    # Computing "how does someone standing at the hazard itself escape" is a
    # normal, essential operation (every fire/fallen/crowd trigger needs
    # this) — the hazard's own location is legitimately impassable for
    # OTHER routes passing through it, but the person actually there still
    # needs an escape path computed FROM there. The specific edge case this
    # would have caught (blocking a node that's also the pre-existing route's
    # origin) is instead handled at the caller level in
    # block_node_and_reroute(), where it can be distinguished correctly.
    targets = [target] if target in EXITS else EXITS
    best_path, best_cost = [], float("inf")

    for exit_id in targets:
        start_cost = calculate_dynamic_cost(start_junction)
        queue   = [(start_cost, start_junction, [start_junction])]
        visited = set()
        while queue:
            cost, node, path = heapq.heappop(queue)
            if node in visited: continue
            visited.add(node)
            if node == exit_id:
                if cost < best_cost:
                    best_cost = cost
                    best_path = path
                break
            for nbr, dist in FACILITY_GRAPH.get(node, {}).items():
                if nbr not in visited and not live_node_status.get(nbr, {}).get("impassable", False):
                    nc = cost + dist + calculate_dynamic_cost(nbr)
                    heapq.heappush(queue, (nc + heuristic(nbr, exit_id), nbr, path+[nbr]))

    # Hysteresis: recalculate LIVE cost of current route before comparing
    # (not cached cost — current route may now pass through hazard)
    if _current_route and len(_current_route) >= 2:
        live_current_cost = sum(
            FACILITY_GRAPH.get(_current_route[i], {}).get(_current_route[i+1], 0) +
            calculate_dynamic_cost(_current_route[i+1])
            for i in range(len(_current_route)-1)
        )
        # Only keep current route if new route is NOT 20% cheaper AND current route not critically worse
        if best_cost >= live_current_cost * (1 - HYSTERESIS_THRESHOLD) and live_current_cost < PENALTY["thermal"]/2:
            if verbose:
                print(f"[DYN-A*] Hysteresis: keeping current (live={live_current_cost:.1f}, new={best_cost:.1f})")
            return _current_route, round(live_current_cost, 1)

    _current_route      = best_path
    _current_route_cost = best_cost

    if verbose and best_path:
        print(f"[DYN-A*] {' → '.join(best_path)} (cost={best_cost:.1f})")
    return best_path, round(best_cost, 1)

def force_route(path: list):
    """BOMBA manual override — bypasses hysteresis."""
    global _current_route, _current_route_cost
    _current_route      = path
    _current_route_cost = float("inf")  # reset so next auto-calc doesn't snap back

def reset_hysteresis():
    global _current_route, _current_route_cost
    _current_route      = []
    _current_route_cost = float("inf")

def route_to_specific_exit(start: str, exit_id: str, verbose: bool = False) -> tuple:
    """BOMBA forces route to a specific exit. Bypasses hysteresis."""
    if exit_id not in EXITS:
        return [], float("inf")
    # NOTE: no blanket impassable-start check here — same reasoning as
    # calculate_safest_route above. See block_node_and_reroute() for the
    # correctly-scoped fix to the actual bug this was meant to catch.
    queue = [(calculate_dynamic_cost(start), start, [start])]
    visited = set()
    while queue:
        cost, node, path = heapq.heappop(queue)
        if node in visited: continue
        visited.add(node)
        if node == exit_id:
            return path, round(cost, 1)
        for nbr, dist in FACILITY_GRAPH.get(node, {}).items():
            if nbr not in visited and not live_node_status.get(nbr, {}).get("impassable", False):
                nc = cost + dist + calculate_dynamic_cost(nbr)
                heapq.heappush(queue, (nc + heuristic(nbr, exit_id), nbr, path + [nbr]))
    return [], float("inf")

def get_all_exit_routes(start: str) -> list:
    """Returns routes to ALL reachable exits, sorted by cost. For BOMBA quick route panel."""
    routes = []
    for exit_id in EXITS:
        path, cost = route_to_specific_exit(start, exit_id, verbose=False)
        if path and cost < 9000:  # skip exits blocked by hazard
            routes.append({"exit": exit_id, "path": path, "cost": cost, "distance_m": round(cost, 1)})
    routes.sort(key=lambda r: r["cost"])
    # "safe" is relative, not an absolute threshold — if the start node ITSELF
    # is the hazard origin, every route shares that same unavoidable penalty
    # baked into its cost, which previously made every single exit read as
    # "unsafe" even when 4 of 5 routes correctly walk straight away from the
    # hazard after one step. A route is genuinely worse than its peers only
    # if it costs meaningfully more than the cheapest one — that signals it
    # detours around an additional hazard the others don't.
    if routes:
        best_cost = routes[0]["cost"]
        for r in routes:
            r["safe"] = (r["cost"] - best_cost) < 500
    return routes

def block_node_and_reroute(blocked_id: str, start: str, impassable: bool = True) -> dict:
    """
    BOMBA blocks a node. Sets it to quarantine, recalculates route avoiding it.

    impassable=True (default): genuine physical block — structural collapse,
    active fire fully engulfing the corridor, etc. The node is HARD-EXCLUDED
    from the route graph. If no path exists without it, this returns an empty
    route (["blocked_no_route"]) rather than silently routing evacuees through
    a collapsed area with just a cost penalty attached. A BOMBA manual block
    defaults to this — if a human is deliberately marking a node as blocked,
    assume they mean "impassable," not "merely undesirable."

    impassable=False: soft block — still routable as a last resort (heavy
    finite penalty), matching crowd_over_capacity's "always find a path"
    philosophy. Use this for things like "avoid if possible" advisories that
    aren't a literal physical obstruction.

    Returns the new route and blocked node info. If impassable=True and no
    route exists, "new_route" is [] and "no_route" is True — the caller
    (frontend/dashboard) MUST handle this by alerting operators to send
    rescue, not by silently showing a stale or nonsensical path.
    """
    global _current_route, _current_route_cost
    # Mark blocked
    if blocked_id in live_node_status:
        live_node_status[blocked_id]["status"] = "quarantine"
        live_node_status[blocked_id]["hazard"] = "collapsed" if impassable else "crowd"
        live_node_status[blocked_id]["impassable"] = impassable
    # Reset hysteresis so new route is forced
    _current_route = []
    _current_route_cost = float("inf")
    # If the node being blocked IS the exact node we're computing a route
    # from, that's the specific degenerate case (not the general "compute an
    # escape route from a hazard's own location" case, which is normal and
    # must keep working) — it means we just marked someone's current position
    # as structurally impassable, which can't have a meaningful route "from"
    # it. Short-circuit straight to no_route rather than letting the
    # traversal trivially succeed by starting at (i.e. already "escaping")
    # the very spot just deemed impassable.
    if impassable and start == blocked_id:
        path, cost = [], float("inf")
    else:
        path, cost = calculate_safest_route(start, verbose=False)
    no_route = impassable and not path
    # Mark the stranded origin as needing shelter-in-place — an Area of
    # Refuge, not a routing failure. Clear it on any successful route calc
    # from that same node so it doesn't stick around after the block lifts.
    # NEVER mark the blocked node itself — a closed passage isn't a place
    # anyone is waiting for rescue, it's just a route that no longer exists
    # (this matters for the start==blocked_id self-referential case).
    if start in live_node_status and start != blocked_id:
        live_node_status[start]["shelter_in_place"] = no_route
    return {
        "blocked": blocked_id,
        "new_route": path,
        # Infinity is NOT valid JSON — Python's json module will happily
        # write the literal token `Infinity`, but the browser's strict
        # JSON.parse (used internally by fetch().json()) rejects it outright
        # with a SyntaxError. That error was being thrown and silently
        # swallowing EVERY state update downstream of it in the frontend —
        # this is the actual root cause of "clicking block does nothing" in
        # every no-route scenario, since cost is always float('inf') there.
        "cost": cost if cost != float("inf") else None,
        "start": start,
        "impassable": impassable,
        "no_route": no_route,
    }

def unblock_node(node_id: str):
    """Clear a BOMBA block."""
    if node_id in live_node_status:
        live_node_status[node_id]["status"] = "normal"
        live_node_status[node_id]["hazard"] = None
        live_node_status[node_id]["impassable"] = False
        live_node_status[node_id]["shelter_in_place"] = False
        live_node_status[node_id]["capacity_streak"] = 0

# =============================================================================
# 9. 3-TIER PULL POLICY (AMBER divert, not RED stop)
# =============================================================================
def run_pull_policy(route: list = None) -> dict:
    """
    Pull Policy is GLOBAL hardware state, not path-dependent. It must
    evaluate every node in the building, not just the active DYN-A* route —
    otherwise a crushed node that the algorithm successfully routed AROUND
    would never get its physical RED stop-light, because run_pull_policy
    would never visit it. `route` param kept for backward-compat call
    sites but is no longer required for correctness.
    """
    signals = {}
    for jid, node in live_node_status.items():
        if jid in EXITS:
            signals[jid] = {"signal":"GREEN","reason":"Exit — proceed"}
            continue

        occ = node.get("crowd", 0)
        vel = get_crowd_velocity(jid)
        status = node.get("status", "normal")

        if status in ("alert", "quarantine"):
            sig = "RED"
            reason = f"HAZARD at {jid} — divert"
        elif occ >= CORRIDOR_CAPACITY and vel <= 0.5:
            sig = "RED"
            reason = f"CRUSH HAZARD at {jid} ({occ} pax, vel={vel:.1f}) — zero velocity"
        elif occ >= TIER2_CROWD:
            sig = "AMBER"
            reason = f"Pre-crush forming at {jid} ({occ} pax) — yield/divert"
        else:
            sig = "GREEN"
            reason = f"Clear — {jid} ({occ} pax)"

        signals[jid] = {"signal": sig, "reason": reason}
        node["pull_signal"] = sig

    return signals

# =============================================================================
# 10. RSET ESTIMATOR
# =============================================================================
def estimate_rset(route: list, t1: float = 30.0) -> dict:
    t2 = 5.0
    t3 = 0.0
    for i in range(len(route)-1):
        d = FACILITY_GRAPH.get(route[i],{}).get(route[i+1], 0)
        c = live_node_status.get(route[i+1],{}).get("crowd",0)
        spd = WALKING_SPEED_PANIC if c>85 else WALKING_SPEED_EVACUATE if c>50 else WALKING_SPEED_NORMAL
        t3 += d/spd if spd>0 else 0
    rset = t1+t2+t3
    return {"T1_detection_s":round(t1,1),"T2_hesitation_s":round(t2,1),
            "T3_travel_s":round(t3,1),"RSET_s":round(rset,1),
            "ASET_s":ASET_SECONDS,"margin_s":round(ASET_SECONDS-rset,1),
            "safe":rset<ASET_SECONDS}

def estimate_baseline_rset(route: list, t1: float = 30.0) -> dict:
    t2 = 30.0
    t3 = sum(FACILITY_GRAPH.get(route[i],{}).get(route[i+1],0)/WALKING_SPEED_PANIC
             for i in range(len(route)-1))
    rset = t1+t2+t3
    return {"T1_detection_s":round(t1,1),"T2_hesitation_s":round(t2,1),
            "T3_travel_s":round(t3,1),"RSET_s":round(rset,1),
            "ASET_s":ASET_SECONDS,"margin_s":round(ASET_SECONDS-rset,1),
            "safe":rset<ASET_SECONDS}

def rset_t2_sensitivity(route: list, t1: float = 30.0) -> list:
    base = estimate_baseline_rset(route, t1)
    t3 = sum(FACILITY_GRAPH.get(route[i],{}).get(route[i+1],0)/WALKING_SPEED_NORMAL
             for i in range(len(route)-1))
    results = []
    for t2 in [2,5,8,10,12,15,20,25,30]:
        rset = t1+t2+t3
        results.append({"T2_s":t2,"RSET_s":round(rset,1),
            "reduction_%":round((1-rset/base["RSET_s"])*100,1) if base["RSET_s"]>0 else 0,
            "safe":rset<ASET_SECONDS,"margin_s":round(ASET_SECONDS-rset,1)})
    return results

# =============================================================================
# 11. SELF-TEST
# =============================================================================
if __name__ == "__main__":
    print("="*60)
    print("  LUMINA routing_engine.py — Junction-Based Self Test")
    print("="*60)

    # Basic routing — reset hysteresis between calls so each start
    # gets an independent route (not pinned to the first result)
    for start in ["J1","J4","J8","J15","J18"]:
        reset_hysteresis()
        path, cost = calculate_safest_route(start, verbose=False)
        print(f"  {start} → {' → '.join(path)} (cost={cost})")

    # Hysteresis test
    print("\n  [HYSTERESIS TEST] Route should not change on marginal cost diff")
    reset_hysteresis()
    path1, c1 = calculate_safest_route("J3", verbose=False)
    print(f"  First route: {' → '.join(path1)} cost={c1}")
    path2, c2 = calculate_safest_route("J3", verbose=False)
    print(f"  Second call: {' → '.join(path2)} cost={c2} {'(same ✓)' if path1==path2 else '(changed)'}")

    # Fire test — should reroute around J8
    print("\n  [FIRE TEST] J8 = thermal alert")
    reset_hysteresis()
    live_node_status["J8"]["status"] = "alert"
    live_node_status["J8"]["hazard"] = "thermal"
    path, _ = calculate_safest_route("J7", verbose=False)
    print(f"  J7 route: {' → '.join(path)} | avoids J8: {'✓' if 'J8' not in path else '✗'}")

    # Pull policy
    path, _ = calculate_safest_route("J1", verbose=False)
    signals  = run_pull_policy(path)
    print(f"\n  [PULL POLICY] Route: {' → '.join(path)}")
    for jid, sig in list(signals.items())[:3]:
        print(f"    {jid}: {sig['signal']} — {sig['reason']}")

    # Admissibility check
    bad = []
    all_c = {**JUNCTION_COORDS, **EXIT_COORDS}
    for a,nbrs in FACILITY_GRAPH.items():
        for b,d in nbrs.items():
            h = heuristic(a,b)
            if h > d+0.05: bad.append((a,b,h,d))
    print(f"\n  Heuristic admissible: {'✓' if not bad else f'✗ {len(bad)} violations'}")
    print("="*60)
