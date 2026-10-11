# 🎓 Campus Companion: an offline-first campus app on an ESP32-S3

An **ESP32-S3 dev module** acts as a pocket-sized campus server. It creates its own Wi-Fi network and serves a mobile web app. The app shows announcements, the class timetable, events, lost & found, a notice board, and a campus map, all **without internet, cloud services, or an app store**.

Every phone keeps a full local copy of the data. You can read and post while out of range; changes are queued on the phone and synced when you're back near the hub.

```
 ┌──────────────┐   Wi-Fi "CampusCompanion"    ┌──────────────────────────┐
 │  Phone #1    │ ◄──────────────────────────► │  ESP32-S3 hub            │
 │  IndexedDB   │   POST /api/sync             │  • soft AP + captive DNS │
 │  + outbox    │   (push queued writes,       │  • async web server      │
 └──────────────┘    pull changes since rev N) │  • LittleFS: web app +   │
 ┌──────────────┐                              │    JSON record store     │
 │  Phone #2…10 │ ◄──────────────────────────► │  • RGB LED sync blink    │
 └──────────────┘                              └──────────────────────────┘
```

## Features

| Section | Who can write | Notes |
|---|---|---|
| 📣 Announcements | Admin (PIN) | High-priority posts are pinned |
| 🗓️ Timetable | Admin | Per day and per group/section, with a "now" and "next" class view |
| 🎉 Events | Admin | Upcoming/past, "happening now" badge |
| 🔎 Lost & Found | Anyone | Only the poster (or an admin) can edit, resolve, or delete |
| 💬 Notice Board | Anyone | Short posts, same ownership rule |
| 🗺️ Campus Map | Edit `campus.json` | Clickable SVG map + searchable directory (hours, phone) |
| 📝 My to-dos | Only on your phone | Never leaves the device |

**Offline-first details**
- All screens render from **IndexedDB**. The network is only used for syncing.
- Writes are applied immediately ("⏳ not synced yet") and queued in an **outbox**.
- Sync is **incremental**: every record has a revision number, and phones only pull what changed.
- Deletes become **tombstones**, so every phone learns about them.
- If the hub's storage is wiped or re-flashed, phones notice (store *epoch* changes) and re-download everything.
- The hub has no RTC, so it **borrows the clock** from the first phone that syncs (or uses NTP if you configure station mode).
- The app syncs every 15 s while open, when the tab regains focus, and right after every change.

## Hardware

- Any **ESP32-S3 dev module** (ESP32-S3-DevKitC-1 or a clone, N8 / N8R2 / N16R8 …)
- A USB cable. That's it. No extra wiring.
- Optional: the onboard RGB LED (GPIO48 on DevKitC-1 v1.0, GPIO38 on v1.1) shows status: blue while booting, green when ready, a white flash on every sync, red on a storage error.

## Repository layout

```
campus-companion/
├── firmware/CampusCompanion/        ← Arduino sketch folder (open the .ino in Arduino IDE)
│   ├── CampusCompanion.ino          Wi-Fi AP, DNS, web server, /api/sync
│   ├── config.h                     ← edit Wi-Fi name, password, admin PIN here
│   ├── store.h / store.cpp          revision-based JSON store on LittleFS + schema
│   └── data/www/                    the web app (uploaded to LittleFS)
│       ├── index.html, style.css
│       ├── app.js                   UI, outbox, sync logic
│       ├── db.js                    IndexedDB wrapper
│       ├── sw.js                    service worker (see "Offline app shell")
│       ├── campus.json              your campus map & directory
│       └── manifest.json, icon.svg
├── tools/mock-hub.ps1               run the app + API on a PC, no ESP32 needed
├── platformio.ini                   PlatformIO build (alternative to Arduino IDE)
└── .github/workflows/build.yml      CI: builds firmware + LittleFS image
```

## Quick start (Arduino IDE 2.x)

1. **Install the ESP32 core**: *Boards Manager* → "esp32 by Espressif Systems" (3.x).
2. **Install libraries** (*Library Manager*):
   - `ESP Async WebServer` by ESP32Async
   - `Async TCP` by ESP32Async
   - `ArduinoJson` by Benoit Blanchon (v7)
