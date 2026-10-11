#include "store.h"

#include <LittleFS.h>

#include <algorithm>
#include <vector>

#include "config.h"

namespace {

// ---------------------------------------------------------------------------
// Schema. The first field of every collection is required. Keep in sync with
// SCHEMA in data/www/app.js.
// ---------------------------------------------------------------------------
struct FieldSpec {
  const char* name;
  char type;  // 's' = string, 'b' = bool
  uint16_t maxLen;
};

struct CollectionSpec {
  const char* name;
  bool adminOnly;  // writes need the admin PIN
  uint16_t cap;    // max records kept (oldest are dropped beyond this)
  const FieldSpec* fields;
  uint8_t fieldCount;
};

const FieldSpec kAnnouncement[] = {
    {"title", 's', 80}, {"body", 's', 600}, {"priority", 's', 10}, {"author", 's', 40}};
const FieldSpec kEvent[] = {
    {"title", 's', 80}, {"start", 's', 16}, {"end", 's', 16}, {"location", 's', 60}, {"body", 's', 400}};
const FieldSpec kClass[] = {
    {"course", 's', 60}, {"day", 's', 3},    {"start", 's', 5},    {"end", 's', 5},
    {"room", 's', 30},   {"group", 's', 20}, {"teacher", 's', 40}};
const FieldSpec kLostFound[] = {
    {"item", 's', 60}, {"kind", 's', 5}, {"location", 's', 60}, {"contact", 's', 60}, {"body", 's', 300}, {"resolved", 'b', 0}};
const FieldSpec kBoard[] = {{"body", 's', 280}, {"author", 's', 40}};

#define COUNT_OF(a) (sizeof(a) / sizeof((a)[0]))

const CollectionSpec kSpecs[] = {
    {"announcements", true, 40, kAnnouncement, COUNT_OF(kAnnouncement)},
    {"events", true, 60, kEvent, COUNT_OF(kEvent)},
    {"timetable", true, 150, kClass, COUNT_OF(kClass)},
    {"lostfound", false, 60, kLostFound, COUNT_OF(kLostFound)},
    {"board", false, 100, kBoard, COUNT_OF(kBoard)},
};
constexpr uint8_t kCount = COUNT_OF(kSpecs);
static_assert(kCount <= Store::kMaxCollections, "raise Store::kMaxCollections");

const char* const kSeed[] = {
    R"({"col":"announcements","id":"seed-ann-1","data":{"title":"Welcome to Campus Companion","body":"Connect to the CampusCompanion Wi-Fi and open http://campus.local (or 192.168.4.1). Everything works without internet - your phone keeps a copy and syncs whenever you are near the hub.","priority":"high","author":"Admin"}})",
    R"({"col":"announcements","id":"seed-ann-2","data":{"title":"Library hours extended","body":"The central library stays open until 10 PM during exam weeks.","priority":"normal","author":"Library"}})",
    R"({"col":"events","id":"seed-evt-1","data":{"title":"Tech Fest 2026","start":"2026-11-14T10:00","end":"2026-11-14T17:00","location":"Main Auditorium","body":"Project expo, robotics arena and a hackathon. Free entry."}})",
    R"({"col":"events","id":"seed-evt-2","data":{"title":"Placement talk: Embedded careers","start":"2026-10-28T14:00","end":"2026-10-28T15:30","location":"Seminar Hall 2","body":"Alumni panel on firmware and IoT roles."}})",
    R"({"col":"timetable","id":"seed-tt-1","data":{"course":"Digital Electronics","day":"Mon","start":"09:00","end":"10:00","room":"B-201","group":"CSE-A","teacher":"Dr. Rao"}})",
    R"({"col":"timetable","id":"seed-tt-2","data":{"course":"Data Structures","day":"Mon","start":"10:15","end":"11:15","room":"B-204","group":"CSE-A","teacher":"Prof. Iyer"}})",
    R"({"col":"timetable","id":"seed-tt-3","data":{"course":"Microcontrollers Lab","day":"Tue","start":"11:30","end":"13:30","room":"Lab-3","group":"CSE-A","teacher":"Dr. Khan"}})",
    R"({"col":"timetable","id":"seed-tt-4","data":{"course":"Mathematics III","day":"Wed","start":"09:00","end":"10:00","room":"A-105","group":"CSE-A","teacher":"Prof. Menon"}})",
    R"({"col":"timetable","id":"seed-tt-5","data":{"course":"Operating Systems","day":"Thu","start":"10:15","end":"11:15","room":"B-204","group":"CSE-A","teacher":"Dr. Paul"}})",
    R"({"col":"timetable","id":"seed-tt-6","data":{"course":"Computer Networks","day":"Fri","start":"12:00","end":"13:00","room":"B-201","group":"CSE-A","teacher":"Prof. Das"}})",
    R"({"col":"timetable","id":"seed-tt-7","data":{"course":"Data Structures","day":"Mon","start":"09:00","end":"10:00","room":"B-205","group":"CSE-B","teacher":"Prof. Iyer"}})",
    R"({"col":"timetable","id":"seed-tt-8","data":{"course":"Digital Electronics","day":"Tue","start":"09:00","end":"10:00","room":"B-201","group":"CSE-B","teacher":"Dr. Rao"}})",
    R"({"col":"lostfound","id":"seed-lf-1","data":{"item":"Blue water bottle","kind":"found","location":"Canteen","contact":"Front desk","body":"Steel bottle with stickers."}})",
    R"({"col":"board","id":"seed-brd-1","data":{"body":"Anyone up for a study group for the Microcontrollers lab exam? Library, Thursday 5 PM.","author":"Asha"}})",
};

int findCollection(const char* name) {
  for (uint8_t i = 0; i < kCount; i++)
    if (strcmp(kSpecs[i].name, name) == 0) return i;
  return -1;
}

bool validId(const char* id) {
  size_t n = strlen(id);
  if (n < 4 || n > 40) return false;
  for (size_t i = 0; i < n; i++)
    if (!isalnum((unsigned char)id[i]) && id[i] != '-' && id[i] != '_') return false;
  return true;
}

// Trims whitespace and cuts to maxLen bytes without splitting a UTF-8 sequence.
String clip(const char* s, uint16_t maxLen) {
  String v(s);
  v.trim();
  if (v.length() > maxLen) {
    size_t n = maxLen;
    while (n > 0 && (v[n] & 0xC0) == 0x80) n--;
    v.remove(n);
  }
  return v;
}

int findItem(JsonArray arr, const char* id) {
  int i = 0;
  for (JsonObject it : arr) {
    if (strcmp(it["id"] | "", id) == 0) return i;
    i++;
  }
  return -1;
}

String pathFor(const char* name) { return String("/db/") + name + ".json"; }

// Write to a temp file first so a power cut never leaves a half-written file.
bool writeFile(const String& path, const String& body) {
  String tmp = path + ".tmp";
  File f = LittleFS.open(tmp, "w");
  if (!f) return false;
  size_t n = f.print(body);
  f.close();
  if (n != body.length()) {
    LittleFS.remove(tmp);
    return false;
  }
  LittleFS.remove(path);
  return LittleFS.rename(tmp, path);
}

bool readFile(const String& path, JsonDocument& doc) {
  String p = path;
  if (!LittleFS.exists(p)) {
    p += ".tmp";  // power was lost between remove() and rename()
    if (!LittleFS.exists(p)) return false;
  }
  File f = LittleFS.open(p, "r");
  if (!f) return false;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) Serial.printf("[store] %s: %s\n", p.c_str(), err.c_str());
  return !err;
}

}  // namespace

