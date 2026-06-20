// =============================================================================
// LUMINA SMART EVACUATION SYSTEM
// esp32_lumina_node.ino — LED Strip Controller
//
// Hardware:
//   ESP32 Dev Board
//   WS2812B LED strip (30 LEDs total, single data pin GPIO 5)
//   Active Buzzer (GPIO 18)
//   Relay Module (GPIO 19)
//
// LED Strip Layout (30 LEDs across 5 corridors, 6 LEDs each):
//   LEDs  0– 5  →  C-001  Top Corridor
//   LEDs  6–11  →  C-002  Left Corridor
//   LEDs 12–17  →  C-003  Right Corridor
//   LEDs 18–23  →  C-004  Center Corridor
//   LEDs 24–29  →  C-005  Bottom Corridor
//
// Each corridor segment shows:
//   GREEN chase animation = safe, proceed this way
//   RED solid             = hazard / blocked
//   RED blinking          = pull policy STOP LINE — hold, do not enter
//   AMBER pulse           = warning / congestion building
//   OFF                   = not on active route (normal operation)
//
// Communication:
//   MQTT over Wi-Fi — subscribes to lumina/vitrox/demo/7a9b2f/alerts
//   Flask sends corridor states via MQTT every 2s
//
// =============================================================================

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Adafruit_NeoPixel.h>

// ── Pin definitions ───────────────────────────────────────────────────────────
#define LED_PIN       5     // WS2812B data pin
#define LED_COUNT     30    // total LEDs on strip
#define BUZZER_PIN    18    // active buzzer
#define RELAY_PIN     19    // relay module

// ── LED segment definitions (corridor → LED index range) ─────────────────────
#define SEG_C001_START  0
#define SEG_C001_END    5
#define SEG_C002_START  6
#define SEG_C002_END    11
#define SEG_C003_START  12
#define SEG_C003_END    17
#define SEG_C004_START  18
#define SEG_C004_END    23
#define SEG_C005_START  24
#define SEG_C005_END    29
#define LEDS_PER_SEG    6

// ── Wi-Fi & MQTT ─────────────────────────────────────────────────────────────
const char* WIFI_SSID     = "YOUR_WIFI_SSID";      // change before demo
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";   // change before demo
const char* MQTT_BROKER   = "broker.hivemq.com";
const int   MQTT_PORT     = 1883;
const char* MQTT_TOPIC    = "lumina/vitrox/demo/7a9b2f/alerts";
const char* MQTT_TOPIC_ROUTE = "lumina/vitrox/demo/7a9b2f/route";

// ── System state ─────────────────────────────────────────────────────────────
bool systemHazard   = false;
bool fftConfirmed   = false;
bool buzzerActive   = false;

// Per-corridor state — updated by MQTT messages from Flask
// States: "normal" | "route" | "hazard" | "warning" | "pull_stop"
String corridorState[5] = {"normal", "normal", "normal", "normal", "normal"};
// Per-corridor chase direction: 1 = toward higher LED index (default),
// -1 = reversed. Set from the "dir" field inside each corridor's MQTT
// payload so the green chase always points evacuees toward the exit,
// never back into a blocked/hazard segment.
int corridorDir[5] = {1, 1, 1, 1, 1};
// Index mapping: 0=C-001, 1=C-002, 2=C-003, 3=C-004, 4=C-005

// Active route — which corridors are on the DYN-A* path
bool onRoute[5] = {false, false, false, false, false};

// Chase animation tick
int chaseTick = 0;
unsigned long lastAnimMs = 0;
unsigned long lastBuzzToggle = 0;
bool buzzOn = false;

// ── Objects ───────────────────────────────────────────────────────────────────
Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

// ── Colour helpers ────────────────────────────────────────────────────────────
#define COL_OFF       strip.Color(  0,   0,   0)
#define COL_GREEN     strip.Color(  0, 180,   0)
#define COL_GREEN_DIM strip.Color(  0,  40,   0)
#define COL_RED       strip.Color(180,   0,   0)
#define COL_RED_DIM   strip.Color( 60,   0,   0)
#define COL_AMBER     strip.Color(180,  80,   0)
#define COL_WHITE_DIM strip.Color( 30,  30,  30)
#define COL_BLUE_DIM  strip.Color(  0,   0,  60)

