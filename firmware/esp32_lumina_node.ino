// ============================================================
//  esp32_lumina_node.ino  —  Lumina Smart Evacuation Node
//  Two WS2812B strips (LEFT + RIGHT), FastLED driver
//  Receives corridor states from Python via HiveMQ MQTT
//  Sends thermal + obstruction sensor events back to Python
// ============================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <FastLED.h>

// ── WiFi & MQTT ───────────────────────────────────────────────
#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define MQTT_BROKER   "broker.hivemq.com"
#define MQTT_PORT     1883
#define MQTT_TOPIC    "lumina/vitrox/demo/7a9b2f/alerts"   // Python → ESP32
#define SENSOR_TOPIC  "lumina/vitrox/demo/7a9b2f/sensors"  // ESP32 → Python
#define CLIENT_ID     "lumina-node-01"

// ── Pin Definitions ───────────────────────────────────────────
#define LEFT_PIN         5
#define RIGHT_PIN        4
#define NUM_LEFT_LEDS   43
#define NUM_RIGHT_LEDS  35
#define BRIGHTNESS       50
#define LED_TYPE        WS2812B
#define COLOR_ORDER     GRB
#define TRIG_PIN        12    // HC-SR04 trigger
#define ECHO_PIN        13    // HC-SR04 echo

// ── Sensor thresholds ─────────────────────────────────────────
#define THERMAL_ALERT_TEMP     45.0   // °C — triggers THERMAL_ANOMALY
#define THERMAL_CLEAR_TEMP     40.0   // °C — clears alert (hysteresis)
#define OBSTRUCTION_THRESHOLD_CM 15   // cm — corridor considered blocked

// ── LED Arrays ────────────────────────────────────────────────
CRGB leftLeds[NUM_LEFT_LEDS];
CRGB rightLeds[NUM_RIGHT_LEDS];

// ── Channel identifiers ───────────────────────────────────────
#define CH_LEFT  0
#define CH_RIGHT 1

// ── Segment structure ─────────────────────────────────────────
struct PathSegment {
  const char* name;
  int   channel;     // CH_LEFT or CH_RIGHT
  int   startIndex;
  int   endIndex;
};

// ── Physical segment map ──────────────────────────────────────
//  Derived from diorama wiring. Corridor assignments:
//    C-001 : J1, J2, J3, J18, J19, J20  →  EXIT-1
//    C-003 : J4, J7, J8, J9, J10        →  EXIT-2
//    C-004 : J11, J12, J13, J14, J15, J17 → EXIT-3
//
//  Special rules (confirmed with hardware team):
//  • L_J2_J8       = one piece, follows C-003 (J8 end dominates)
//  • L_J8_EXIT2NJ12= T-junction, lights up if C-003 OR C-004 is on route
//  • L_EXIT1_J1 & R_EXIT1_J1 always show same colour (same physical path)
//  • R_J18_J17     = boundary segment, follows C-004

#define NUM_SEGMENTS 9
PathSegment mapSegments[NUM_SEGMENTS] = {
  // ── Left strip (LEFT_PIN, 43 LEDs) ──────────────────────────
  {"L_EXIT1_J1",      CH_LEFT,  0,  5},   // C-001 → EXIT-1 approach
  {"L_J1_J2",         CH_LEFT,  6,  8},   // C-001
  {"L_J2_J8",         CH_LEFT,  9, 23},   // C-003 (one piece, J8 end)
  {"L_J8_EXIT2NJ12",  CH_LEFT, 24, 33},   // T-junction: C-003 OR C-004

  // ── Right strip (RIGHT_PIN, 35 LEDs) ─────────────────────────
  {"R_EXIT1_J1",      CH_RIGHT, 0,  5},   // C-001 → EXIT-1 (mirrors left)
  {"R_J1_J18",        CH_RIGHT, 6, 10},   // C-001
  {"R_J18_J17",       CH_RIGHT,11, 14},   // C-004 (boundary segment)
  {"R_J17_J15",       CH_RIGHT,15, 18},   // C-004
  {"R_J15_EXIT3",     CH_RIGHT,19, 34},   // C-004 → EXIT-3
};

