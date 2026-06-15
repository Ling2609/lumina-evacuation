// =============================================================================
// LUMINA SMART EVACUATION SYSTEM
// esp32_lumina_node.ino  —  Edge Node Actuation Controller
//
// Hardware: ESP32 (any variant — WROOM, S2, S3, C3)
// Simulator: https://wokwi.com  (paste this file, add ESP32 board)
//
// What this does:
//   1. Connects to Wi-Fi
//   2. Subscribes to the Lumina MQTT topic
//   3. Parses the JSON payload from lumina_live_stream.py
//   4. On CRITICAL  → RED LED solid (this corridor blocked),
//                      GREEN LED blinks (DYN-A* actively routing elsewhere)
//   5. On RESOLVED  → RED LED off, GREEN LED solid (corridor clear)
//   6. On FACP_CONFIRMED → RED pulses 3x then holds solid (global alarm)
//   7. Serial monitor prints every event for demo visibility
//
// Pin mapping (matches APU lab hardware):
//   GPIO 2  — Onboard LED (status heartbeat)
//   GPIO 18 — GREEN LED   (safe / proceed signal)
//   GPIO 19 — RED LED     (hazard / stop signal)
//
// Flash to real hardware:
//   Arduino IDE → Board: "ESP32 Dev Module" → Upload
//   Or: platformio run --target upload
// =============================================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// =============================================================================
// HARDWARE MODE — pick ONE
//
// USE_LED_STRIP = false : two discrete LEDs (Wokwi default, matches breadboard)
// USE_LED_STRIP = true  : addressable LED strip (WS2812B/NeoPixel) via FastLED
//
// For real prototype with LED strip, set to true and wire the strip's DIN
// to PIN_STRIP_DATA. Half the strip = GREEN segment, half = RED segment
// (or use two separate strips on two pins — see comments below).
// =============================================================================
#define USE_LED_STRIP false

#if USE_LED_STRIP
  #include <FastLED.h>
#endif

// ── Wi-Fi credentials ─────────────────────────────────────────────────────────
// ⚠️  NIGHT BEFORE DEMO — UPDATE THESE TO YOUR PHONE HOTSPOT ⚠️
//
// Steps:
//   1. On your phone: Settings → Mobile Hotspot → note the SSID and password
//   2. Replace the strings below with your hotspot credentials
//   3. Make sure FLASK_IP in App.jsx matches your laptop's hotspot IP
//      (check with: ipconfig → look for "Wireless LAN adapter" IPv4)
//
// For Wokwi simulator testing: keep "Wokwi-GUEST" / ""
// For real hardware at booth:  use your phone hotspot credentials
const char* WIFI_SSID     = "Wokwi-GUEST";   // ← CHANGE TO HOTSPOT NAME
const char* WIFI_PASSWORD = "";               // ← CHANGE TO HOTSPOT PASSWORD

// ── MQTT broker ───────────────────────────────────────────────────────────────
// Must match BROKER and TOPIC in lumina_live_stream.py exactly
const char* MQTT_BROKER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;
const char* MQTT_TOPIC    = "lumina/vitrox/demo/7a9b2f/alerts";
// CLIENT_ID is generated randomly at connect time — prevents HiveMQ rc=5 kicks

// ── GPIO pin definitions ──────────────────────────────────────────────────────
const int PIN_STATUS_LED = 2;   // onboard LED — heartbeat blink
const int PIN_GREEN_LED  = 18;  // safe / GREEN pull signal  (discrete LED mode)
const int PIN_RED_LED    = 19;  // hazard / RED stop signal  (discrete LED mode)

#if USE_LED_STRIP
  // ── LED strip configuration ────────────────────────────────────────────────
  const int PIN_STRIP_DATA = 5;     // DIN pin for WS2812B strip
  const int NUM_LEDS        = 30;   // total pixels on the strip
  // Strip is split into two halves: first half = RED zone, second half = GREEN zone
  // (representing the stop-line / safe-route projection along the corridor)
  const int NUM_RED_PIXELS   = NUM_LEDS / 2;
  const int NUM_GREEN_PIXELS = NUM_LEDS - NUM_RED_PIXELS;
  CRGB strip[NUM_LEDS];
  const uint8_t BRIGHTNESS = 80;   // 0-255, keep modest for battery/eye safety
#endif

// ── Objects ───────────────────────────────────────────────────────────────────
WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

