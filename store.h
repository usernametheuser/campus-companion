#pragma once
// Revision-based record store persisted to LittleFS.
//
// Every write bumps a global revision counter and stamps the record with it.
// Clients pull "everything with rev > N", so sync is incremental and cheap.
// Deletes become tombstones so other clients learn about them.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <mutex>

enum class OpResult : uint8_t { OK, BAD_REQUEST, UNKNOWN_COLLECTION, FORBIDDEN, INVALID };

class Store {
 public:
  static constexpr uint8_t kMaxCollections = 8;

  bool begin(bool seedIfEmpty);
  void loop();  // writes changed collections to flash (debounced); call from loop()

  std::mutex& lock() { return mutex_; }

  // ---- The functions below expect the caller to hold lock() ----
  OpResult apply(JsonObjectConst op, bool admin, uint32_t now);
  // Copies records with rev > after (oldest first) into out. Returns true if
  // more pages remain; cursor receives the value to pass as `after` next time.
  bool collect(uint32_t after, uint16_t limit, JsonArray out, uint32_t& cursor);
  // True when a client that last synced at `since` may hold records the hub
  // has since dropped (cap trimming) or belongs to a wiped/re-flashed store.
  bool needsReset(uint32_t since, const char* epoch) const;
  uint32_t rev() const { return rev_; }
  const char* epoch() const { return epoch_; }
  size_t itemCount();

  static const char* describe(OpResult r);

 private:
  JsonDocument docs_[kMaxCollections];
  bool dirty_[kMaxCollections] = {};
  bool metaDirty_ = false;
  bool anyDirty_ = false;
  uint32_t lastChange_ = 0;
  uint32_t rev_ = 0;
  uint32_t lastPurgeAt_ = 0;
  char epoch_[9] = {0};
  std::mutex mutex_;

  void markDirty(uint8_t col);
  void trim(uint8_t col);
  void seed();
  bool loadMeta();
};