// ── Corridor state (updated by MQTT) ─────────────────────────
// Index: 0=C-001, 1=C-002, 2=C-003, 3=C-004, 4=C-005
// States: "normal" | "route" | "hazard" | "pull_stop" | "warning"
const char* corridorKeys[5] = {"C-001","C-002","C-003","C-004","C-005"};
String corridorState[5]  = {"normal","normal","normal","normal","normal"};
int    corridorDir[5]    = {1, 1, 1, 1, 1};  // 1=forward, -1=reverse

// ── System state ──────────────────────────────────────────────
String systemState   = "NORMAL";
bool   systemHazard  = false;
bool   buzzOn        = false;
bool   fftConfirmed  = false;

// ── Sensor state ──────────────────────────────────────────────
bool thermalAlert    = false;
bool obstructionAlert = false;
unsigned long lastMqttMessage = 0;  // heartbeat watchdog

// ── Timing ────────────────────────────────────────────────────
unsigned long lastSensorCheck = 0;
unsigned long lastLedUpdate   = 0;
int chaseTick = 0;

// ── WiFi + MQTT clients ───────────────────────────────────────
WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

// ============================================================
//  HELPERS — set pixels on the correct strip
// ============================================================
void setPixel(int channel, int index, CRGB colour) {
  if (channel == CH_LEFT  && index < NUM_LEFT_LEDS)  leftLeds[index]  = colour;
  if (channel == CH_RIGHT && index < NUM_RIGHT_LEDS) rightLeds[index] = colour;
}

void fillSegment(int segIdx, CRGB colour) {
  PathSegment& seg = mapSegments[segIdx];
  for (int i = seg.startIndex; i <= seg.endIndex; i++) {
    setPixel(seg.channel, i, colour);
  }
}

// Chase animation along a segment in the given direction
void chaseSegment(int segIdx, CRGB head, CRGB tail, int tick, int dir) {
  PathSegment& seg = mapSegments[segIdx];
  int len   = seg.endIndex - seg.startIndex + 1;
  int pos   = tick % len;
  for (int i = 0; i < len; i++) {
    int idx = seg.startIndex + i;
    int distFromHead = (dir == 1)
      ? (i - pos + len) % len
      : (pos - i + len) % len;
    CRGB col = (distFromHead == 0) ? head
             : (distFromHead <= 2) ? tail
             : CRGB::Black;
    setPixel(seg.channel, idx, col);
  }
}

// ============================================================
//  MAP segment index → which corridor controls it
//  Returns the "effective" state for that segment
// ============================================================
String getSegmentState(int segIdx) {
  const char* name = mapSegments[segIdx].name;

  // T-junction — lights if EITHER C-003 or C-004 is on route/hazard
  if (strcmp(name, "L_J8_EXIT2NJ12") == 0) {
    String s3 = corridorState[2];  // C-003
    String s4 = corridorState[3];  // C-004
    // Priority: hazard > route > pull_stop > warning > normal
    if (s3 == "hazard"    || s4 == "hazard")    return "hazard";
    if (s3 == "route"     || s4 == "route")     return "route";
    if (s3 == "pull_stop" || s4 == "pull_stop") return "pull_stop";
    if (s3 == "warning"   || s4 == "warning")   return "warning";
    return "normal";
  }

  // All other segments map to one corridor
  // C-001 segments
  if (strcmp(name,"L_EXIT1_J1")==0 || strcmp(name,"R_EXIT1_J1")==0 ||
      strcmp(name,"L_J1_J2")==0    || strcmp(name,"R_J1_J18")==0)
    return corridorState[0];  // C-001

  // C-003 segment (L_J2_J8 follows J8 end = C-003)
  if (strcmp(name,"L_J2_J8")==0)
    return corridorState[2];  // C-003

  // C-004 segments
  if (strcmp(name,"R_J18_J17")==0 || strcmp(name,"R_J17_J15")==0 ||
      strcmp(name,"R_J15_EXIT3")==0)
    return corridorState[3];  // C-004

  return "normal";  // fallback
}