// ── State ─────────────────────────────────────────────────────────────────────
bool  systemHazard        = false;
bool  fftConfirmed        = false;
int   lastPersonCount     = 0;
bool  greenBlinkState      = false;  // current GREEN LED state during hazard blink
unsigned long lastGreenToggle = 0;   // non-blocking GREEN blink timer
unsigned long lastHeartbeat    = 0;
unsigned long lastWifiRetry    = 0;   // non-blocking wifi reconnect timer
unsigned long lastMqttRetry    = 0;   // non-blocking mqtt reconnect timer
const unsigned long WIFI_RETRY_MS = 5000;   // retry every 5s — keeps loop running
const unsigned long MQTT_RETRY_MS = 3000;

// =============================================================================
// HELPERS
// =============================================================================

// =============================================================================
// HELPERS
//
// PHYSICAL INTERPRETATION (for demo narration):
// This single ESP32 node represents ONE corridor junction in the building.
//
//   GREEN solid   = this corridor is clear / part of the active safe route
//   RED solid     = this corridor is the hazard — DO NOT proceed
//   GREEN blink   = hazard exists ELSEWHERE in the building, DYN-A* has
//                   already rerouted — this corridor remains usable,
//                   check dashboard for the lit route
//
// In a full multi-node deployment, OTHER physical nodes along the safe
// route would show solid GREEN while THIS node (at the hazard) shows RED.
// For a single-node demo, the GREEN BLINK communicates "the system is
// actively routing elsewhere" without falsely claiming this corridor
// IS the safe path.
//
// LED STRIP MODE: same logic, but GREEN/RED apply to half-strip segments
// instead of single LEDs — giving a visible "light bar" projection effect
// closer to the real floor-projection concept.
// =============================================================================

#if USE_LED_STRIP
// ── Low-level strip primitives ────────────────────────────────────────────────
void stripSetGreenSegment(bool on) {
  CRGB colour = on ? CRGB::Green : CRGB::Black;
  for (int i = NUM_RED_PIXELS; i < NUM_LEDS; i++) strip[i] = colour;
  FastLED.show();
}
void stripSetRedSegment(bool on) {
  CRGB colour = on ? CRGB::Red : CRGB::Black;
  for (int i = 0; i < NUM_RED_PIXELS; i++) strip[i] = colour;
  FastLED.show();
}
void stripClearAll() {
  fill_solid(strip, NUM_LEDS, CRGB::Black);
  FastLED.show();
}

// ── Animated GREEN chase — "arrow" effect on the safe-route segment ──────────
// A 3-pixel bright comet travels from the RED/GREEN boundary toward the exit
// end of the strip, leaving a dim trail. Repeats continuously while hazard
// is active — visually communicates DIRECTION, not just "green = good".
// Called from loop() via pulseGreenDuringHazard(), non-blocking via millis().
int   greenChasePos = 0;
const int CHASE_STEP_MS = 80;   // lower = faster chase
unsigned long lastChaseStep = 0;

void stripGreenChaseStep() {
  unsigned long now = millis();
  if (now - lastChaseStep < CHASE_STEP_MS) return;
  lastChaseStep = now;

  // Fade all green-segment pixels toward black (creates trailing effect)
  for (int i = NUM_RED_PIXELS; i < NUM_LEDS; i++) {
    strip[i].fadeToBlackBy(60);
  }

  // Draw the bright comet head + 2-pixel tail
  for (int t = 0; t < 3; t++) {
    int pos = NUM_RED_PIXELS + greenChasePos - t;
    if (pos >= NUM_RED_PIXELS && pos < NUM_LEDS) {
      uint8_t brightness = 255 - (t * 80);
      strip[pos] = CRGB(0, brightness, 0);
    }
  }

  FastLED.show();

  greenChasePos++;
  if (greenChasePos >= NUM_GREEN_PIXELS + 3) greenChasePos = 0;  // loop, +3 lets tail clear
}
#endif

void setNormal() {
#if USE_LED_STRIP
  stripSetGreenSegment(true);
  stripSetRedSegment(false);
#else
  digitalWrite(PIN_GREEN_LED, HIGH);
  digitalWrite(PIN_RED_LED,   LOW);
#endif
  Serial.println("[ACTUATOR] >> GREEN solid — corridor clear, normal operation");
}

void setHazardLocal() {
  // This node IS the hazard location — RED solid (stop), GREEN animates
  // to show the rest of the system is still actively routing.
#if USE_LED_STRIP
  stripSetRedSegment(true);
  stripSetGreenSegment(false);  // clear green segment — chase animation starts fresh
  greenChasePos = 0;
  Serial.println("[ACTUATOR] >> RED solid (this corridor blocked) + GREEN comet chase toward exit (DYN-A* active)");
#else
  digitalWrite(PIN_RED_LED, HIGH);
  Serial.println("[ACTUATOR] >> RED solid (this corridor blocked) + GREEN blinking (DYN-A* active elsewhere)");
#endif
}

