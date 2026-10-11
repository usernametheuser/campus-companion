// ============================================================================
//  Campus Companion Hub - ESP32-S3
//
//  The ESP32-S3 creates its own Wi-Fi network and serves an offline-first web
//  app from LittleFS. Phones keep a full local copy (IndexedDB) and sync with
//  the hub over a tiny revision-based API whenever they are in range.
//  No internet, cloud or app store needed.
//
//  Endpoints
//    GET  /api/info   hub status
//    POST /api/sync   push queued writes + pull changes since a revision
//    GET  /*          web app (data/www on LittleFS)
// ============================================================================

#include <Arduino.h>
#include <ArduinoJson.h>
#include <AsyncJson.h>
#include <DNSServer.h>
#include <ESPAsyncWebServer.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <sys/time.h>

#include "config.h"
#include "store.h"

static AsyncWebServer server(80);
static DNSServer dns;
static Store store;
static const IPAddress kApIp(192, 168, 4, 1);

static volatile uint32_t lastSyncMs = 0;  // LED blink trigger, written by the web task
static uint8_t pinFails = 0;
static uint32_t pinLockedUntil = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
static bool timeValid() { return time(nullptr) > 1700000000; }
static uint32_t nowSeconds() { return timeValid() ? (uint32_t)time(nullptr) : 0; }

static void setLed(uint8_t r, uint8_t g, uint8_t b) {
#if STATUS_LED_PIN >= 0
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  rgbLedWrite(STATUS_LED_PIN, r, g, b);
#else
  neopixelWrite(STATUS_LED_PIN, r, g, b);
#endif
#endif
}

// 5 wrong PINs lock admin login for 30 s to slow down guessing.
static bool checkPin(const char* pin) {
  if (!pin || !*pin) return false;
  if ((int32_t)(pinLockedUntil - millis()) > 0) return false;
  if (strcmp(pin, ADMIN_PIN) == 0) {
    pinFails = 0;
    return true;
  }
  if (++pinFails >= 5) {
    pinFails = 0;
    pinLockedUntil = millis() + 30000;
    Serial.println("[auth] too many wrong PINs, locked for 30 s");
  }
  return false;
}

