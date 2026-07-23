// ============================================================
//  esp32_lumina_node.ino  —  Lumina Smart Evacuation Node
//  Two WS2812B strips (LEFT + RIGHT), FastLED driver
//  Receives corridor states from Python via HiveMQ MQTT
//  Sends thermal (DHT11) + obstruction (HC-SR04) sensor events
// ============================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <DHT.h>           // 【新增】引入 DHT 库

// ── WiFi & MQTT ───────────────────────────────────────────────
#define WIFI_SSID     "hello"
#define WIFI_PASSWORD "mybirthday"
#define MQTT_BROKER   "broker.emqx.io"
#define MQTT_PORT     1883
#define MQTT_TOPIC    "lumina/vitrox/demo/7a9b2f/alerts"
#define SENSOR_TOPIC  "lumina/vitrox/demo/7a9b2f/sensors"
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

// 【新增】DHT11 引脚定义 (接线: VCC接3.3V, GND接GND, DATA接GPIO 14)
#define DHTPIN          14    
#define DHTTYPE         DHT11 
DHT dht(DHTPIN, DHTTYPE);

// ── Sensor thresholds ─────────────────────────────────────────
#define THERMAL_ALERT_TEMP       33.0   // °C — 【修改】触发温度设为 33度
#define THERMAL_CLEAR_TEMP       32.0   // °C — 【修改】恢复温度设为 32度 (防闪烁缓冲)
#define OBSTRUCTION_THRESHOLD_CM 22     // cm — 障碍物距离 20cm

// ── LED Arrays ────────────────────────────────────────────────
CRGB leftLeds[NUM_LEFT_LEDS];
CRGB rightLeds[NUM_RIGHT_LEDS];

#define CH_LEFT  0
#define CH_RIGHT 1

// ── Per-node LED mapping (exact LED index from physical measurement) ──
struct NodeLED {
  const char* node_id;
  int         channel;
  int         ledIndex;
};

#define NUM_NODE_LEDS 23
NodeLED nodeLEDMap[NUM_NODE_LEDS] = {
  {"EXIT-1", CH_LEFT,   0},
  {"J1",     CH_LEFT,   5},
  {"J2",     CH_LEFT,   8},
  {"J3",     CH_LEFT,  10},
  {"J4",     CH_LEFT,  16},
  {"J7",     CH_LEFT,  20},
  {"J8",     CH_LEFT,  23},
  {"J11",    CH_LEFT,  27},
  {"J9",     CH_LEFT,  27},
  {"J10",    CH_LEFT,  30},
  {"EXIT-2", CH_LEFT,  33},
  {"EXIT-1", CH_RIGHT,  0},
  {"J1",     CH_RIGHT,  5},
  {"J20",    CH_RIGHT,  6},
  {"J19",    CH_RIGHT,  8},
  {"J18",    CH_RIGHT, 10},
  {"J17",    CH_RIGHT, 15},
  {"J15",    CH_RIGHT, 19},
  {"J14",    CH_RIGHT, 26},
  {"J12",    CH_RIGHT, 28},
  {"J13",    CH_RIGHT, 32},
  {"EXIT-3", CH_RIGHT, 34},
};

// ── Active routes — one per hazard node, kept until that hazard clears ──
#define MAX_HAZARD_ROUTES  4
#define MAX_ROUTE_NODES   20

struct HazardRoute {
  String nodeId;
  String eventType;
  String path[MAX_ROUTE_NODES];
  int    pathLen;
  bool   active;
};

HazardRoute hazardRoutes[MAX_HAZARD_ROUTES];
int hazardRouteCount = 0;

// Colour per event type so two simultaneous routes look distinct
CRGB routeHead(const String& et) { return CRGB(0,200,0); }  // always green
CRGB routeTail(const String& et) { return CRGB(0,50,0);  }  // always dim green


// ── System & Sensor state ────────────────────────────────────
String systemState   = "NORMAL";
bool   systemHazard  = false;
bool   fftConfirmed  = false;