bool Store::begin(bool seedIfEmpty) {
  if (!LittleFS.begin(true)) {
    Serial.println("[store] LittleFS mount failed");
    return false;
  }
  if (!LittleFS.exists("/db")) LittleFS.mkdir("/db");

  bool fresh = !loadMeta();
  for (uint8_t c = 0; c < kCount; c++) {
    if (fresh || !readFile(pathFor(kSpecs[c].name), docs_[c]) || !docs_[c].is<JsonArray>()) {
      docs_[c].clear();
      docs_[c].to<JsonArray>();
    }
  }
  if (fresh) {
    snprintf(epoch_, sizeof(epoch_), "%08lx", (unsigned long)esp_random());
    metaDirty_ = anyDirty_ = true;
    if (seedIfEmpty) seed();
    Serial.printf("[store] new store, epoch %s\n", epoch_);
  }
  Serial.printf("[store] rev %lu, %u records\n", (unsigned long)rev_, (unsigned)itemCount());
  return true;
}

bool Store::loadMeta() {
  JsonDocument meta;
  if (!readFile("/db/meta.json", meta)) return false;
  const char* e = meta["epoch"] | "";
  if (strlen(e) != 8) return false;
  strlcpy(epoch_, e, sizeof(epoch_));
  rev_ = meta["rev"] | 0;
  lastPurgeAt_ = meta["purge"] | 0;
  return true;
}