static void sendJson(AsyncWebServerRequest* req, JsonDocument& doc, int code = 200) {
  AsyncResponseStream* res = req->beginResponseStream("application/json");
  res->setCode(code);
  res->addHeader("Cache-Control", "no-store");
  serializeJson(doc, *res);
  req->send(res);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
static void handleInfo(AsyncWebServerRequest* req) {
  JsonDocument d;
  {
    std::lock_guard<std::mutex> g(store.lock());
    d["rev"] = store.rev();
    d["epoch"] = store.epoch();
    d["records"] = store.itemCount();
  }
  d["name"] = HUB_NAME;
  d["version"] = FW_VERSION;
  d["uptime"] = millis() / 1000;
  d["heap"] = ESP.getFreeHeap();
  d["psram"] = ESP.getFreePsram();
  d["stations"] = WiFi.softAPgetStationNum();
  d["time"] = nowSeconds();
  d["staIp"] = WiFi.isConnected() ? WiFi.localIP().toString() : String("");
  size_t total = LittleFS.totalBytes();
  d["fsUsed"] = total ? (uint8_t)(LittleFS.usedBytes() * 100 / total) : 0;
  sendJson(req, d);
}

// Request:  { since, after, epoch, clientTime, pin?, ops: [{col,id,op,data,key}] }
// Response: { results: [{id,ok,err?}], admin, reset?, items, more, cursor, rev, epoch, time }
static void handleSync(AsyncWebServerRequest* req, JsonVariant& body) {
  JsonObjectConst in = body.as<JsonObjectConst>();
  if (in.isNull()) {
    req->send(400, "application/json", "{\"error\":\"expected a JSON object\"}");
    return;
  }

  // No RTC and maybe no internet: borrow the clock from the first phone that syncs.
  double clientMs = in["clientTime"] | 0.0;
  if (!timeValid() && clientMs > 1.7e12) {
    struct timeval tv = {(time_t)(clientMs / 1000), 0};
    settimeofday(&tv, nullptr);
    Serial.println("[time] clock set from client");
  }

  bool admin = checkPin(in["pin"] | "");
  uint32_t since = in["since"] | 0;
  uint32_t after = in["after"] | since;
  const char* epoch = in["epoch"] | "";

  JsonDocument out;
  {
    std::lock_guard<std::mutex> g(store.lock());

    JsonArray results = out["results"].to<JsonArray>();
    uint8_t n = 0;
    for (JsonObjectConst op : in["ops"].as<JsonArrayConst>()) {
      if (n++ >= MAX_OPS_PER_SYNC) break;
      OpResult r = store.apply(op, admin, nowSeconds());
      JsonObject rr = results.add<JsonObject>();
      rr["id"] = op["id"];
      rr["ok"] = r == OpResult::OK;
      if (r != OpResult::OK) rr["err"] = Store::describe(r);
    }

    if (store.needsReset(since, epoch)) {
      out["reset"] = true;
    } else {
      uint32_t cursor = 0;
      out["more"] = store.collect(after, SYNC_PAGE_SIZE, out["items"].to<JsonArray>(), cursor);
      out["cursor"] = cursor;
    }
    out["rev"] = store.rev();
    out["epoch"] = store.epoch();
  }
  out["admin"] = admin;
  out["time"] = nowSeconds();
  lastSyncMs = millis();
  sendJson(req, out);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
static void startWifi() {
  bool useSta = strlen(STA_SSID) > 0;
  WiFi.setHostname(HOSTNAME);
  WiFi.mode(useSta ? WIFI_AP_STA : WIFI_AP);
  WiFi.softAPConfig(kApIp, kApIp, IPAddress(255, 255, 255, 0));
  WiFi.softAP(AP_SSID, strlen(AP_PASSWORD) ? AP_PASSWORD : nullptr, AP_CHANNEL, 0, AP_MAX_CLIENTS);
  WiFi.setSleep(false);  // lower latency for clients
  Serial.printf("[wifi] AP \"%s\" at http://%s\n", AP_SSID, WiFi.softAPIP().toString().c_str());

  if (useSta) {
    WiFi.begin(STA_SSID, STA_PASSWORD);
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    Serial.printf("[wifi] joining \"%s\"...\n", STA_SSID);
  }

  // Captive-portal style DNS: every name resolves to the hub.
  dns.setErrorReplyCode(DNSReplyCode::NoError);
  dns.start(53, "*", kApIp);

  if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", 80);
}

static void startServer() {
  server.on("/api/info", HTTP_GET, handleInfo);

  auto* sync = new AsyncCallbackJsonWebHandler("/api/sync", handleSync);
  sync->setMethod(HTTP_POST);
  sync->setMaxContentLength(24 * 1024);
  server.addHandler(sync);

  server.serveStatic("/", LittleFS, "/www/").setDefaultFile("index.html").setCacheControl("no-cache");

  server.onNotFound([](AsyncWebServerRequest* req) {
    if (req->url().startsWith("/api/")) {
      req->send(404, "application/json", "{\"error\":\"not found\"}");
      return;
    }
    // Captive-portal probes (and any foreign host) get sent to the app.
    String host = req->host();
    int colon = host.indexOf(':');
    if (colon >= 0) host.remove(colon);
    bool ours = host == WiFi.softAPIP().toString() || host == String(HOSTNAME) + ".local" ||
                (WiFi.isConnected() && host == WiFi.localIP().toString());
    if (!ours) {
      req->redirect("http://" + WiFi.softAPIP().toString() + "/");
      return;
    }
    req->send(LittleFS, "/www/index.html", "text/html");  // client-side routes
  });

  server.begin();
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\nCampus Companion hub v%s\n", FW_VERSION);
  setLed(0, 0, 24);  // blue: booting

  if (!store.begin(SEED_SAMPLE_DATA)) {
    setLed(40, 0, 0);  // red: storage problem
  }
  if (!LittleFS.exists("/www/index.html")) {
    Serial.println("[fs] web app missing - upload the data folder (LittleFS) too!");
  }

  startWifi();
  startServer();
  setLed(0, 12, 0);  // green: ready
}

void loop() {
  dns.processNextRequest();
  store.loop();

  // Brief white flash whenever a phone syncs.
  static bool flashing = false;
  uint32_t since = millis() - lastSyncMs;
  if (lastSyncMs && since < 120 && !flashing) {
    setLed(30, 30, 30);
    flashing = true;
  } else if (flashing && since >= 120) {
    setLed(0, 12, 0);
    flashing = false;
  }

  static bool staReported = false;
  if (!staReported && WiFi.isConnected()) {
    staReported = true;
    Serial.printf("[wifi] also reachable at http://%s\n", WiFi.localIP().toString().c_str());
  }
  delay(2);
}