bool   thermalAlert     = false;
bool   obstructionAlert = false;
bool   fallHazard       = false;  // set from backend hazard_type "FALL DETECTED"
String activeBlockedNode = "";    // backward-compatible first blocked node
#define MAX_BLOCKED_NODES 6
String activeBlockedNodes[MAX_BLOCKED_NODES];
int activeBlockedNodeCount = 0;
unsigned long lastMqttMessage = 0;

// ── Timing ────────────────────────────────────────────────────
unsigned long lastSensorCheck = 0;
unsigned long lastDhtCheck    = 0; // 【新增】DHT11 专属计时器
unsigned long lastLedUpdate   = 0;
int chaseTick = 0;

// ── WiFi + MQTT clients ───────────────────────────────────────
WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

// ============================================================
//  LED HELPERS
// ============================================================
void setPixel(int channel, int index, CRGB colour) {
  if (channel == CH_LEFT  && index < NUM_LEFT_LEDS)  leftLeds[index]  = colour;
  if (channel == CH_RIGHT && index < NUM_RIGHT_LEDS) rightLeds[index] = colour;
}

// ── Find LED info for a node, optionally preferring a specific channel ────
bool getNodeLED(const char* nodeId, int& outCh, int& outIdx, int preferChannel = -1) {
  int firstCh = -1, firstIdx = -1;
  for (int i = 0; i < NUM_NODE_LEDS; i++) {
    if (strcmp(nodeLEDMap[i].node_id, nodeId) == 0) {
      if (firstCh == -1) { firstCh = nodeLEDMap[i].channel; firstIdx = nodeLEDMap[i].ledIndex; }
      if (preferChannel == -1 || nodeLEDMap[i].channel == preferChannel) {
        outCh  = nodeLEDMap[i].channel;
        outIdx = nodeLEDMap[i].ledIndex;
        return true;
      }
    }
  }
  // Fallback to first match if preferred channel not found
  if (firstCh != -1) { outCh = firstCh; outIdx = firstIdx; return true; }
  return false;
}

// ── Chase between two LED indices on same strip ───────────────
// Head always travels FROM fromIdx TOWARD toIdx.
// forward (fromIdx < toIdx): head moves low→high
// reverse (fromIdx > toIdx): head moves high→low
void chaseBetween(int ch, int fromIdx, int toIdx, int tick,
                  CRGB headColour = CRGB(0,200,0),
                  CRGB tailColour = CRGB(0,50,0)) {
  if (fromIdx == toIdx) { setPixel(ch, fromIdx, headColour); return; }
  int lo  = min(fromIdx, toIdx);
  int hi  = max(fromIdx, toIdx);
  int len = hi - lo + 1;
  bool forward = (fromIdx < toIdx);
  int progress = tick % len;
  int headOffset = forward ? progress : (len - 1 - progress);
  for (int i = 0; i < len; i++) {
    int trailDistance = forward
      ? (headOffset - i + len) % len
      : (i - headOffset + len) % len;
    CRGB col = (trailDistance == 0) ? headColour
             : (trailDistance <= 2) ? tailColour
             : CRGB::Black;
    setPixel(ch, lo + i, col);
  }
}

// ── Fill between two LED indices ─────────────────────────────
void fillBetween(int ch, int fromIdx, int toIdx, CRGB colour) {
  int lo = min(fromIdx, toIdx);
  int hi = max(fromIdx, toIdx);
  for (int i = lo; i <= hi; i++) setPixel(ch, i, colour);
}


// Backend corridor guidance states: normal | route | warning | pull_stop | hazard
const char* CORRIDOR_IDS[5] = {"C-001","C-002","C-003","C-004","C-005"};
String corridorState[5] = {"normal","normal","normal","normal","normal"};
int corridorDir[5] = {1,1,1,1,1};