// =============================================================================
// LED SEGMENT HELPERS
// =============================================================================

// Get the start LED index for a corridor (0-4)
int segStart(int corridor) {
  return corridor * LEDS_PER_SEG;
}

// Set all LEDs in a corridor to a solid colour
void segSolid(int corridor, uint32_t colour) {
  int s = segStart(corridor);
  for (int i = s; i < s + LEDS_PER_SEG; i++) {
    strip.setPixelColor(i, colour);
  }
}

// Chase animation — one bright LED chasing along the corridor.
// dir=1 chases toward higher LED index (default), dir=-1 reverses the
// chase so evacuees are pointed AWAY from a hazard even if that means
// walking back the way they came (DYN-A* may route through a corridor
// in either physical direction depending on where the hazard origin is).
void segChase(int corridor, uint32_t headColor, uint32_t tailColor, int tick, int dir) {
  int s       = segStart(corridor);
  int rawPos  = tick % LEDS_PER_SEG;
  int pos     = (dir >= 0) ? rawPos : (LEDS_PER_SEG - 1) - rawPos;
  int tailPos = (dir >= 0) ? (pos - 1 + LEDS_PER_SEG) % LEDS_PER_SEG
                           : (pos + 1) % LEDS_PER_SEG;
  for (int i = 0; i < LEDS_PER_SEG; i++) {
    int idx = s + i;
    if (i == pos) {
      strip.setPixelColor(idx, headColor);
    } else if (i == tailPos) {
      strip.setPixelColor(idx, tailColor);
    } else {
      strip.setPixelColor(idx, COL_OFF);
    }
  }
}

// Blinking (for pull stop line)
void segBlink(int corridor, uint32_t colour, bool on) {
  segSolid(corridor, on ? colour : COL_OFF);
}

// Pulse (for warning/amber)
void segPulse(int corridor, int tick) {
  int brightness = (sin(tick * 0.3) + 1.0) * 40;  // 0-80
  uint32_t col = strip.Color(brightness * 2, brightness, 0);  // amber
  segSolid(corridor, col);
}

// =============================================================================
// RENDER ALL CORRIDORS
// Called every ~80ms
// =============================================================================
void renderCorridors() {
  bool blinkOn = (millis() / 500) % 2 == 0;

  for (int c = 0; c < 5; c++) {
    String state = corridorState[c];

    if (state == "hazard") {
      // RED solid — fire or confirmed blocked
      segSolid(c, COL_RED);

    } else if (state == "pull_stop") {
      // RED blinking — pull policy STOP LINE
      segBlink(c, COL_RED, blinkOn);

    } else if (state == "warning") {
      // AMBER pulse — congestion building
      segPulse(c, chaseTick);

    } else if (state == "route") {
      // GREEN chase — on active DYN-A* route, safe to proceed.
      // Direction comes from Python's _build_corridor_states(), which
      // checks where this corridor's nodes sit in the route sequence.
      segChase(c, COL_GREEN, COL_GREEN_DIM, chaseTick, corridorDir[c]);

    } else {
      // "normal" — not on route. Tier 1 stealth: stay completely OFF
      // during everyday operation so the guidance system is invisible
      // and shoppers don't learn to tune out the ceiling lights.
      segSolid(c, COL_OFF);
    }
  }

  strip.show();
}

// =============================================================================
// BUZZER CONTROL
// =============================================================================
void updateBuzzer() {
  if (!systemHazard) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzOn = false;
    return;
  }

  if (fftConfirmed) {
    // Continuous 520Hz-like alarm (buzzer is active so just toggle fast)
    if (millis() - lastBuzzToggle > 480) {  // ~1Hz blink after FACP confirmed
      buzzOn = !buzzOn;
      digitalWrite(BUZZER_PIN, buzzOn ? HIGH : LOW);
      lastBuzzToggle = millis();
    }
  } else {
    // Pre-FACP: 3 short beeps warning
    if (millis() - lastBuzzToggle > 800) {
      buzzOn = !buzzOn;
      digitalWrite(BUZZER_PIN, buzzOn ? HIGH : LOW);
      lastBuzzToggle = millis();
    }
  }
}

