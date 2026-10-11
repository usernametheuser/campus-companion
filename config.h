#pragma once
// ============================================================================
//  Campus Companion – hub configuration
//  Edit these values, then re-flash. Nothing else needs to change.
// ============================================================================

#define FW_VERSION "1.0.0"

// ---------- The hub's own Wi-Fi network (soft access point) ----------
#define AP_SSID        "CampusCompanion"
#define AP_PASSWORD    "campus1234"   // 8+ characters, or "" for an open network
#define AP_CHANNEL     6
#define AP_MAX_CLIENTS 10             // ESP32-S3 soft-AP limit is 10 stations

// ---------- Optional: also join an existing Wi-Fi network (station mode) ----
// Leave STA_SSID empty to stay fully offline. When set, the hub is reachable
// on both networks and gets its clock from NTP if that network has internet.
#define STA_SSID       ""
#define STA_PASSWORD   ""

#define HOSTNAME       "campus"       // -> http://campus.local (mDNS)
#define HUB_NAME       "Campus Companion Hub"

// PIN that unlocks admin mode (announcements, events, timetable).
// CHANGE THIS before deploying.
#define ADMIN_PIN      "4321"

// ---------- Onboard RGB LED (WS2812) ----------
// ESP32-S3-DevKitC-1 v1.0 = GPIO48, v1.1 = GPIO38. Use -1 to disable.
#define STATUS_LED_PIN 48

// ---------- Behaviour ----------
#define SEED_SAMPLE_DATA 1    // fill an empty hub with demo content on first boot
#define SYNC_PAGE_SIZE   40   // records per /api/sync response page
#define MAX_OPS_PER_SYNC 25   // client writes accepted per request