void paintCorridorOverlay(int idx) {
  String st = corridorState[idx];

  // Exact hazard zones (J4/J15/J20) are already painted BEFORE the green
  // per-node route. Do not repaint the whole corridor red afterward, or it
  // will hide the green evacuation chase. Pull-stop and warning overlays
  // still keep higher priority and may intentionally override the route.
  if (st == "normal" || st == "route" || st == "hazard") return;

  CRGB col = (st == "warning") ? CRGB(180,90,0) : CRGB(180,0,0);
  bool blink = ((millis()/350)%2)==0;
  if (st == "pull_stop" && !blink) col = CRGB(35,0,0);

  // Physical strip ranges derived from measured node LED indices.
  if (idx == 0) fillBetween(CH_RIGHT, 0, 8, col);       // C-001 west/EXIT-1
  else if (idx == 1) fillBetween(CH_LEFT, 16, 23, col); // C-002 central overlap
  else if (idx == 2) fillBetween(CH_LEFT, 8, 33, col);  // C-003 north/EXIT-2
  else if (idx == 3) fillBetween(CH_RIGHT, 10, 34, col);// C-004 south/EXIT-3
  else if (idx == 4) fillBetween(CH_RIGHT, 6, 15, col); // C-005 south-west
}

// ============================================================
//  UPDATE ALL LEDS — per-node route rendering
// ============================================================
void updateLEDs() {
  bool pythonAlive = (millis() - lastMqttMessage < 8000);

  // Clear all LEDs
  for (int i = 0; i < NUM_LEFT_LEDS;  i++) leftLeds[i]  = CRGB::Black;
  for (int i = 0; i < NUM_RIGHT_LEDS; i++) rightLeds[i] = CRGB::Black;

  if (!pythonAlive) {
    for (int i = 0; i < NUM_LEFT_LEDS;  i++) leftLeds[i]  = CRGB(5,5,5);
    for (int i = 0; i < NUM_RIGHT_LEDS; i++) rightLeds[i] = CRGB(5,5,5);
    FastLED.show();
    chaseTick++;
    return;
  }

  // 1. Dim white on all node LEDs (idle state)
  for (int i = 0; i < NUM_NODE_LEDS; i++) {
    setPixel(nodeLEDMap[i].channel, nodeLEDMap[i].ledIndex, CRGB(15,15,15));
  }

  // 2. Hazard overlays — drawn BEFORE route so green route overrides neighbours naturally
  // Obstruction: use activeBlockedNode from backend if available, else fallback to J4
  if (obstructionAlert || (systemHazard && activeBlockedNodeCount > 0)) {
    int count = activeBlockedNodeCount > 0 ? activeBlockedNodeCount : 1;
    for (int b = 0; b < count; b++) {
      const char* hazNode = activeBlockedNodeCount > 0
                            ? activeBlockedNodes[b].c_str() : "J4";
      int chH, idxH;
      if (getNodeLED(hazNode, chH, idxH)) {
        if (strcmp(hazNode, "J4") == 0) {
          // Exact obstruction area: J3 → J4 → J7. Red stops at J7.
          int chJ3, idxJ3, chJ7, idxJ7;
          bool hJ3 = getNodeLED("J3", chJ3, idxJ3, chH);
          bool hJ7 = getNodeLED("J7", chJ7, idxJ7, chH);
          if (hJ3 && chJ3 == chH) fillBetween(chH, idxJ3, idxH, CRGB(180,0,0));
          if (hJ7 && chJ7 == chH) fillBetween(chH, idxH, idxJ7, CRGB(180,0,0));
        } else {
          int maxIdx = (chH == CH_LEFT) ? NUM_LEFT_LEDS - 1 : NUM_RIGHT_LEDS - 1;
          fillBetween(chH, max(0, idxH-6), min(maxIdx, idxH+6), CRGB(180,0,0));
        }
        bool on = (millis() / 400) % 2;
        setPixel(chH, idxH, on ? CRGB(255,0,0) : CRGB(60,0,0));
      }
    }
  }
  if (thermalAlert) {
    int chJ20, idxJ20, chJ19, idxJ19, chJ1, idxJ1;
    bool hJ20 = getNodeLED("J20", chJ20, idxJ20);
    bool hJ19 = getNodeLED("J19", chJ19, idxJ19);
    bool hJ1  = getNodeLED("J1",  chJ1,  idxJ1,  CH_RIGHT);
    // Fill J19 → J20 solid red
    if (hJ19 && hJ20) fillBetween(chJ19, idxJ19, idxJ20, CRGB(180,0,0));
    // Fill J20 → J1 solid red as well, so both adjacent gaps are blocked
    if (hJ1 && hJ20 && chJ1 == chJ20)
      fillBetween(chJ20, idxJ20, idxJ1, CRGB(180,0,0));
    // J20 blinks bright red
    bool on = (millis() / 400) % 2;
    if (hJ20) setPixel(chJ20, idxJ20, on ? CRGB(255,0,0) : CRGB(60,0,0));
  }
  if (fallHazard) {
    int chJ15, idxJ15, chJ14, idxJ14, chJ17, idxJ17;
    bool hJ15 = getNodeLED("J15", chJ15, idxJ15);
    bool hJ14 = getNodeLED("J14", chJ14, idxJ14);
    bool hJ17 = getNodeLED("J17", chJ17, idxJ17);
    // Fill J17 → J15 solid red (neighbour up to hazard)
    if (hJ17 && hJ15) fillBetween(chJ17, idxJ17, idxJ15, CRGB(180,0,0));
    // Fill J15 → J14 solid red as well, so both adjacent gaps are blocked
    if (hJ14 && hJ15 && chJ14 == chJ15)
      fillBetween(chJ15, idxJ15, idxJ14, CRGB(180,0,0));
    // J15 blinks bright red
    bool on = (millis() / 400) % 2;
    if (hJ15) setPixel(chJ15, idxJ15, on ? CRGB(255,0,0) : CRGB(60,0,0));
  }

  // 3. Active routes — one per hazard, each in its own colour, drawn LAST
  // Routes are kept alive until backend stops sending them (hazard cleared)
  for (int h = 0; h < hazardRouteCount; h++) {
    HazardRoute& hr = hazardRoutes[h];
    if (!hr.active || hr.pathLen < 2) continue;

    CRGB head = routeHead(hr.eventType);
    CRGB tail = routeTail(hr.eventType);

    // Gap fill: hazard node(0) -> first safe node(1), skip hazard LED itself
    int chH, idxH, chS1, idxS1;
    bool foundH  = getNodeLED(hr.path[0].c_str(), chH,  idxH);
    bool foundS1 = getNodeLED(hr.path[1].c_str(), chS1, idxS1, chH);
    if (foundH && foundS1 && chH == chS1) {
      int startLED = (idxH < idxS1) ? idxH + 1 : idxH - 1;
      if (startLED != idxS1) chaseBetween(chH, startLED, idxS1, chaseTick, head, tail);
      setPixel(chS1, idxS1, head);
    }

    // Rest of route: index 1 onward
    int prevCh = chS1;
    for (int r = 1; r < hr.pathLen - 1; r++) {
      int chA, idxA, chB, idxB;
      bool foundA = getNodeLED(hr.path[r].c_str(),   chA, idxA, prevCh);
      if (!foundA) continue;
      bool foundB = getNodeLED(hr.path[r+1].c_str(), chB, idxB, chA);
      if (!foundB) continue;
      prevCh = chB;
      if (chA == chB) {
        chaseBetween(chA, idxA, idxB, chaseTick, head, tail);
      } else {
        setPixel(chA, idxA, head);
        setPixel(chB, idxB, head);
      }
    }
    // Bright first safe node
    int chS, idxS;
    if (getNodeLED(hr.path[1].c_str(), chS, idxS, chH)) setPixel(chS, idxS, head);
  }

  // 4. Apply corridor Pull Policy overlays. RED/AMBER guidance has
  // higher priority than a green route so users are never guided through a
  // stop-line or warning corridor.
  for (int c = 0; c < 5; c++) paintCorridorOverlay(c);

  // 5. Re-apply hazard node blinks ON TOP of everything — hazard nodes must
  //    always blink red regardless of route overlap. This ensures J4/J20/J15
  //    never get hidden by a green route drawn over them.
  bool blinkOn = (millis() / 400) % 2;
  if (obstructionAlert || (systemHazard && activeBlockedNodeCount > 0)) {
    int count = activeBlockedNodeCount > 0 ? activeBlockedNodeCount : 1;
    for (int b = 0; b < count; b++) {
      int ch, idx;
      const char* hazNode = activeBlockedNodeCount > 0
                            ? activeBlockedNodes[b].c_str() : "J4";
      if (getNodeLED(hazNode, ch, idx))
        setPixel(ch, idx, blinkOn ? CRGB(255,0,0) : CRGB(60,0,0));
    }
  }
  if (thermalAlert) {
    int ch, idx;
    if (getNodeLED("J20", ch, idx))
      setPixel(ch, idx, blinkOn ? CRGB(255,0,0) : CRGB(60,0,0));
  }
  if (fallHazard) {
    int ch, idx;
    if (getNodeLED("J15", ch, idx))
      setPixel(ch, idx, blinkOn ? CRGB(255,0,0) : CRGB(60,0,0));
  }


  FastLED.show();
  chaseTick++;
}