void Store::seed() {
  for (const char* json : kSeed) {
    JsonDocument op;
    if (!deserializeJson(op, json)) apply(op.as<JsonObjectConst>(), true, 0);
  }
}

void Store::markDirty(uint8_t col) {
  dirty_[col] = metaDirty_ = anyDirty_ = true;
  lastChange_ = millis();
}

OpResult Store::apply(JsonObjectConst op, bool admin, uint32_t now) {
  int c = findCollection(op["col"] | "");
  if (c < 0) return OpResult::UNKNOWN_COLLECTION;
  const CollectionSpec& spec = kSpecs[c];
  if (spec.adminOnly && !admin) return OpResult::FORBIDDEN;

  const char* id = op["id"] | "";
  if (!validId(id)) return OpResult::BAD_REQUEST;
  const char* key = op["key"] | "";
  bool isDelete = strcmp(op["op"] | "put", "del") == 0;

  JsonArray arr = docs_[c].as<JsonArray>();
  int idx = findItem(arr, id);
  JsonObject item;
  if (idx >= 0) item = arr[idx];
  bool exists = idx >= 0;
  bool tombstone = exists && (item["deleted"] | false);

  if (isDelete && (!exists || tombstone)) return OpResult::OK;  // already gone

  // Public records can only be changed by the device that created them
  // (it proves this with its private owner key) or by an admin.
  if (exists && !admin) {
    const char* owner = item["_k"] | "";
    if (tombstone || !*owner || strcmp(owner, key) != 0) return OpResult::FORBIDDEN;
  }

  if (isDelete) {
    item.clear();
    item["id"] = String(id);
    item["rev"] = ++rev_;
    item["deleted"] = true;
    markDirty(c);
    return OpResult::OK;
  }

  JsonObjectConst data = op["data"];
  if (data.isNull()) return OpResult::BAD_REQUEST;
  if (clip(data[spec.fields[0].name] | "", spec.fields[0].maxLen).isEmpty()) return OpResult::INVALID;

  uint32_t created = exists ? (item["ts"] | now) : now;
  String owner = exists ? String(item["_k"] | "") : clip(key, 40);

  if (exists) {
    item.clear();
  } else {
    if (arr.size() >= spec.cap) trim(c);
    item = arr.add<JsonObject>();
  }
  item["id"] = String(id);
  item["rev"] = ++rev_;
  item["ts"] = created;
  if (!spec.adminOnly && owner.length()) item["_k"] = owner;

  for (uint8_t i = 0; i < spec.fieldCount; i++) {
    const FieldSpec& f = spec.fields[i];
    JsonVariantConst v = data[f.name];
    if (f.type == 's' && v.is<const char*>()) {
      String s = clip(v.as<const char*>(), f.maxLen);
      if (s.length()) item[f.name] = s;
    } else if (f.type == 'b' && v.is<bool>()) {
      item[f.name] = v.as<bool>();
    }
  }
  markDirty(c);
  return OpResult::OK;
}

