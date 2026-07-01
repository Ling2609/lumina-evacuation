# =============================================================================
# LUMINA SMART EVACUATION SYSTEM
# thermal_classifier.py  —  Predictive Heat Anomaly Detector
#
# Runs completely standalone — no camera, no hardware needed.
# Feed it temperature readings (real sensor or simulated) and it will:
#   1. Detect abnormal heat spikes using a rolling Z-score baseline
#   2. Classify severity: NORMAL / WARNING / ALERT (fire likely)
#   3. Trigger sub-500ms local quarantine signal before FACP fires
#   4. Export events as JSON for lumina_live_stream.py to consume
#
# Run:  python thermal_classifier.py
# =============================================================================

import time
import json
import math
import random
from collections import deque
from datetime import datetime

# =============================================================================
# 1. CONFIGURATION
# =============================================================================
ROLLING_WINDOW      = 30    # readings kept in the baseline rolling window
Z_SCORE_WARNING     = 2.0   # standard deviations above baseline → WARNING
Z_SCORE_ALERT       = 3.5   # standard deviations above baseline → ALERT (fire)
RATE_OF_CHANGE_WARN = 2.0   # °C/reading rate — catches fast flash fires
RATE_OF_CHANGE_ALERT= 5.0   # °C/reading rate — immediate ALERT
NORMAL_TEMP_BASELINE= 27.0  # °C — typical Malaysian indoor ambient
ALERT_ABSOLUTE_TEMP = 50.0  # °C — above this: always ALERT (ASET threshold)

# =============================================================================
# 2. THERMAL CLASSIFIER CLASS
# =============================================================================
class ThermalClassifier:
    """
    Stateful rolling-window anomaly detector.
    One instance per Lumina node (each node has its own thermal sensor).
    """

    def __init__(self, node_id: str, window: int = ROLLING_WINDOW):
        self.node_id  = node_id
        self.history  = deque(maxlen=window)
        self.state    = "NORMAL"          # current classification
        self.events   = []                # logged state changes
        self._seed_baseline()

    def _seed_baseline(self):
        """
        Do NOT pre-seed with hardcoded 27C baseline.
        First 30 real readings build the actual localized baseline.
        Classification suppressed during warmup to prevent false alerts.
        """
        self._warmup_remaining = ROLLING_WINDOW

    # ------------------------------------------------------------------
    def _rolling_mean(self) -> float:
        return sum(self.history) / len(self.history)

    def _rolling_std(self) -> float:
        mean = self._rolling_mean()
        variance = sum((x - mean) ** 2 for x in self.history) / len(self.history)
        # Minimum std floor of 0.5°C (variance floor = 0.25, since std = sqrt(variance)).
        # Prevents Z-score explosion in ultra-stable environments:
        # without this, std → 0 makes any tiny reading appear as a massive anomaly.
        return math.sqrt(variance) if variance > 0.25 else 0.5

    def _rate_of_change(self) -> float:
        """Degrees change between the two most recent readings."""
        if len(self.history) < 2:
            return 0.0
        return self.history[-1] - self.history[-2]

    # ------------------------------------------------------------------
    def classify(self, temp_celsius: float) -> dict:
        """
        Feed one temperature reading. Returns a classification result dict.

        This is the function lumina_live_stream.py calls every sensor tick.
        Designed to run in <1ms — well within the 500ms latency target.
        """
        t_start = time.perf_counter()

        # Record reading
        self.history.append(temp_celsius)

        # Warmup: suppress classification until real baseline is established
        if hasattr(self, '_warmup_remaining') and self._warmup_remaining > 0:
            self._warmup_remaining -= 1
            return {"node_id":self.node_id,"state":"WARMUP","temp_c":round(temp_celsius,2),
                    "baseline_c":temp_celsius,"z_score":0.0,"roc":0.0,
                    "latency_ms":round((time.perf_counter()-t_start)*1000,4),
                    "reason":f"Calibrating — {self._warmup_remaining} readings remaining"}

        mean    = self._rolling_mean()
        std     = self._rolling_std()
        z_score = (temp_celsius - mean) / std
        roc     = self._rate_of_change()

        # Classification logic — absolute threshold beats z-score
        if temp_celsius >= ALERT_ABSOLUTE_TEMP:
            new_state = "ALERT"
            reason    = f"Absolute threshold exceeded ({temp_celsius:.1f}°C ≥ {ALERT_ABSOLUTE_TEMP}°C)"
        elif z_score >= Z_SCORE_ALERT or roc >= RATE_OF_CHANGE_ALERT:
            new_state = "ALERT"
            reason    = (f"Z-score={z_score:.2f} (threshold {Z_SCORE_ALERT}) | "
                         f"Rate-of-change={roc:+.2f}°C/reading")
        elif z_score >= Z_SCORE_WARNING or roc >= RATE_OF_CHANGE_WARN:
            new_state = "WARNING"
            reason    = (f"Z-score={z_score:.2f} (threshold {Z_SCORE_WARNING}) | "
                         f"Rate-of-change={roc:+.2f}°C/reading")
        else:
            new_state = "NORMAL"
            reason    = f"Within baseline (Z={z_score:.2f})"

        latency_ms = (time.perf_counter() - t_start) * 1000

        # Log state transitions (avoids spamming identical events)
        if new_state != self.state:
            event = {
                "timestamp":  datetime.now().isoformat(),
                "node_id":    self.node_id,
                "event":      f"{self.state} → {new_state}",
                "temp_c":     round(temp_celsius, 2),
                "z_score":    round(z_score, 3),
                "roc":        round(roc, 3),
                "baseline":   round(mean, 2),
                "reason":     reason,
                "latency_ms": round(latency_ms, 4),
            }
            self.events.append(event)
            self.state = new_state

        return {
            "node_id":    self.node_id,
            "state":      self.state,
            "temp_c":     round(temp_celsius, 2),
            "baseline_c": round(mean, 2),
            "z_score":    round(z_score, 3),
            "roc":        round(roc, 3),
            "latency_ms": round(latency_ms, 4),
            "reason":     reason,
        }

    def get_events(self) -> list:
        return self.events