// ============================================================
//  MQTT CALLBACK 
// ============================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  lastMqttMessage = millis();
  static char msg[4096];
  if (length >= sizeof(msg)) { Serial.println("[MQTT] Payload too large"); return; }
  memcpy(msg, payload, length);
  msg[length] = '\0';

  StaticJsonDocument<4096> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) { Serial.print("[MQTT] JSON error: "); Serial.println(err.c_str()); return; }

  systemState  = doc["system_state"] | "NORMAL";
  systemHazard = (systemState == "HAZARD" || systemState == "CRITICAL");
  fftConfirmed = doc["facp_confirmed"] | false;

  // Clear local sensor flags when backend reports NORMAL
  if (!systemHazard) {
    thermalAlert     = false;
    obstructionAlert = false;
    fallHazard       = false;
    hazardRouteCount = 0;  // clear all stored routes
    activeBlockedNode = "";
    activeBlockedNodeCount = 0;
    for (int i = 0; i < 5; i++) { corridorState[i] = "normal"; corridorDir[i] = 1; }
    for (int i = 0; i < MAX_HAZARD_ROUTES; i++) hazardRoutes[i].active = false;
  }

  // Parse hazard type — drive all three overlay flags from backend
  String hazardType = doc["hazard_type"] | "";
  fallHazard        = systemHazard && hazardType.startsWith("FALL");
  // Only override local sensor flags from backend if backend confirms hazard type.
  // Local sensor (DHT11/HC-SR04) still sets these independently for fast response.
  if (systemHazard) {
    if (hazardType.startsWith("THERMAL"))     thermalAlert     = true;
    if (hazardType.startsWith("OBSTRUCTION")) obstructionAlert = true;
  }

  // Parse blocked node for dynamic hazard overlay
  if (doc.containsKey("blocked_node")) {
    activeBlockedNode = doc["blocked_node"].as<String>();
  }
  activeBlockedNodeCount = 0;
  if (doc.containsKey("blocked_nodes")) {
    JsonArray blocks = doc["blocked_nodes"].as<JsonArray>();
    for (JsonVariant v : blocks) {
      if (activeBlockedNodeCount >= MAX_BLOCKED_NODES) break;
      activeBlockedNodes[activeBlockedNodeCount++] = v.as<String>();
    }
  } else if (activeBlockedNode.length() > 0) {
    activeBlockedNodes[activeBlockedNodeCount++] = activeBlockedNode;
  }

  // Parse backend Pull Policy / corridor states so AMBER warnings and RED
  // stop-lines are physically reflected on the LED strips.
  if (doc.containsKey("corridors")) {
    JsonObject corridors = doc["corridors"].as<JsonObject>();
    for (int i = 0; i < 5; i++) {
      if (corridors.containsKey(CORRIDOR_IDS[i])) {
        corridorState[i] = corridors[CORRIDOR_IDS[i]]["state"] | "normal";
        corridorDir[i]   = corridors[CORRIDOR_IDS[i]]["dir"] | 1;
      }
    }
  }
  // Parse per_node_routes — routes are kept until backend explicitly clears them
  // (sends empty array) or system returns to NORMAL.
  // If "per_node_routes" key is absent from payload (e.g. old heartbeat format),
  // do NOT clear existing routes — they remain until next valid update.
  if (doc.containsKey("per_node_routes")) {
    JsonArray pnr = doc["per_node_routes"].as<JsonArray>();
    for (int i = 0; i < MAX_HAZARD_ROUTES; i++) hazardRoutes[i].active = false;
    hazardRouteCount = 0;
    if (pnr) {
      for (JsonObject r : pnr) {
        if (hazardRouteCount >= MAX_HAZARD_ROUTES) break;
        HazardRoute& hr = hazardRoutes[hazardRouteCount];
        hr.nodeId    = r["node_id"]    | "";
        hr.eventType = r["event_type"] | "thermal";
        hr.pathLen   = 0;
        hr.active    = true;
        JsonArray path = r["path"].as<JsonArray>();
        for (JsonVariant v : path) {
          if (hr.pathLen >= MAX_ROUTE_NODES) break;
          hr.path[hr.pathLen++] = v.as<String>();
        }
        hazardRouteCount++;
      }
    }
  }
}