3. **Install the LittleFS upload plugin**: download the `.vsix` from [arduino-littlefs-upload](https://github.com/earlephilhower/arduino-littlefs-upload/releases), put it in `~/.arduinoIDE/plugins/` (create the folder if needed), and restart the IDE.
4. Open `firmware/CampusCompanion/CampusCompanion.ino` and edit `config.h` (at least change `ADMIN_PIN` and `AP_PASSWORD`).
5. **Tools menu**:
   - Board: **ESP32S3 Dev Module**
   - Flash Size: **8MB** (match your module)
   - Partition Scheme: **8M with spiffs (3MB APP/1.5MB SPIFFS)** (any scheme *with spiffs* works; LittleFS uses that partition)
   - PSRAM: *OPI PSRAM* for N8R8/N16R8 boards, otherwise *Disabled*
   - USB CDC On Boot: *Enabled* if you plug into the port marked **USB**, *Disabled* for the port marked **COM/UART**
6. **Upload** the sketch.
7. Close the Serial Monitor, press **Ctrl+Shift+P** → **"Upload LittleFS to Pico/ESP8266/ESP32"**. This flashes the web app.
8. On your phone, join the Wi-Fi **CampusCompanion** (password `campus1234`) and open **http://campus.local** or **http://192.168.4.1**. Many phones also pop up the page automatically through the captive portal.

## Quick start (PlatformIO)

```bash
pio run -e esp32s3 -t upload
```

```bash
pio run -e esp32s3 -t uploadfs
```

Use `-e esp32s3-n16r8` for 16 MB + PSRAM boards or `-e esp32s3-4mb` for 4 MB boards.

> ⚠️ Uploading the filesystem image **replaces the whole LittleFS partition**, including the hub's database (`/db`). Phones will re-download from the (now empty or seeded) hub automatically. Their own queued changes are kept and re-uploaded.

## Try it without hardware

The mock hub serves the same web app and implements the same sync protocol on your PC (Windows PowerShell 5.1+, or `pwsh` on macOS/Linux):

```bash
powershell -ExecutionPolicy Bypass -File tools/mock-hub.ps1
```

Then open http://localhost:8080 (admin PIN `4321`). Add `-Fresh` to start from a new database.

## Using it

- **Students**: set your name and group under *More → Me & Settings*, and Home shows *your* classes for today. Post to Lost & Found or the Notice Board even while offline.
- **Admins**: *Me & Settings → Admin*, enter the PIN. Add/edit buttons appear on News, Classes, and Events. The PIN is checked by the hub and remembered only for the current tab. Five wrong PINs lock admin login for 30 s.
- **Campus map**: edit `data/www/campus.json` (rectangles on a 400×300 grid plus walkway paths) and re-upload LittleFS.

## Offline app shell (read this)

There are two layers of "offline":

1. **Data**: always works. Records live in IndexedDB, writes queue in the outbox, and the open app keeps working when you walk out of Wi-Fi range.
2. **Opening the app with no connection at all**: this needs a *service worker*, and browsers only allow those on **HTTPS or localhost**. The hub serves plain HTTP, so on a phone the service worker is skipped. You need to be near the hub (or keep the tab open) to load the page. Your data is still on the phone and shows up instantly when the page loads.

   Ways around it, if you need a fully installable PWA:
   - Testing: in Chrome on Android, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` and add `http://192.168.4.1` and `http://campus.local`.
   - The mock hub on `localhost` already counts as secure, so the service worker works there.

## Sync API

Everything goes through one endpoint, so a phone needs one round trip per sync.

`POST /api/sync`
```json
{
  "since": 41, "after": 41, "epoch": "a1b2c3d4", "clientTime": 1791700000000, "pin": "optional",
  "ops": [
    { "col": "board", "id": "m1x2-ab12cd34", "op": "put", "data": { "body": "Hi!", "author": "Asha" }, "key": "<device owner key>" },
    { "col": "lostfound", "id": "m1x3-ffee0011", "op": "del", "key": "<device owner key>" }
  ]
}
```
Response:
```json
{
  "results": [ { "id": "m1x2-ab12cd34", "ok": true }, { "id": "m1x3-ffee0011", "ok": false, "err": "not allowed (admin PIN or owner required)" } ],
  "items": [ { "col": "board", "id": "m1x2-ab12cd34", "rev": 42, "ts": 1791700000, "body": "Hi!", "author": "Asha" } ],
  "more": false, "cursor": 42, "rev": 42, "epoch": "a1b2c3d4", "admin": false, "time": 1791700001
}
```
- `items` holds records with `rev > after`, oldest first, at most 40 per page. If `more` is true, call again with `after = cursor`.
- `reset: true` means the phone's copy may be stale (the hub was wiped, or old records were trimmed). The phone clears its downloaded data and syncs from `since = 0`.
- Collections and field limits are defined in `store.cpp` (`kSpecs`) and mirrored in `app.js` (`SCHEMA`).

`GET /api/info` returns the hub name, version, revision, record count, uptime, free heap/PSRAM, connected phones, and storage use.

## Limits & tuning

- Soft AP: up to **10 phones at once** (an ESP32 hardware limit). Phones only hold a connection for a moment while syncing, so many more people can use the hub by taking turns.
- Collections are capped (announcements 40, events 60, timetable 150, lost & found 60, board 100). When a collection is full the hub drops the oldest 20% and phones resync. Change the caps in `kSpecs`. On PSRAM boards you can raise them a lot.
- Records are saved to flash 1.5 s after the last change. Files are written to a temp file first, so a power cut doesn't corrupt them.
- Data travels over the hub's WPA2 Wi-Fi as plain HTTP. Use a strong `AP_PASSWORD` and change `ADMIN_PIN`.

## Ideas for extending

- Attendance check-in with a QR code or an RFID reader (RC522 on SPI)
- An e-paper display on the hub showing today's announcements
- Several hubs that sync with each other over ESP-NOW
- Export/import of the database for backups

## License

MIT. See [LICENSE](LICENSE).