void pulseGreenDuringHazard() {
  // Called repeatedly in loop() while systemHazard==true.
#if USE_LED_STRIP
  // Strip mode: animated comet chase travels toward the exit end —
  // visually communicates a DIRECTION, like an arrow pointing to safety.
  // RED segment stays solid (set once by setHazardLocal) and is
  // untouched here — only the GREEN segment animates.
  stripGreenChaseStep();
#else
  // Discrete LED mode: simple on/off blink (no direction possible with 1 LED)
  unsigned long now = millis();
  if (now - lastGreenToggle >= 400) {
    greenBlinkState = !greenBlinkState;
    digitalWrite(PIN_GREEN_LED, greenBlinkState ? HIGH : LOW);
    lastGreenToggle = now;
  }
#endif
}

void pulseRed(int times) {
  for (int i = 0; i < times; i++) {
#if USE_LED_STRIP
    stripSetRedSegment(true);  delay(200);
    stripSetRedSegment(false); delay(200);
#else
    digitalWrite(PIN_RED_LED, HIGH); delay(200);
    digitalWrite(PIN_RED_LED, LOW);  delay(200);
#endif
  }
#if USE_LED_STRIP
  stripSetRedSegment(true);  // hold RED on after pulsing
#else
  digitalWrite(PIN_RED_LED, HIGH);
#endif
}

void setStandby() {
#if USE_LED_STRIP
  stripClearAll();
#else
  digitalWrite(PIN_GREEN_LED, LOW);
  digitalWrite(PIN_RED_LED,   LOW);
#endif
}

// =============================================================================
// MQTT CALLBACK  — fires every time a message arrives on the subscribed topic
// =============================================================================
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  // Null-terminate payload so we can treat it as a C string
  char msg[512];
  unsigned int len = min(length, (unsigned int)511);
  memcpy(msg, payload, len);
  msg[len] = '\0';

  Serial.print("[MQTT] Received on ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(msg);

  // Parse JSON
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.print("[MQTT] JSON parse error: ");
    Serial.println(err.c_str());
    return;
  }

  const char* status    = doc["status"]      | "UNKNOWN";
  const char* hazardType = doc["hazard_type"] | "";
  int personCount       = doc["person_count"] | 0;

  lastPersonCount = personCount;
  Serial.print("[LUMINA] Status="); Serial.print(status);
  Serial.print("  Hazard=");        Serial.print(hazardType);
  Serial.print("  Persons=");       Serial.println(personCount);

  // ── Actuation logic ──────────────────────────────────────────────────────
  if (strcmp(status, "CRITICAL") == 0) {
    systemHazard = true;
    setHazardLocal();  // RED solid (this corridor blocked) — GREEN blinks in loop()
    Serial.println("[LUMINA] !! CRITICAL EVENT — RED stop line projected, GREEN blinking (DYN-A* active)");

  } else if (strcmp(status, "FACP_CONFIRMED") == 0) {
    fftConfirmed = true;
    Serial.println("[LUMINA] FACP CONFIRMED — global evacuation routing active");
    pulseRed(3);   // 3x pulse to signal confirmation, then RED held on

  } else if (strcmp(status, "RESOLVED") == 0) {
    systemHazard = false;
    fftConfirmed = false;
    greenBlinkState = false;
    setNormal();   // back to GREEN solid, RED off
    Serial.println("[LUMINA] RESOLVED — system returned to NORMAL");

  } else if (strcmp(status, "NORMAL") == 0) {
    // Heartbeat from Python — system is nominal, hold last LED state
    Serial.println("[LUMINA] Heartbeat — system nominal");

  } else {
    Serial.print("[LUMINA] Unhandled status: ");
    Serial.println(status);
  }
}

// =============================================================================
// WI-FI CONNECT  (non-blocking — called once at startup only)
// =============================================================================
void connectWiFi() {
  Serial.print("[WIFI] Connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  // Give it 10 seconds at startup, then fall through to non-blocking retry in loop()
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("[WIFI] Connected — IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n[WIFI] Initial connect failed — will retry non-blocking in loop");
  }
}