// ============================================================
//  SENSORS
// ============================================================
void checkThermal() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();

  // 如果读取错误（比如线松了），直接跳过这次检测
  if (isnan(h) || isnan(t)) {
    Serial.println("[DHT11] Failed to read from sensor! Check wiring.");
    return;
  }

  // 【新增】在后台持续打印当前真实的温湿度，方便你核对准确度
  Serial.print("[Real-Time DHT11] Temp: "); 
  Serial.print(t); 
  Serial.print(" °C | Humidity: "); 
  Serial.print(h); 
  Serial.println(" %");

  // 超过 33 度 -> 触发温度警报
  if (!thermalAlert && t >= THERMAL_ALERT_TEMP) {
    thermalAlert = true;
    StaticJsonDocument<128> doc;
    doc["sensor"]  = "DHT11"; 
    doc["status"]  = "THERMAL_ANOMALY"; 
    doc["node"]    = "J20"; 
    doc["temp_c"]  = t;
    doc["hum_p"]   = h;
    char buf[128]; serializeJson(doc, buf); 
    mqttClient.publish(SENSOR_TOPIC, buf);
    Serial.print("[DHT11 ALERT PUBLISHED] Temp too high: "); Serial.println(t);
  } 
  // 降到 32 度以下 -> 解除警报，恢复正常
  else if (thermalAlert && t <= THERMAL_CLEAR_TEMP) {
    thermalAlert = false;
    StaticJsonDocument<128> doc;
    doc["sensor"] = "DHT11"; 
    doc["status"] = "CLEAR"; 
    doc["node"]   = "J20"; 
    doc["temp_c"] = t;
    doc["hum_p"]  = h;
    char buf[128]; serializeJson(doc, buf); 
    mqttClient.publish(SENSOR_TOPIC, buf);
    Serial.print("[DHT11 CLEAR PUBLISHED] Temp normal: "); Serial.println(t);
  }
}