// Get chase direction for a segment
int getSegmentDir(int segIdx) {
  const char* name = mapSegments[segIdx].name;
  if (strcmp(name,"L_J8_EXIT2NJ12")==0) {
    // T-junction: use whichever corridor is active
    if (corridorState[2]=="route") return corridorDir[2];
    if (corridorState[3]=="route") return corridorDir[3];
    return 1;
  }
  if (strcmp(name,"L_EXIT1_J1")==0 || strcmp(name,"R_EXIT1_J1")==0 ||
      strcmp(name,"L_J1_J2")==0    || strcmp(name,"R_J1_J18")==0)
    return corridorDir[0];
  if (strcmp(name,"L_J2_J8")==0)
    return corridorDir[2];
  if (strcmp(name,"R_J18_J17")==0 || strcmp(name,"R_J17_J15")==0 ||
      strcmp(name,"R_J15_EXIT3")==0)
    return corridorDir[3];
  return 1;
}

// ============================================================
//  UPDATE ALL LEDS based on current corridor states
// ============================================================
void updateLEDs() {
  // Heartbeat watchdog — if Python goes silent for 8s, go white
  bool pythonAlive = (millis() - lastMqttMessage < 8000);

  for (int s = 0; s < NUM_SEGMENTS; s++) {
    String state = pythonAlive ? getSegmentState(s) : "normal";
    int    dir   = getSegmentDir(s);

    if (state == "hazard") {
      // RED solid blink
      bool on = (millis() / 400) % 2;
      fillSegment(s, on ? CRGB(180,0,0) : CRGB::Black);

    } else if (state == "route") {
      // GREEN chase animation toward exit
      chaseSegment(s, CRGB(0,200,0), CRGB(0,50,0), chaseTick, dir);

    } else if (state == "pull_stop") {
      // AMBER pulse — stop and wait
      int brightness = (sin(millis() * 0.003) + 1) * 80;
      fillSegment(s, CRGB(brightness, brightness/2, 0));

    } else if (state == "warning") {
      // AMBER slow blink
      bool on = (millis() / 800) % 2;
      fillSegment(s, on ? CRGB(180,80,0) : CRGB::Black);

    } else {
      // NORMAL — dim white standby
      fillSegment(s, pythonAlive ? CRGB(20,20,20) : CRGB(5,5,5));
    }
  }

  FastLED.show();
  chaseTick++;
}

// ============================================================
//  MQTT CALLBACK — receives corridor state from Python
// ============================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  // Reset heartbeat watchdog
  lastMqttMessage = millis();

  char msg[1200];
  if (length >= sizeof(msg)) {
    Serial.println("[MQTT] Message too large, skipped");
    return;
  }
  memcpy(msg, payload, length);
  msg[length] = '\0';

  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.print("[MQTT] JSON parse error: ");
    Serial.println(err.c_str());
    return;
  }

  systemState  = doc["system_state"] | "NORMAL";
  systemHazard = (systemState == "HAZARD" || systemState == "CRITICAL");
  fftConfirmed = doc["facp_confirmed"] | false;

  // Parse corridor states
  JsonObject corr = doc["corridors"];
  for (int c = 0; c < 5; c++) {
    if (!corr.containsKey(corridorKeys[c])) continue;
    JsonVariant cv = corr[corridorKeys[c]];
    if (cv.is<JsonObject>()) {
      corridorState[c] = cv["state"] | "normal";
      corridorDir[c]   = cv["dir"]   | 1;
    } else {
      corridorState[c] = cv.as<String>();
      corridorDir[c]   = 1;
    }
  }

  // Debug print
  Serial.print("[MQTT] State: " + systemState + " | ");
  for (int c = 0; c < 5; c++) {
    Serial.print(String(corridorKeys[c]) + "=" + corridorState[c] + " ");
  }
  Serial.println();
}