// =============================================================================
// MQTT CONNECT  (non-blocking attempt — does NOT freeze if broker unreachable)
// =============================================================================
void tryConnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;   // no point trying without Wi-Fi
  Serial.print("[MQTT] Connecting...");

  // FIX 1: Random client ID prevents HiveMQ from kicking us off (rc=5)
  // HiveMQ disconnects clients sharing the same ID — a new random ID each
  // reconnect avoids the 6-second kick cycle on the public broker.
  String clientId = "lumina-node-" + String(random(0xffff), HEX);

  if (mqttClient.connect(clientId.c_str())) {
    Serial.println(" connected  id=" + clientId);
    mqttClient.subscribe(MQTT_TOPIC);
    Serial.print("[MQTT] Subscribed to: ");
    Serial.println(MQTT_TOPIC);

    // FIX 2: State memory — restore correct LED state after reconnect.
    // If the building is still on fire when Wi-Fi comes back, keep RED.
    // Blindly flashing GREEN would silently cancel an active evacuation.
    if (systemHazard) {
      setHazardLocal();
      Serial.println("[MQTT] Reconnected during HAZARD — RED restored");
    } else {
      setNormal();
      delay(300);
      setStandby();
    }
  } else {
    Serial.print(" failed rc=");
    Serial.println(mqttClient.state());
  }
}

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  Serial.begin(115200);
  randomSeed(analogRead(34));  // seed RNG — without this, Wokwi generates the
                                // SAME clientId every run, and HiveMQ kicks
                                // duplicate client IDs (rc=5) after a few seconds
  delay(500);
  Serial.println("\n[LUMINA] ESP32 Edge Node booting...");

  pinMode(PIN_STATUS_LED, OUTPUT);

#if USE_LED_STRIP
  FastLED.addLeds<WS2812B, PIN_STRIP_DATA, GRB>(strip, NUM_LEDS);
  FastLED.setBrightness(BRIGHTNESS);
  Serial.println("[INIT] LED strip mode — NUM_LEDS=" + String(NUM_LEDS) +
                  " (RED pixels=" + String(NUM_RED_PIXELS) +
                  ", GREEN pixels=" + String(NUM_GREEN_PIXELS) + ")");
#else
  pinMode(PIN_GREEN_LED,  OUTPUT);
  pinMode(PIN_RED_LED,    OUTPUT);
  Serial.println("[INIT] Discrete LED mode — GREEN=GPIO" + String(PIN_GREEN_LED) +
                  ", RED=GPIO" + String(PIN_RED_LED));
#endif
  setStandby();

  connectWiFi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(onMqttMessage);
  tryConnectMQTT();

  Serial.println("[LUMINA] Edge Node ready — listening for events");
}

// =============================================================================
// LOOP
// =============================================================================
void loop() {
  unsigned long now = millis();

  // ── Non-blocking Wi-Fi reconnect ─────────────────────────────────────────
  // Uses millis() so the loop never freezes — LEDs stay in last known state
  // while reconnecting (critical for booth demo in crowded 2.4GHz environments)
  if (WiFi.status() != WL_CONNECTED && now - lastWifiRetry > WIFI_RETRY_MS) {
    lastWifiRetry = now;
    Serial.println("[WIFI] Disconnected — attempting reconnect...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }

  // ── Non-blocking MQTT reconnect ───────────────────────────────────────────
  if (WiFi.status() == WL_CONNECTED && !mqttClient.connected() &&
      now - lastMqttRetry > MQTT_RETRY_MS) {
    lastMqttRetry = now;
    tryConnectMQTT();
  }

  mqttClient.loop();   // processes incoming MQTT messages

  // ── GREEN chase during hazard ─────────────────────────────────────────────
  // RED stays solid (this corridor blocked) — GREEN animates toward exit
  // regardless of FACP confirmation status. Occupants need the escape route
  // visible at all times during a hazard, not just before FACP confirms.
  if (systemHazard) {
    pulseGreenDuringHazard();
  }

  // ── Heartbeat blink every 2 seconds ───────────────────────────────────────
  if (now - lastHeartbeat > 2000) {
    lastHeartbeat = now;
    digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
    Serial.print("[HEARTBEAT] WiFi=");
    Serial.print(WiFi.status() == WL_CONNECTED ? "OK" : "DOWN");
    Serial.print("  MQTT=");
    Serial.print(mqttClient.connected() ? "OK" : "DOWN");
    Serial.print("  State=");
    Serial.print(systemHazard ? "HAZARD" : "NORMAL");
    Serial.print("  FFT=");
    Serial.print(fftConfirmed ? "CONFIRMED" : "STANDBY");
    Serial.print("  Persons=");
    Serial.println(lastPersonCount);
  }
}
