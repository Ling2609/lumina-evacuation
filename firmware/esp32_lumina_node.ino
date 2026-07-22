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

bool thermalAlert     = false;
bool obstructionAlert = false;
bool fallHazard       = false;  // set from backend hazard_type "FALL DETECTED"
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
// Direction is always fromIdx → toIdx (follows route order),
// regardless of which index is numerically larger.
void chaseBetween(int ch, int fromIdx, int toIdx, int tick) {
  int lo  = min(fromIdx, toIdx);
  int hi  = max(fromIdx, toIdx);
  int len = hi - lo + 1;
  int dir = (fromIdx <= toIdx) ? 1 : -1;  // +1 = low→high, -1 = high→low
  int pos = tick % len;
  for (int i = 0; i < len; i++) {
    int distFromHead = (dir == 1)
      ? (i - pos + len) % len
      : (pos - i + len) % len;
    CRGB col = (distFromHead == 0) ? CRGB(0,200,0)
             : (distFromHead <= 2) ? CRGB(0,50,0)
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
  if (obstructionAlert) {
    int chJ3, idxJ3, chJ4, idxJ4, chJ7, idxJ7;
    bool hJ3 = getNodeLED("J3", chJ3, idxJ3);
    bool hJ4 = getNodeLED("J4", chJ4, idxJ4);
    bool hJ7 = getNodeLED("J7", chJ7, idxJ7);
    // Fill J3 → J4 solid red (neighbour up to hazard)
    if (hJ3 && hJ4) fillBetween(chJ3, idxJ3, idxJ4, CRGB(180,0,0));
    // Fill J4 → J7 solid red (hazard zone to other neighbour)
    if (hJ4 && hJ7) fillBetween(chJ4, idxJ4, idxJ7, CRGB(180,0,0));
    // Nothing after J7 — clear boundary
    // J4 blinks bright red to stand out as hazard node
    bool on = (millis() / 400) % 2;
    if (hJ4) setPixel(chJ4, idxJ4, on ? CRGB(255,0,0) : CRGB(60,0,0));
  }
  if (thermalAlert) {
    int chJ20, idxJ20, chJ19, idxJ19, chJ1, idxJ1;
    bool hJ20 = getNodeLED("J20", chJ20, idxJ20);
    bool hJ19 = getNodeLED("J19", chJ19, idxJ19);
    bool hJ1  = getNodeLED("J1",  chJ1,  idxJ1,  CH_RIGHT);
    // Fill J19 → J20 solid red
    if (hJ19 && hJ20) fillBetween(chJ19, idxJ19, idxJ20, CRGB(180,0,0));
    // J1 solid red (other neighbour — single node, no fill needed)
    if (hJ1) setPixel(chJ1, idxJ1, CRGB(180,0,0));
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
    // J14 solid red (other neighbour)
    if (hJ14) setPixel(chJ14, idxJ14, CRGB(180,0,0));
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
      if (startLED != idxS1) {
        int lo = min(startLED, idxS1), hi = max(startLED, idxS1), len = hi-lo+1;
        int dir = (startLED <= idxS1) ? 1 : -1;
        int pos = chaseTick % len;
        for (int i = 0; i < len; i++) {
          int d = (dir==1) ? (i-pos+len)%len : (pos-i+len)%len;
          setPixel(chH, lo+i, d==0 ? head : d<=2 ? tail : CRGB::Black);
        }
      }
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
        int lo = min(idxA,idxB), hi = max(idxA,idxB), len = hi-lo+1;
        int dir = (idxA <= idxB) ? 1 : -1;
        int pos = chaseTick % len;
        for (int i = 0; i < len; i++) {
          int d = (dir==1) ? (i-pos+len)%len : (pos-i+len)%len;
          setPixel(chA, lo+i, d==0 ? head : d<=2 ? tail : CRGB::Black);
        }
      } else {
        setPixel(chA, idxA, head);
        setPixel(chB, idxB, head);
      }
    }
    // Bright first safe node
    int chS, idxS;
    if (getNodeLED(hr.path[1].c_str(), chS, idxS, chH)) setPixel(chS, idxS, head);
  }

  // 4. Re-apply hazard node blinks ON TOP of everything — hazard nodes must
  //    always blink red regardless of route overlap. This ensures J4/J20/J15
  //    never get hidden by a green route drawn over them.
  bool blinkOn = (millis() / 400) % 2;
  if (obstructionAlert) {
    int ch, idx;
    if (getNodeLED("J4", ch, idx))
      setPixel(ch, idx, blinkOn ? CRGB(255,0,0) : CRGB(60,0,0));
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
  char msg[2400];
  if (length >= sizeof(msg)) return;
  memcpy(msg, payload, length);
  msg[length] = '\0';

  StaticJsonDocument<2048> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) return;

  systemState  = doc["system_state"] | "NORMAL";
  systemHazard = (systemState == "HAZARD" || systemState == "CRITICAL");
  fftConfirmed = doc["facp_confirmed"] | false;

  // Clear local sensor flags when backend reports NORMAL
  if (!systemHazard) {
    thermalAlert     = false;
    obstructionAlert = false;
    fallHazard       = false;
    hazardRouteCount = 0;  // clear all stored routes
    for (int i = 0; i < MAX_HAZARD_ROUTES; i++) hazardRoutes[i].active = false;
  }

  // Parse hazard type for local LED overlays
  String hazardType = doc["hazard_type"] | "";
  fallHazard = systemHazard && hazardType.startsWith("FALL");

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

void checkObstruction() {
  digitalWrite(TRIG_PIN, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration  = pulseIn(ECHO_PIN, HIGH, 30000);
  
  int distanceCm;
  if (duration == 0) {
    distanceCm = 999; 
  } else {
    distanceCm = (int)(duration * 0.034f / 2);
  }

  // 【新增】在后台持续打印当前真实的超声波距离，方便你核对准确度
  Serial.print("[Real-Time HC-SR04] Distance: ");
  if (distanceCm == 999) {
    Serial.println("Out of range / No echo");
  } else {
    Serial.print(distanceCm);
    Serial.println(" cm");
  }

  bool blocked = (distanceCm > 0 && distanceCm <= OBSTRUCTION_THRESHOLD_CM);

  if (blocked && !obstructionAlert) {
    obstructionAlert = true;
    StaticJsonDocument<128> doc;
    doc["sensor"]      = "HC-SR04";
    doc["status"]      = "BLOCKED";
    doc["node"]        = "C-003"; 
    doc["distance_cm"] = distanceCm;
    char buf[128]; serializeJson(doc, buf);
    mqttClient.publish(SENSOR_TOPIC, buf);
    Serial.println("[HC-SR04 BLOCKED PUBLISHED]");
  } 
  else if (!blocked && obstructionAlert) {
    obstructionAlert = false;
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
  mqttClient.setBufferSize(2048);   
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