// Debounce counters for HC-SR04 (500ms per reading)
static int blockedReadings = 0;
static int clearReadings   = 0;
const  int REQUIRED_BLOCKED = 3;  // 1.5s to confirm block
const  int REQUIRED_CLEAR   = 4;  // 2.0s to confirm clear

void checkObstruction() {
  digitalWrite(TRIG_PIN, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  int distanceCm = (duration == 0) ? 999 : (int)(duration * 0.034f / 2);

  Serial.print("[HC-SR04] Distance: ");
  if (distanceCm == 999) Serial.println("Out of range");
  else { Serial.print(distanceCm); Serial.println(" cm"); }

  bool blocked = (distanceCm > 0 && distanceCm <= OBSTRUCTION_THRESHOLD_CM);

  if (blocked) { blockedReadings++; clearReadings = 0; }
  else         { clearReadings++;   blockedReadings = 0; }

  if (!obstructionAlert && blockedReadings >= REQUIRED_BLOCKED) {
    obstructionAlert = true;
    blockedReadings  = 0;
    StaticJsonDocument<128> doc;
    doc["sensor"]      = "HC-SR04";
    doc["status"]      = "BLOCKED";
    doc["node"]        = "C-003";
    doc["distance_cm"] = distanceCm;
    char buf[128]; serializeJson(doc, buf);
    mqttClient.publish(SENSOR_TOPIC, buf);
    Serial.println("[HC-SR04 BLOCKED PUBLISHED]");
  }
  else if (obstructionAlert && clearReadings >= REQUIRED_CLEAR) {
    obstructionAlert = false;
    clearReadings    = 0;
    StaticJsonDocument<128> doc;
    doc["sensor"]      = "HC-SR04";
    doc["status"]      = "CLEAR";
    doc["node"]        = "C-003";
    doc["distance_cm"] = distanceCm;
    char buf[128]; serializeJson(doc, buf);
    mqttClient.publish(SENSOR_TOPIC, buf);
    Serial.println("[HC-SR04 CLEAR PUBLISHED]");
  }
}

// ============================================================
//  WIFI + MQTT CONNECTION
// ============================================================
void connectWifi() {
  Serial.print("[WiFi] Connecting");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\n[WiFi] Connected.");
}

void reconnectMqtt() {
  // 加上打印信息，看看是不是一直卡在这里！
  while (!mqttClient.connected()) {
    Serial.print("[MQTT] Connecting to broker ");
    Serial.print(MQTT_BROKER);
    Serial.print(" ...");
    
    if (mqttClient.connect(CLIENT_ID)) {
      Serial.println(" CONNECTED!");
      mqttClient.subscribe(MQTT_TOPIC);
    } else {
      Serial.print(" FAILED, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" -> Retrying in 3 seconds");
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

  FastLED.addLeds<LED_TYPE, LEFT_PIN,  COLOR_ORDER>(leftLeds,  NUM_LEFT_LEDS);
  FastLED.addLeds<LED_TYPE, RIGHT_PIN, COLOR_ORDER>(rightLeds, NUM_RIGHT_LEDS);
  FastLED.setBrightness(BRIGHTNESS);
  FastLED.clear(); FastLED.show();

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  dht.begin();

  // Initialize hazard route storage
  hazardRouteCount = 0;
  for (int i = 0; i < MAX_HAZARD_ROUTES; i++) {
    hazardRoutes[i].active  = false;
    hazardRoutes[i].pathLen = 0;
  }

  connectWifi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setBufferSize(4096);
  mqttClient.setCallback(mqttCallback);

  Serial.println("[Lumina] Ready.");
}

// ============================================================
//  LOOP
// ============================================================
void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  if (!mqttClient.connected()) reconnectMqtt();
  mqttClient.loop();

  unsigned long now = millis();

  // 超声波每 500 毫秒检测一次
  if (now - lastSensorCheck > 500) {
    lastSensorCheck = now;
    checkObstruction();
  }

  // 温度计每 2000 毫秒 (2秒) 检测一次
  if (now - lastDhtCheck > 2000) {
    lastDhtCheck = now;
    checkThermal();
  }

  if (now - lastLedUpdate > 80) {
    lastLedUpdate = now;
    updateLEDs();
  }
}