// =============================================================================
// MQTT CALLBACK
// Receives JSON from Flask backend:
//   Topic: lumina/vitrox/demo/7a9b2f/alerts
//   Payload: {"system_state": "HAZARD", "facp_confirmed": false,
//             "corridors": {"C-001":"hazard","C-002":"route","C-003":"normal",
//                           "C-004":"route","C-005":"normal"}}
// =============================================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg = "";
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.println("[MQTT] JSON parse error: " + String(err.c_str()));
    return;
  }

  // Update system state
  String sysState = doc["system_state"] | "NORMAL";
  systemHazard  = (sysState == "HAZARD");
  fftConfirmed  = doc["facp_confirmed"] | false;

  // Update corridor states + per-corridor chase direction.
  // Payload shape: {"corridors": {"C-001": {"state":"route","dir":1}, ...}}
  // (object form) OR {"corridors": {"C-001":"route", ...}} (legacy string
  // form, defaults dir=1) — both are accepted so older test payloads
  // during development don't crash the parser.
  const char* corridorKeys[] = {"C-001", "C-002", "C-003", "C-004", "C-005"};
  if (doc.containsKey("corridors")) {
    for (int c = 0; c < 5; c++) {
      if (!doc["corridors"].containsKey(corridorKeys[c])) continue;
      JsonVariant cv = doc["corridors"][corridorKeys[c]];
      if (cv.is<JsonObject>()) {
        corridorState[c] = cv["state"] | "normal";
        corridorDir[c]   = cv["dir"]   | 1;
      } else {
        // legacy plain-string form
        corridorState[c] = cv.as<String>();
        corridorDir[c]   = 1;
      }
    }
  }

  Serial.print("[MQTT] State: " + sysState + " | Corridors: ");
  for (int c = 0; c < 5; c++) {
    Serial.print(String(corridorKeys[c]) + "=" + corridorState[c] + " ");
  }
  Serial.println();
}

// =============================================================================
// Wi-Fi CONNECT
// =============================================================================
void connectWifi() {
  Serial.print("[WiFi] Connecting to " + String(WIFI_SSID));
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" Connected! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println(" FAILED — running in offline mode");
  }
}

// =============================================================================
// MQTT RECONNECT
// =============================================================================
void reconnectMqtt() {
  if (mqttClient.connected()) return;
  randomSeed(analogRead(34));  // prevent duplicate client IDs on Wokwi restart
  String clientId = "LuminaESP32_" + String(random(0xffff), HEX);
  Serial.print("[MQTT] Connecting as " + clientId + "...");
  if (mqttClient.connect(clientId.c_str())) {
    Serial.println(" Connected!");
    mqttClient.subscribe(MQTT_TOPIC);
    mqttClient.subscribe(MQTT_TOPIC_ROUTE);
    Serial.println("[MQTT] Subscribed to " + String(MQTT_TOPIC));
  } else {
    Serial.println(" Failed (rc=" + String(mqttClient.state()) + ") retrying...");
  }
}

// =============================================================================
// SETUP
// =============================================================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n[LUMINA] ESP32 Node starting...");

  // Hardware init
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RELAY_PIN,  OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(RELAY_PIN,  LOW);

  // LED strip init
  strip.begin();
  strip.setBrightness(80);  // 0-255 — reduce if power bank struggles
  strip.clear();
  strip.show();

  // Startup animation — sweep green across all LEDs
  for (int i = 0; i < LED_COUNT; i++) {
    strip.setPixelColor(i, COL_GREEN);
    strip.show();
    delay(30);
  }
  delay(300);
  strip.clear();
  strip.show();

  // Wi-Fi + MQTT
  connectWifi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  Serial.println("[LUMINA] Ready. Waiting for MQTT commands...");
}

// =============================================================================
// LOOP
// =============================================================================
void loop() {
  // MQTT keep-alive
  if (!mqttClient.connected()) {
    reconnectMqtt();
  }
  mqttClient.loop();

  // Animate at ~12 FPS
  if (millis() - lastAnimMs > 80) {
    lastAnimMs = millis();
    chaseTick++;
    renderCorridors();
    updateBuzzer();
  }
}
