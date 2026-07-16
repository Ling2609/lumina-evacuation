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
#define MQTT_BROKER   "3.126.41.112"
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

struct PathSegment {
  const char* name;
  int   channel;
  int   startIndex;
  int   endIndex;
};

// ── Physical segment map ──────────────────────────────────────
#define NUM_SEGMENTS 9
PathSegment mapSegments[NUM_SEGMENTS] = {
  {"L_EXIT1_J1",      CH_LEFT,  0,  5},
  {"L_J1_J2",         CH_LEFT,  6,  8},
  {"L_J2_J8",         CH_LEFT,  9, 23},
  {"L_J8_EXIT2NJ12",  CH_LEFT, 24, 33},
  {"R_EXIT1_J1",      CH_RIGHT, 0,  5},   
  {"R_J1_J18",        CH_RIGHT, 6, 10},   
  {"R_J18_J17",       CH_RIGHT,11, 14},   
  {"R_J17_J15",       CH_RIGHT,15, 18},   
  {"R_J15_EXIT3",     CH_RIGHT,19, 34},   
};

// ── Corridor state ───────────────────────────────────────────
const char* corridorKeys[5] = {"C-001","C-002","C-003","C-004","C-005"};
String corridorState[5]  = {"normal","normal","normal","normal","normal"};
int    corridorDir[5]    = {1, 1, 1, 1, 1};

// ── System & Sensor state ────────────────────────────────────
String systemState   = "NORMAL";
bool   systemHazard  = false;
bool   fftConfirmed  = false;

bool thermalAlert     = false;
bool obstructionAlert = false;
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

void fillSegment(int segIdx, CRGB colour) {
  PathSegment& seg = mapSegments[segIdx];
  for (int i = seg.startIndex; i <= seg.endIndex; i++) {
    setPixel(seg.channel, i, colour);
  }
}

void chaseSegment(int segIdx, CRGB head, CRGB tail, int tick, int dir) {
  PathSegment& seg = mapSegments[segIdx];
  int len   = seg.endIndex - seg.startIndex + 1;
  int pos   = tick % len;
  for (int i = 0; i < len; i++) {
    int idx = seg.startIndex + i;
    int distFromHead = (dir == 1) ? (i - pos + len) % len : (pos - i + len) % len;
    CRGB col = (distFromHead == 0) ? head : (distFromHead <= 2) ? tail : CRGB::Black;
    setPixel(seg.channel, idx, col);
  }
}

String getSegmentState(int segIdx) {
  const char* name = mapSegments[segIdx].name;
  if (strcmp(name, "L_J8_EXIT2NJ12") == 0) {
    String s3 = corridorState[2];  
    String s4 = corridorState[3];  
    if (s3 == "hazard"    || s4 == "hazard")    return "hazard";
    if (s3 == "route"     || s4 == "route")     return "route";
    if (s3 == "pull_stop" || s4 == "pull_stop") return "pull_stop";
    if (s3 == "warning"   || s4 == "warning")   return "warning";
    return "normal";
  }
  if (strcmp(name,"L_EXIT1_J1")==0 || strcmp(name,"R_EXIT1_J1")==0 || strcmp(name,"L_J1_J2")==0 || strcmp(name,"R_J1_J18")==0) return corridorState[0]; 
  if (strcmp(name,"L_J2_J8")==0) return corridorState[2];  
  if (strcmp(name,"R_J18_J17")==0 || strcmp(name,"R_J17_J15")==0 || strcmp(name,"R_J15_EXIT3")==0) return corridorState[3];  
  return "normal";  
}

int getSegmentDir(int segIdx) {
  const char* name = mapSegments[segIdx].name;
  if (strcmp(name,"L_J8_EXIT2NJ12")==0) {
    if (corridorState[2]=="route") return corridorDir[2];
    if (corridorState[3]=="route") return corridorDir[3];
    return 1;
  }
  if (strcmp(name,"L_EXIT1_J1")==0 || strcmp(name,"R_EXIT1_J1")==0 || strcmp(name,"L_J1_J2")==0 || strcmp(name,"R_J1_J18")==0) return corridorDir[0];
  if (strcmp(name,"L_J2_J8")==0) return corridorDir[2];
  if (strcmp(name,"R_J18_J17")==0 || strcmp(name,"R_J17_J15")==0 || strcmp(name,"R_J15_EXIT3")==0) return corridorDir[3];
  return 1;
}

// ============================================================
//  UPDATE ALL LEDS 
// ============================================================
void updateLEDs() {
  bool pythonAlive = (millis() - lastMqttMessage < 8000);

  for (int s = 0; s < NUM_SEGMENTS; s++) {
    
    // 【拦截 1：超声波】如果报警，且是 L_J2_J8 路线，直接全红
    if (obstructionAlert && strcmp(mapSegments[s].name, "L_J2_J8") == 0) {
      fillSegment(s, CRGB(255, 0, 0)); 
      continue;                        
    }

    // 【拦截 2：温度计】如果报警，且是 R_J1_J18 路线，直接全红
    if (thermalAlert && strcmp(mapSegments[s].name, "R_J1_J18") == 0) {
      fillSegment(s, CRGB(255, 0, 0)); 
      continue;                        
    }

    String state = pythonAlive ? getSegmentState(s) : "normal";
    int    dir   = getSegmentDir(s);

    if (state == "hazard") {
      bool on = (millis() / 400) % 2;
      fillSegment(s, on ? CRGB(180,0,0) : CRGB::Black);
    } else if (state == "route") {
      chaseSegment(s, CRGB(0,200,0), CRGB(0,50,0), chaseTick, dir);
    } else if (state == "pull_stop") {
      int brightness = (sin(millis() * 0.003) + 1) * 80;
      fillSegment(s, CRGB(brightness, brightness/2, 0));
    } else if (state == "warning") {
      bool on = (millis() / 800) % 2;
      fillSegment(s, on ? CRGB(180,80,0) : CRGB::Black);
    } else {
      fillSegment(s, pythonAlive ? CRGB(20,20,20) : CRGB(5,5,5)); // 这里就是你说的“恢复白色”
    }
  }
  FastLED.show();
  chaseTick++;
}

// ============================================================
//  MQTT CALLBACK 
// ============================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  lastMqttMessage = millis();
  char msg[1200];
  if (length >= sizeof(msg)) return;
  memcpy(msg, payload, length);
  msg[length] = '\0';

  StaticJsonDocument<1024> doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) return;

  systemState  = doc["system_state"] | "NORMAL";
  systemHazard = (systemState == "HAZARD" || systemState == "CRITICAL");
  fftConfirmed = doc["facp_confirmed"] | false;

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
  while (!mqttClient.connected()) {
    if (mqttClient.connect(CLIENT_ID)) {
      mqttClient.subscribe(MQTT_TOPIC);
    } else {
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

  dht.begin(); // 【新增】启动 DHT11 传感器

  connectWifi();
  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setBufferSize(1024);   
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