// Drops records down to 80% of the cap (tombstones first, then oldest) so
// trimming - which forces clients into a full resync - happens rarely.
void Store::trim(uint8_t c) {
  JsonArray arr = docs_[c].as<JsonArray>();
  size_t target = kSpecs[c].cap * 4 / 5;
  while (arr.size() > target) {
    int victim = -1, i = 0;
    uint32_t best = UINT32_MAX;
    bool victimIsTomb = false;
    for (JsonObject it : arr) {
      bool tomb = it["deleted"] | false;
      uint32_t r = it["rev"] | 0;
      if ((tomb && !victimIsTomb) || (tomb == victimIsTomb && r < best)) {
        victim = i;
        best = r;
        victimIsTomb = tomb;
      }
      i++;
    }
    arr.remove(victim);
  }
  lastPurgeAt_ = rev_ + 1;
  Serial.printf("[store] trimmed %s to %u records\n", kSpecs[c].name, (unsigned)arr.size());
}

bool Store::collect(uint32_t after, uint16_t limit, JsonArray out, uint32_t& cursor) {
  struct Ref {
    uint32_t rev;
    uint8_t col;
    uint16_t idx;
  };
  std::vector<Ref> refs;
  for (uint8_t c = 0; c < kCount; c++) {
    uint16_t i = 0;
    for (JsonObject it : docs_[c].as<JsonArray>()) {
      uint32_t r = it["rev"] | 0;
      if (r > after) refs.push_back({r, c, i});
      i++;
    }
  }
  std::sort(refs.begin(), refs.end(), [](const Ref& a, const Ref& b) { return a.rev < b.rev; });

  bool more = refs.size() > limit;
  size_t n = more ? limit : refs.size();
  for (size_t k = 0; k < n; k++) {
    JsonObject src = docs_[refs[k].col][refs[k].idx];
    JsonObject o = out.add<JsonObject>();
    o["col"] = kSpecs[refs[k].col].name;
    for (JsonPair kv : src) {
      if (strcmp(kv.key().c_str(), "_k") == 0) continue;  // owner keys never leave the hub
      o[kv.key()] = kv.value();
    }
  }
  cursor = more ? refs[n - 1].rev : rev_;
  return more;
}

bool Store::needsReset(uint32_t since, const char* epoch) const {
  if (since == 0) return false;
  return strcmp(epoch ? epoch : "", epoch_) != 0 || since < lastPurgeAt_ || since > rev_;
}

size_t Store::itemCount() {
  size_t n = 0;
  for (uint8_t c = 0; c < kCount; c++) n += docs_[c].as<JsonArray>().size();
  return n;
}

void Store::loop() {
  bool flags[kMaxCollections];
  bool meta;
  {
    std::lock_guard<std::mutex> g(mutex_);
    if (!anyDirty_ || millis() - lastChange_ < 1500) return;
    anyDirty_ = false;
    memcpy(flags, dirty_, sizeof(flags));
    meta = metaDirty_;
  }

  for (uint8_t c = 0; c < kCount; c++) {
    if (!flags[c]) continue;
    String body;
    {
      std::lock_guard<std::mutex> g(mutex_);
      // Rebuild the document so memory from removed/replaced values is reclaimed.
      JsonDocument fresh;
      fresh.set(docs_[c]);
      docs_[c] = std::move(fresh);
      serializeJson(docs_[c], body);
      dirty_[c] = false;
    }
    if (!writeFile(pathFor(kSpecs[c].name), body))
      Serial.printf("[store] failed to save %s\n", kSpecs[c].name);
  }

  if (meta) {
    String body;
    {
      std::lock_guard<std::mutex> g(mutex_);
      JsonDocument m;
      m["epoch"] = epoch_;
      m["rev"] = rev_;
      m["purge"] = lastPurgeAt_;
      serializeJson(m, body);
      metaDirty_ = false;
    }
    writeFile("/db/meta.json", body);
  }
}

const char* Store::describe(OpResult r) {
  switch (r) {
    case OpResult::OK: return "ok";
    case OpResult::BAD_REQUEST: return "malformed request";
    case OpResult::UNKNOWN_COLLECTION: return "unknown collection";
    case OpResult::FORBIDDEN: return "not allowed (admin PIN or owner required)";
    case OpResult::INVALID: return "required field is empty";
  }
  return "error";
}