// ============================================================
//  SENSORS
// ============================================================
void checkThermal() {
  // Simulate MLX90614 — replace with real Wire/I2C read if connected
  // float objTemp = mlx.readObjectTempC();
  float objTemp = 25.0;  // placeholder — replace with actual sensor read

  if (!thermalAlert && objTemp > THERMAL_ALERT_TEMP) {
    thermalAlert = true;
    StaticJsonDocument<128> doc;
    doc["sensor"]  = "MLX90614";
    doc["status"]  = "THERMAL_ANOMALY";
    doc["node"]    = "J7";
    doc["temp_c"]  = objTemp;
    char buf[128]; serializeJson(doc, buf);
    mqttClient.publish(SENSOR_TOPIC, buf);
    Serial.println("[MLX90614] THERMAL_ANOMALY published");
  } else if (thermalAlert && objTemp < THERMAL_CLEAR_TEMP) {
    thermalAlert = false;
    StaticJsonDocument<128> doc;
    doc["sensor"] = "MLX90614";
    doc["status"] = "CLEAR";
    doc["node"]   = "J7";
    doc["temp_c"] = objTemp;
    char buf[128]; serializeJson(doc, buf);
    mqttClient.publish(SENSOR_TOPIC, buf);
    Serial.println("[MLX90614] CLEAR published");
  }
}

void checkObstruction() {
  // HC-SR04 distance measurement
  digitalWrite(TRIG_PIN, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration  = pulseIn(ECHO_PIN, HIGH, 30000);
  int  distanceCm = (int)(duration * 0.034f / 2);

  bool blocked = (distanceCm > 0 && distanceCm < OBSTRUCTION_THRESHOLD_CM);

  if (blocked && !obstructionAlert) {
    obstructionAlert = true;
    StaticJsonDocument<128> doc;
    doc["sensor"]      = "HC-SR04";
    doc["status"]      = "BLOCKED";
    doc["node"]        = "C-003";
    doc["distance_cm"] = distanceCm;
    char buf[128]; serializeJson(doc, buf);
    mqttClient.publish(SENSOR_TOPIC, buf);
    Serial.println("[HC-SR04] BLOCKED published");
  } else if (!blocked && obstructionAlert) {
    obstructionAlert = false;
    StaticJsonDocument<128> doc;
    doc["sensor"]      = "HC-SR04";
    doc["status"]      = "CLEAR";
    doc["node"]        = "C-003";
    doc["distance_cm"] = distanceCm;
    char buf[128]; serializeJson(doc, buf);
    mqttClient.publish(SENSOR_TOPIC, buf);
    Serial.println("[HC-SR04] CLEAR published");
  }
}

// ============================================================
//  WIFI + MQTT CONNECTION
// ============================================================
void connectWifi() {
  Serial.print("[WiFi] Connecting to " + String(WIFI_SSID));
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\n[WiFi] Connected: " + WiFi.localIP().toString());
}

void reconnectMqtt() {
  while (!mqttClient.connected()) {
    Serial.print("[MQTT] Connecting...");
    if (mqttClient.connect(CLIENT_ID)) {
      mqttClient.subscribe(MQTT_TOPIC);
      Serial.println(" connected, subscribed to " + String(MQTT_TOPIC));
    } else {
      Serial.print(" failed rc="); Serial.println(mqttClient.state());
      delay(3000);
    }
  }
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n[Lumina] Booting...");

  // FastLED setup — two independent strips
  FastLED.addLeds<LED_TYPE, LEFT_PIN,  COLOR_ORDER>(leftLeds,  NUM_LEFT_LEDS);
  FastLED.addLeds<LED_TYPE, RIGHT_PIN, COLOR_ORDER>(rightLeds, NUM_RIGHT_LEDS);
  FastLED.setBrightness(BRIGHTNESS);
  FastLED.clear(); FastLED.show();

  // Sensor pins
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  // WiFi
  connectWifi();

  // MQTT — CRITICAL: setBufferSize before setCallback
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setBufferSize(1024);   // default 256 is too small for our payloads
  mqttClient.setCallback(mqttCallback);

  Serial.println("[Lumina] Ready.");
}

// ============================================================
//  LOOP
// ============================================================
void loop() {
  // Maintain WiFi
  if (WiFi.status() != WL_CONNECTED) connectWifi();

  // Maintain MQTT
  if (!mqttClient.connected()) reconnectMqtt();
  mqttClient.loop();

  unsigned long now = millis();

  // Sensor checks every 500ms
  if (now - lastSensorCheck > 500) {
    lastSensorCheck = now;
    checkThermal();
    checkObstruction();
  }

  // LED update every 80ms (smooth chase animation)
  if (now - lastLedUpdate > 80) {
    lastLedUpdate = now;
    updateLEDs();
  }
}
