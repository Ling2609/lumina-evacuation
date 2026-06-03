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
//   4. On CRITICAL  → RED LED on,  GREEN LED off  (hazard actuation)
//   5. On RESOLVED  → RED LED off, GREEN LED on   (safe state)
//   6. On FACP_CONFIRMED → both LEDs pulse 3× then RED stays on
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
const int PIN_GREEN_LED  = 18;  // safe / GREEN pull signal
const int PIN_RED_LED    = 19;  // hazard / RED stop signal

// ── Objects ───────────────────────────────────────────────────────────────────
WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

// ── State ─────────────────────────────────────────────────────────────────────
bool  systemHazard        = false;
bool  fftConfirmed        = false;
int   lastPersonCount     = 0;
unsigned long lastHeartbeat    = 0;
unsigned long lastWifiRetry    = 0;   // non-blocking wifi reconnect timer
unsigned long lastMqttRetry    = 0;   // non-blocking mqtt reconnect timer
const unsigned long WIFI_RETRY_MS = 5000;   // retry every 5s — keeps loop running
const unsigned long MQTT_RETRY_MS = 3000;

// =============================================================================
// HELPERS
// =============================================================================

void setGreen() {
  digitalWrite(PIN_GREEN_LED, HIGH);
  digitalWrite(PIN_RED_LED,   LOW);
  Serial.println("[ACTUATOR] >> GREEN — Safe egress path active");
}

void setRed() {
  digitalWrite(PIN_GREEN_LED, LOW);
  digitalWrite(PIN_RED_LED,   HIGH);
  Serial.println("[ACTUATOR] >> RED — Hazard zone stop signal active");
}

void pulseRed(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(PIN_RED_LED, HIGH);
    delay(200);
    digitalWrite(PIN_RED_LED, LOW);
    delay(200);
  }
}

void setStandby() {
  digitalWrite(PIN_GREEN_LED, LOW);
  digitalWrite(PIN_RED_LED,   LOW);
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
    setRed();
    Serial.println("[LUMINA] !! CRITICAL EVENT — RED LED actuated, stop line projected");

  } else if (strcmp(status, "FACP_CONFIRMED") == 0) {
    fftConfirmed = true;
    Serial.println("[LUMINA] FACP CONFIRMED — global evacuation routing active");
    pulseRed(3);   // 3× pulse to signal confirmation, then hold RED
    setRed();

  } else if (strcmp(status, "RESOLVED") == 0) {
    systemHazard = false;
    fftConfirmed = false;
    setGreen();
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
      setRed();
      Serial.println("[MQTT] Reconnected during HAZARD — RED restored");
    } else {
      setGreen();
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
  delay(500);
  Serial.println("\n[LUMINA] ESP32 Edge Node booting...");

  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_GREEN_LED,  OUTPUT);
  pinMode(PIN_RED_LED,    OUTPUT);
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