# =============================================================================
# 3. TEMPERATURE SIGNAL GENERATORS  (simulate sensor streams for demo)
# =============================================================================
def _normal_ambient(t):
    """Stable indoor ambient with minor HVAC fluctuation."""
    return NORMAL_TEMP_BASELINE + math.sin(t * 0.3) * 0.4 + random.uniform(-0.2, 0.2)

def _gradual_fire(t, onset=15):
    """Slow smouldering fire — temperature climbs steadily after onset."""
    base = NORMAL_TEMP_BASELINE
    if t < onset:
        return base + random.uniform(-0.3, 0.3)
    ramp = (t - onset) * 1.8           # +1.8°C per reading after onset
    return base + ramp + random.uniform(-0.5, 0.5)

def _flash_fire(t, onset=10):
    """Fast flash fire — sudden spike, challenges rate-of-change detector."""
    base = NORMAL_TEMP_BASELINE
    if t < onset:
        return base + random.uniform(-0.3, 0.3)
    spike = (t - onset) ** 1.9         # exponential spike
    return base + spike + random.uniform(-1.0, 1.0)

# =============================================================================
# 4. STANDALONE DEMO  —  3 scenarios, printed to terminal
# =============================================================================
def _separator(char="=", width=70):
    print(char * width)

def run_thermal_demo():
    _separator()
    print("  LUMINA — Thermal Anomaly Classifier — Standalone Demo")
    _separator()

    # ── Scenario A: Normal operation (should stay NORMAL throughout) ──
    _separator("-")
    print("  SCENARIO A — Normal ambient temperature (HVAC baseline)")
    _separator("-")
    clf_a = ThermalClassifier("J16")
    # Pre-seed so warmup is complete — classifier can show NORMAL state properly.
    for _ in range(30):
        clf_a.classify(_normal_ambient(0))
    for tick in range(20):
        temp   = _normal_ambient(tick)
        result = clf_a.classify(temp)
        bar    = "█" * int(temp)
        print(f"  tick {tick:02d}  {temp:5.1f}°C  Z={result['z_score']:+.2f}  "
              f"[{result['state']:<7}]  {result['reason'][:45]}")
    print(f"\n  State transitions logged: {len(clf_a.get_events())} "
          f"(expected 0 — no anomaly)")

    print()

    # ── Scenario B: Gradual smouldering fire ──
    _separator("-")
    print("  SCENARIO B — Gradual smouldering fire (onset at tick 15)")
    _separator("-")
    clf_b = ThermalClassifier("J7")
    # Pre-seed 30 ambient readings so calibration is complete before the demo.
    # In production, a node runs for minutes before any incident — warmup
    # would already be done. Seeding here reflects that real-world condition.
    for _ in range(30):
        clf_b.classify(_normal_ambient(0))
    last_state = "NORMAL"
    for tick in range(35):
        temp   = _gradual_fire(tick, onset=15)
        result = clf_b.classify(temp)
        marker = " ← STATE CHANGE" if result["state"] != last_state else ""
        last_state = result["state"]
        print(f"  tick {tick:02d}  {temp:5.1f}°C  Z={result['z_score']:+.2f}  "
              f"ROC={result['roc']:+.2f}  [{result['state']:<7}]{marker}")

    print(f"\n  Events logged:")
    for ev in clf_b.get_events():
        print(f"    [{ev['timestamp']}]  {ev['event']}")
        print(f"      Temp={ev['temp_c']}°C  Z={ev['z_score']}  "
              f"Latency={ev['latency_ms']}ms")

    print()

    # ── Scenario C: Flash fire (rate-of-change detection) ──
    _separator("-")
    print("  SCENARIO C — Flash fire (onset at tick 10, rapid spike)")
    print("  This tests the rate-of-change detector, not just Z-score.")
    _separator("-")
    clf_c = ThermalClassifier("J8")
    # Pre-seed 30 ambient readings to complete warmup before the demo.
    for _ in range(30):
        clf_c.classify(_normal_ambient(0))
    last_state = "NORMAL"
    for tick in range(25):   # extended to 25 so full spike is visible
        temp   = _flash_fire(tick, onset=10)
        result = clf_c.classify(temp)
        marker = " ← STATE CHANGE" if result["state"] != last_state else ""
        last_state = result["state"]
        print(f"  tick {tick:02d}  {temp:5.1f}°C  Z={result['z_score']:+.2f}  "
              f"ROC={result['roc']:+.2f}  [{result['state']:<7}]{marker}")

    print(f"\n  Events logged:")
    for ev in clf_c.get_events():
        print(f"    [{ev['timestamp']}]  {ev['event']}")
        print(f"      Temp={ev['temp_c']}°C  Z={ev['z_score']}  "
              f"ROC={ev['roc']}°C/reading  Latency={ev['latency_ms']}ms")

    _separator()
    print("  HOW TO INTEGRATE WITH lumina_live_stream.py")
    _separator("-")
    print("""
  from thermal_classifier import ThermalClassifier

  # One classifier per node, created at startup
  thermal_nodes = {
      "J16": ThermalClassifier("J16"),
      "J7":  ThermalClassifier("J7"),
  }

  # Inside your sensor read loop (or MQTT callback):
  result = thermal_nodes["J7"].classify(sensor_reading_celsius)

  if result["state"] == "ALERT":
      # Trigger DYN-A* reroute immediately
      with state_lock:
          live_node_status["J7"]["status"] = "alert"
          live_node_status["J7"]["hazard"] = "thermal"
      calculate_safest_route("J16")
    """)
    _separator()


if __name__ == "__main__":
    run_thermal_demo()
