#define NAPI_VERSION 10

#include <assert.h>
#include <napi-macros.h>
#include <node_api.h>

#include <rocksdb/cache.h>
#include <rocksdb/comparator.h>
#include <rocksdb/convenience.h>
#include <rocksdb/db.h>
#include <rocksdb/env.h>
#include <rocksdb/filter_policy.h>
#include <rocksdb/merge_operator.h>
#include <rocksdb/options.h>
#include <rocksdb/slice.h>
#include <rocksdb/slice_transform.h>
#include <rocksdb/statistics.h>
#include <rocksdb/status.h>
#include <rocksdb/table.h>
#include <rocksdb/write_batch.h>
#include <rocksdb/write_buffer_manager.h>

#include <re2/re2.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef __linux__
#include <sys/syscall.h>
#include <unistd.h>

#include <cerrno>

// Older libc headers may lack the SYS_ alias for io_uring_setup even though
// the kernel number (__NR_) is available — keep the Linux probe a boolean.
#if !defined(SYS_io_uring_setup) && defined(__NR_io_uring_setup)
#define SYS_io_uring_setup __NR_io_uring_setup
#endif
#endif

#include "max_rev_operator.h"
#include "util.h"

static const napi_type_tag kStatisticsTypeTag = {0x0d186ac9202c4fe5, 0xa6c8045ce0bb653d};

enum ResourceName {
  ResourceIteratorNextv = 0,
  ResourceLeveldownOpen,
  ResourceLeveldownClose,
  ResourceLeveldownGetMany,
  ResourceLeveldownFlushWal,
  ResourceLeveldownIteratorSeek,
  ResourceLeveldownBatchWrite,
  ResourceLeveldownUpdatesSince,
  ResourceLeveldownCompactRange,
  ResourceLeveldownClear,
  ResourceNameCount
};

class NullLogger : public rocksdb::Logger {
 public:
  using rocksdb::Logger::Logv;
  virtual void Logv(const char* format, va_list ap) override {}
  virtual size_t GetLogFileSize() const override { return 0; }
};

struct Database;
struct DatabaseReference;
struct DatabaseOperation;
struct ColumnReference;
class Iterator;
struct Updates;

class HandleIds final {
 public:
  static HandleIds& Instance() {
    // Process lifetime is intentional for the same reason as HandleRegistry:
    // addon statics can be torn down before worker environments finish.
    static auto* ids = new HandleIds();
    return *ids;
  }

  uint64_t Acquire() {
    std::lock_guard lock(mutex_);
    while (next_ == 0 || live_.contains(next_)) {
      ++next_;
    }
    const auto id = next_++;
    live_.insert(id);
    return id;
  }

  void Release(uint64_t id) {
    if (id == 0) return;
    std::lock_guard lock(mutex_);
    live_.erase(id);
  }

 private:
  std::mutex mutex_;
  uint64_t next_ = 1;
  std::set<uint64_t> live_;
};

template <typename T>
class HandleRegistry final {
 public:
  static HandleRegistry& Instance() {
    // Process lifetime is intentional: addon statics can otherwise be torn down
    // before the last worker environment releases its native references.
    static auto* registry = new HandleRegistry();
    return *registry;
  }

  uint64_t Insert(const std::shared_ptr<T>& value) {
    std::lock_guard lock(mutex_);
    // IDs share one process-wide namespace. A DB handle must never alias a
    // cache or write-buffer-manager handle merely because each resource type
    // happened to allocate its first entry.
    const auto id = HandleIds::Instance().Acquire();
    values_.emplace(id, value);
    return id;
  }

  std::shared_ptr<T> Lookup(uint64_t id) {
    std::lock_guard lock(mutex_);
    const auto found = values_.find(id);
    if (found == values_.end()) {
      return {};
    }

    auto value = found->second.lock();
    if (!value) {
      values_.erase(found);
      HandleIds::Instance().Release(id);
    }
    return value;
  }

  void Erase(uint64_t id, const T* expected) {
    std::lock_guard lock(mutex_);
    const auto found = values_.find(id);
    if (found == values_.end()) {
      return;
    }

    const auto value = found->second.lock();
    if (!value || value.get() == expected) {
      values_.erase(found);
      HandleIds::Instance().Release(id);
    }
  }

 private:
  std::mutex mutex_;
  std::unordered_map<uint64_t, std::weak_ptr<T>> values_;
};

struct ColumnFamily {
  rocksdb::ColumnFamilyHandle* handle;
  rocksdb::ColumnFamilyDescriptor descriptor;
};

struct Closable {
  virtual ~Closable() {}
  // Called with the owning reference's resources mutex held. Implementations must only
  // release their RocksDB resources and must not call back into Database.
  virtual rocksdb::Status CloseResources() = 0;
  std::atomic<bool> closed{false};
};

struct ColumnSnapshot final {
  std::string name;
  int32_t id;
};

struct OpenSnapshot final {
  uint64_t generation = 0;
  std::vector<ColumnSnapshot> columns;
};

struct Database final {
  enum class State { Closed, Opening, Open, Closing };

  Database(std::string location) : location(std::move(location)) {}
  ~Database() {
    HandleRegistry<Database>::Instance().Erase(handle, this);
    assert(!db);
  }

  rocksdb::Status Reserve(const std::shared_ptr<DatabaseReference>& reference);
  rocksdb::Status Open(const std::shared_ptr<DatabaseReference>& reference,
                       const rocksdb::Options& options,
                       const std::vector<rocksdb::ColumnFamilyDescriptor>& descriptors,
                       OpenSnapshot& snapshot);
  rocksdb::Status Dispose(const std::shared_ptr<DatabaseReference>& reference);
  rocksdb::Status Close(const std::shared_ptr<DatabaseReference>& reference);
  rocksdb::Status Attach(const std::shared_ptr<DatabaseReference>& reference, Closable* closable);
  rocksdb::Status Close(const std::shared_ptr<DatabaseReference>& reference, Closable* closable);
  std::shared_ptr<DatabaseOperation> BeginOperation(const std::shared_ptr<DatabaseReference>& reference);
  void EndOperation(const std::shared_ptr<DatabaseReference>& reference);
  bool IsOpen(const std::shared_ptr<DatabaseReference>& reference) const;

  rocksdb::ColumnFamilyHandle* ResolveColumn(uint64_t generation, int32_t id) const {
    std::lock_guard lock(stateMutex_);
    if (state_ != State::Open || generation != generation_) {
      return nullptr;
    }

    const auto found = columns.find(id);
    return found == columns.end() ? nullptr : found->second.handle;
  }

  const std::string location;
  uint64_t handle = 0;

  std::unique_ptr<rocksdb::DB> db;
  std::map<int32_t, ColumnFamily> columns;
  // Optional DB-wide statistics, either created for legacy `statistics: true`
  // or shared with other DBs through a RocksStatistics resource. Each DB keeps
  // its own shared_ptr copy so the native collector outlives the JS resource.
  std::shared_ptr<rocksdb::Statistics> statistics;
 private:
  bool DescriptorsMatchLocked(const std::vector<rocksdb::ColumnFamilyDescriptor>& descriptors) const {
    if (descriptors.empty()) {
      return true;
    }
    if (descriptors.size() != columns.size()) {
      return false;
    }
    for (const auto& descriptor : descriptors) {
      bool found = false;
      for (const auto& [id, column] : columns) {
        if (column.descriptor.name == descriptor.name) {
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  }

  void SnapshotLocked(OpenSnapshot& snapshot) const {
    snapshot.generation = generation_;
    snapshot.columns.clear();
    snapshot.columns.reserve(columns.size());
    for (const auto& [id, column] : columns) {
      snapshot.columns.push_back({column.descriptor.name, id});
    }
  }

  mutable std::mutex stateMutex_;
  std::condition_variable stateChanged_;
  State state_ = State::Closed;
  size_t openReferences_ = 0;
  uint64_t generation_ = 0;
};

struct DatabaseReference final {
  enum class Phase { Inactive, Reserved, Open, Closing };

  explicit DatabaseReference(std::shared_ptr<Database> database) : database(std::move(database)) {}

  std::shared_ptr<Database> database;
  Phase phase = Phase::Inactive;
  uint64_t generation = 0;
  std::mutex resourcesMutex;
  std::set<Closable*> resources;
  std::mutex operationsMutex;
  std::condition_variable operationsChanged;
  size_t activeOperations = 0;
};

struct DatabaseOperation final {
  explicit DatabaseOperation(std::shared_ptr<DatabaseReference> reference) : reference(std::move(reference)) {}
  ~DatabaseOperation() { Finish(); }

  void Finish() {
    if (active.exchange(false)) {
      reference->database->EndOperation(reference);
    }
  }

  std::shared_ptr<DatabaseReference> reference;
  std::atomic<bool> active{false};
};

struct DatabaseOperationScope final {
  explicit DatabaseOperationScope(std::shared_ptr<DatabaseOperation> operation)
      : operation(std::move(operation)) {}
  ~DatabaseOperationScope() { operation->Finish(); }

  std::shared_ptr<DatabaseOperation> operation;
};

std::shared_ptr<DatabaseOperation> Database::BeginOperation(
    const std::shared_ptr<DatabaseReference>& reference) {
  auto operation = std::make_shared<DatabaseOperation>(reference);
  std::lock_guard stateLock(stateMutex_);
  if (state_ != State::Open || reference->phase != DatabaseReference::Phase::Open ||
      reference->generation != generation_) {
    return {};
  }

  std::lock_guard operationsLock(reference->operationsMutex);
  ++reference->activeOperations;
  operation->active.store(true);
  return operation;
}

void Database::EndOperation(const std::shared_ptr<DatabaseReference>& reference) {
  std::lock_guard lock(reference->operationsMutex);
  assert(reference->activeOperations > 0);
  if (--reference->activeOperations == 0) {
    reference->operationsChanged.notify_all();
  }
}

rocksdb::Status Database::Reserve(const std::shared_ptr<DatabaseReference>& reference) {
  std::lock_guard lock(stateMutex_);
  if (state_ != State::Open || reference->phase != DatabaseReference::Phase::Inactive) {
    return rocksdb::Status::InvalidArgument("Invalid or stale database handle");
  }

  reference->phase = DatabaseReference::Phase::Reserved;
  reference->generation = generation_;
  ++openReferences_;
  return rocksdb::Status::OK();
}

rocksdb::Status Database::Open(const std::shared_ptr<DatabaseReference>& reference,
                               const rocksdb::Options& options,
                               const std::vector<rocksdb::ColumnFamilyDescriptor>& descriptors,
                               OpenSnapshot& snapshot) {
  std::unique_lock lock(stateMutex_);
  stateChanged_.wait(lock, [&] {
    return state_ != State::Opening && state_ != State::Closing &&
           reference->phase != DatabaseReference::Phase::Closing;
  });

  if (reference->phase == DatabaseReference::Phase::Reserved) {
    if (state_ != State::Open || reference->generation != generation_) {
      lock.unlock();
      // Release through the full close path. This reservation may be the last
      // lease if its source wrapper closed after exporting the handle.
      Close(reference);
      return rocksdb::Status::InvalidArgument("Reserved database handle became stale");
    }
    if (!DescriptorsMatchLocked(descriptors)) {
      lock.unlock();
      Close(reference);
      return rocksdb::Status::InvalidArgument("Column families do not match the open database handle");
    }
    reference->phase = DatabaseReference::Phase::Open;
    SnapshotLocked(snapshot);
    return rocksdb::Status::OK();
  }

  if (state_ == State::Open) {
    if (!DescriptorsMatchLocked(descriptors)) {
      return rocksdb::Status::InvalidArgument("Column families do not match the open database handle");
    }
    if (reference->phase == DatabaseReference::Phase::Inactive) {
      reference->phase = DatabaseReference::Phase::Open;
      reference->generation = generation_;
      ++openReferences_;
    }
    SnapshotLocked(snapshot);
    return rocksdb::Status::OK();
  }

  state_ = State::Opening;
  lock.unlock();

  std::unique_ptr<rocksdb::DB> openedDb;
  std::vector<rocksdb::ColumnFamilyHandle*> handles;
  rocksdb::Status status;
  std::map<int32_t, ColumnFamily> openedColumns;
  const auto cleanupOpened = [&] {
    if (!openedDb) return;
    for (auto* handle : handles) {
      openedDb->DestroyColumnFamilyHandle(handle);
    }
    openedDb->Close();
    openedDb.reset();
  };

  try {
    status = descriptors.empty()
                 ? rocksdb::DB::Open(options, location, &openedDb)
                 : rocksdb::DB::Open(options, location, descriptors, &handles, &openedDb);

    if (status.ok()) {
      for (size_t n = 0; n < handles.size(); ++n) {
        ColumnFamily column{handles[n], descriptors[n]};
        openedColumns.emplace(column.handle->GetID(), std::move(column));
      }
    } else {
      cleanupOpened();
    }
  } catch (...) {
    cleanupOpened();
    lock.lock();
    state_ = State::Closed;
    stateChanged_.notify_all();
    throw;
  }

  lock.lock();
  if (!status.ok()) {
    state_ = State::Closed;
    stateChanged_.notify_all();
    return status;
  }

  db = std::move(openedDb);
  columns = std::move(openedColumns);
  statistics = options.statistics;
  ++generation_;
  reference->phase = DatabaseReference::Phase::Open;
  reference->generation = generation_;
  ++openReferences_;
  state_ = State::Open;
  SnapshotLocked(snapshot);
  stateChanged_.notify_all();
  return rocksdb::Status::OK();
}

rocksdb::Status Database::Dispose(const std::shared_ptr<DatabaseReference>& reference) {
  {
    std::lock_guard lock(stateMutex_);
    if (reference->phase == DatabaseReference::Phase::Inactive) {
      return rocksdb::Status::OK();
    }
    if (reference->phase != DatabaseReference::Phase::Reserved) {
      return rocksdb::Status::InvalidArgument("Only an unopened database reservation can be disposed");
    }
  }

  // A Reserved reference cannot own operations or resources, so synchronous
  // close cannot wait on the JS event loop. Reuse the normal last-lease path
  // so a source wrapper that closed after Reserve() does not leave an open DB
  // behind when this constructor reservation is the final lease.
  return Close(reference);
}

rocksdb::Status Database::Close(const std::shared_ptr<DatabaseReference>& reference) {
  std::unique_lock lock(stateMutex_);
  stateChanged_.wait(lock, [&] { return state_ != State::Opening && state_ != State::Closing; });
  if (reference->phase == DatabaseReference::Phase::Inactive) {
    return rocksdb::Status::OK();
  }
  if (reference->phase == DatabaseReference::Phase::Closing) {
    stateChanged_.wait(lock, [&] { return reference->phase == DatabaseReference::Phase::Inactive; });
    return rocksdb::Status::OK();
  }

  reference->phase = DatabaseReference::Phase::Closing;
  lock.unlock();
  {
    std::unique_lock operationsLock(reference->operationsMutex);
    reference->operationsChanged.wait(operationsLock, [&] { return reference->activeOperations == 0; });
  }
  lock.lock();

  rocksdb::Status status = rocksdb::Status::OK();
  {
    std::lock_guard resourcesLock(reference->resourcesMutex);
    for (auto* closable : reference->resources) {
      const auto closeStatus = closable->CloseResources();
      if (status.ok() && !closeStatus.ok()) {
        status = closeStatus;
      }
      closable->closed = true;
    }
    reference->resources.clear();
  }

  assert(openReferences_ > 0);
  if (--openReferences_ > 0) {
    reference->phase = DatabaseReference::Phase::Inactive;
    reference->generation = 0;
    stateChanged_.notify_all();
    return status;
  }

  state_ = State::Closing;
  auto closingDb = std::move(db);
  auto closingColumns = std::move(columns);
  statistics.reset();
  reference->phase = DatabaseReference::Phase::Inactive;
  reference->generation = 0;
  lock.unlock();

  if (closingDb) {
    const auto flushStatus = closingDb->FlushWAL(true);
    if (status.ok() && !flushStatus.ok()) {
      status = flushStatus;
    }
    for (auto& [id, column] : closingColumns) {
      const auto destroyStatus = closingDb->DestroyColumnFamilyHandle(column.handle);
      if (status.ok() && !destroyStatus.ok()) {
        status = destroyStatus;
      }
    }
    const auto closeStatus = closingDb->Close();
    if (status.ok() && !closeStatus.ok()) {
      status = closeStatus;
    }
  }

  lock.lock();
  state_ = State::Closed;
  stateChanged_.notify_all();
  return status;
}

rocksdb::Status Database::Attach(const std::shared_ptr<DatabaseReference>& reference, Closable* closable) {
  std::lock_guard lock(stateMutex_);
  if (state_ != State::Open || reference->phase != DatabaseReference::Phase::Open ||
      reference->generation != generation_) {
    return rocksdb::Status::InvalidArgument("Database reference is not open");
  }

  std::lock_guard resourcesLock(reference->resourcesMutex);
  closable->closed = false;
  reference->resources.insert(closable);
  return rocksdb::Status::OK();
}

rocksdb::Status Database::Close(const std::shared_ptr<DatabaseReference>& reference, Closable* closable) {
  std::lock_guard lock(reference->resourcesMutex);
  if (reference->resources.erase(closable) == 0) {
    return rocksdb::Status::OK();
  }
  const auto status = closable->CloseResources();
  closable->closed = true;
  return status;
}

bool Database::IsOpen(const std::shared_ptr<DatabaseReference>& reference) const {
  std::lock_guard lock(stateMutex_);
  return state_ == State::Open && reference->phase == DatabaseReference::Phase::Open &&
         reference->generation == generation_;
}

static constexpr napi_type_tag kDatabaseReferenceTag = {0x5fe2d764a8c6f421ULL, 0xbdd04ba698b447f1ULL};
static constexpr napi_type_tag kColumnReferenceTag = {0xc4fcf39734fb4693ULL, 0x96db693318eb1eefULL};
static constexpr napi_type_tag kCacheReferenceTag = {0x7c82100adab849d8ULL, 0xa886cf25f7aa67b9ULL};
static constexpr napi_type_tag kWriteBufferManagerReferenceTag = {0xd56882e435534041ULL, 0xba305fd0b052410dULL};
static constexpr napi_type_tag kBatchReferenceTag = {0x2704d07e44e34ccbULL, 0x853fe5f671d43337ULL};
static constexpr napi_type_tag kIteratorReferenceTag = {0xf049eb952c784fb0ULL, 0xa445cf59cc65f035ULL};
static constexpr napi_type_tag kUpdatesReferenceTag = {0xe254e64dfaa9406bULL, 0xb39789f927b49ef5ULL};

static napi_status GetResourceName(napi_env env, ResourceName name, napi_value& result) {
  static constexpr const char* names[] = {
      "iterator.nextv",        "leveldown.open",         "leveldown.close",
      "leveldown.get_many",    "leveldown.flush_wal",    "leveldown.iterator_seek",
      "leveldown.batch_write", "leveldown.updates_since", "leveldown.compact_range",
      "leveldown.clear"};
  static_assert(std::size(names) == ResourceNameCount);
  return napi_create_string_utf8(env, names[name], NAPI_AUTO_LENGTH, &result);
}

static napi_status GetDatabaseReference(napi_env env,
                                        napi_value value,
                                        std::shared_ptr<DatabaseReference>& result) {
  bool matches = false;
  NAPI_STATUS_RETURN(napi_check_object_type_tag(env, value, &kDatabaseReferenceTag, &matches));
  if (!matches) {
    return napi_invalid_arg;
  }

  std::shared_ptr<DatabaseReference>* holder;
  NAPI_STATUS_RETURN(napi_get_value_external(env, value, reinterpret_cast<void**>(&holder)));
  if (!holder || !*holder) {
    return napi_invalid_arg;
  }
  result = *holder;
  return napi_ok;
}

static napi_status GetDatabase(napi_env env,
                               napi_value value,
                               Database*& database,
                               std::shared_ptr<DatabaseReference>* reference = nullptr,
                               bool requireOpen = true) {
  std::shared_ptr<DatabaseReference> databaseReference;
  NAPI_STATUS_RETURN(GetDatabaseReference(env, value, databaseReference));
  if (requireOpen && !databaseReference->database->IsOpen(databaseReference)) {
    napi_throw_error(env, "LEVEL_DATABASE_NOT_OPEN", "Database is not open");
    return napi_pending_exception;
  }
  database = databaseReference->database.get();
  if (reference) {
    *reference = std::move(databaseReference);
  }
  return napi_ok;
}

static napi_status BeginDatabaseOperation(napi_env env,
                                          Database* database,
                                          const std::shared_ptr<DatabaseReference>& reference,
                                          std::shared_ptr<DatabaseOperation>& result) {
  result = database->BeginOperation(reference);
  if (!result) {
    napi_throw_error(env, "LEVEL_DATABASE_NOT_OPEN", "Database is not open");
    return napi_pending_exception;
  }
  return napi_ok;
}

template <typename T>
struct SharedResource final {
  explicit SharedResource(std::shared_ptr<T> value) : value(std::move(value)) {}
  ~SharedResource() { HandleRegistry<SharedResource<T>>::Instance().Erase(handle, this); }

  std::shared_ptr<T> value;
  uint64_t handle = 0;
};

using CacheResource = SharedResource<rocksdb::Cache>;
using WriteBufferManagerResource = SharedResource<rocksdb::WriteBufferManager>;

static std::shared_ptr<CacheResource> RegisterCache(std::shared_ptr<rocksdb::Cache> value) {
  auto resource = std::make_shared<CacheResource>(std::move(value));
  resource->handle = HandleRegistry<CacheResource>::Instance().Insert(resource);
  return resource;
}

static std::shared_ptr<WriteBufferManagerResource> RegisterWriteBufferManager(
    std::shared_ptr<rocksdb::WriteBufferManager> value) {
  auto resource = std::make_shared<WriteBufferManagerResource>(std::move(value));
  resource->handle = HandleRegistry<WriteBufferManagerResource>::Instance().Insert(resource);
  return resource;
}

template <typename Resource>
static napi_status CreateResourceExternal(napi_env env,
                                          const std::shared_ptr<Resource>& resource,
                                          const napi_type_tag& tag,
                                          napi_value& result) {
  auto holder = std::make_unique<std::shared_ptr<Resource>>(resource);
  NAPI_STATUS_RETURN(
      napi_create_external(env, holder.get(), Finalize<std::shared_ptr<Resource>>, holder.get(), &result));
  holder.release();
  return napi_type_tag_object(env, result, &tag);
}

template <typename Resource>
static napi_status GetResourceExternal(napi_env env,
                                       napi_value value,
                                       const napi_type_tag& tag,
                                       std::shared_ptr<Resource>& result) {
  bool matches = false;
  NAPI_STATUS_RETURN(napi_check_object_type_tag(env, value, &tag, &matches));
  if (!matches) {
    return napi_invalid_arg;
  }

  std::shared_ptr<Resource>* holder;
  NAPI_STATUS_RETURN(napi_get_value_external(env, value, reinterpret_cast<void**>(&holder)));
  if (!holder || !*holder) {
    return napi_invalid_arg;
  }
  result = *holder;
  return napi_ok;
}

template <typename Resource>
static napi_status LookupResourceHandle(napi_env env,
                                        napi_value value,
                                        HandleRegistry<Resource>& registry,
                                        std::shared_ptr<Resource>& result) {
  napi_valuetype type;
  NAPI_STATUS_RETURN(napi_typeof(env, value, &type));
  if (type == napi_object) {
    napi_value handle;
    NAPI_STATUS_RETURN(napi_get_named_property(env, value, "handle", &handle));
    value = handle;
  } else if (type != napi_bigint) {
    return napi_invalid_arg;
  }

  uint64_t id;
  bool lossless = false;
  NAPI_STATUS_RETURN(napi_get_value_bigint_uint64(env, value, &id, &lossless));
  if (!lossless || !(result = registry.Lookup(id))) {
    return napi_invalid_arg;
  }
  return napi_ok;
}

struct ColumnReference final {
  ColumnReference(const std::shared_ptr<Database>& database, uint64_t generation, int32_t id)
      : database(database), generation(generation), id(id) {}

  std::weak_ptr<Database> database;
  const uint64_t generation;
  const int32_t id;
};

static napi_status CreateColumnsObject(napi_env env,
                                       const std::shared_ptr<Database>& database,
                                       const OpenSnapshot& snapshot,
                                       napi_value* result) {
  NAPI_STATUS_RETURN(napi_create_object(env, result));

  for (const auto& column : snapshot.columns) {
    auto columnReference = std::make_unique<ColumnReference>(database, snapshot.generation, column.id);
    napi_value value;
    NAPI_STATUS_RETURN(napi_create_external(env, columnReference.get(), Finalize<ColumnReference>,
                                            columnReference.get(), &value));
    columnReference.release();
    NAPI_STATUS_RETURN(napi_type_tag_object(env, value, &kColumnReferenceTag));

    // Define a data property rather than assigning a named property. Assignment
    // to "__proto__" invokes Object.prototype's setter (and has crashed V8 for
    // an external value); a length-aware key also preserves embedded NUL bytes
    // in valid RocksDB column-family names.
    napi_value name;
    NAPI_STATUS_RETURN(napi_create_string_utf8(env, column.name.data(), column.name.size(), &name));
    napi_property_descriptor descriptor = {
        nullptr, name, nullptr, nullptr, nullptr, value, napi_default_jsproperty, nullptr};
    NAPI_STATUS_RETURN(napi_define_properties(env, *result, 1, &descriptor));
  }

  return napi_ok;
}

static napi_status GetColumnProperty(napi_env env,
                                     napi_value options,
                                     Database* expectedDatabase,
                                     rocksdb::ColumnFamilyHandle*& result,
                                     bool useDefault = true) {
  if (useDefault) {
    if (!expectedDatabase || !expectedDatabase->db) {
      return napi_invalid_arg;
    }
    result = expectedDatabase->db->DefaultColumnFamily();
  } else {
    result = nullptr;
  }

  napi_valuetype optionsType;
  NAPI_STATUS_RETURN(napi_typeof(env, options, &optionsType));
  if (optionsType == napi_undefined || optionsType == napi_null) {
    return napi_ok;
  }
  if (optionsType != napi_object) {
    return napi_invalid_arg;
  }

  napi_value value;
  NAPI_STATUS_RETURN(napi_get_named_property(env, options, "column", &value));
  napi_valuetype valueType;
  NAPI_STATUS_RETURN(napi_typeof(env, value, &valueType));
  if (valueType == napi_undefined || valueType == napi_null) {
    return napi_ok;
  }

  bool matches = false;
  NAPI_STATUS_RETURN(napi_check_object_type_tag(env, value, &kColumnReferenceTag, &matches));
  if (!matches) {
    napi_throw_error(env, "LEVEL_INVALID_COLUMN", "Invalid column family handle");
    return napi_pending_exception;
  }

  ColumnReference* columnReference;
  NAPI_STATUS_RETURN(napi_get_value_external(env, value, reinterpret_cast<void**>(&columnReference)));
  const auto database = columnReference ? columnReference->database.lock() : nullptr;
  if (!database || (expectedDatabase && database.get() != expectedDatabase) ||
      !(result = database->ResolveColumn(columnReference->generation, columnReference->id))) {
    napi_throw_error(env, "LEVEL_INVALID_COLUMN", "Invalid, stale, or foreign column family handle");
    return napi_pending_exception;
  }

  return napi_ok;
}

struct NativeBatch final {
  explicit NativeBatch(std::shared_ptr<DatabaseReference> reference)
      : reference(std::move(reference)), generation(this->reference->generation) {}

  std::shared_ptr<DatabaseReference> reference;
  const uint64_t generation;
  std::mutex mutex;
  rocksdb::WriteBatch batch;
};

static napi_status GetBatch(napi_env env, napi_value value, std::shared_ptr<NativeBatch>& result) {
  return GetResourceExternal(env, value, kBatchReferenceTag, result);
}

static napi_status ValidateBatch(napi_env env,
                                 const std::shared_ptr<NativeBatch>& batch,
                                 const std::shared_ptr<DatabaseReference>& reference) {
  if (!batch || batch->reference->database != reference->database || batch->generation != reference->generation ||
      !reference->database->IsOpen(reference)) {
    napi_throw_error(env, "LEVEL_INVALID_BATCH", "Batch belongs to a foreign or stale database generation");
    return napi_pending_exception;
  }
  return napi_ok;
}

enum BatchOp { Empty, Put, Delete, Merge, Data, DeleteRange };

struct BatchEntry {
  BatchOp op = BatchOp::Empty;
  std::optional<std::string> key = std::nullopt;
  std::optional<std::string> val = std::nullopt;
  std::optional<ColumnFamily> column = std::nullopt;
};

struct BatchIterator : public rocksdb::WriteBatch::Handler {
  BatchIterator(const bool keys,
                const bool values,
                const bool data,
                const rocksdb::ColumnFamilyHandle* column,
                const Encoding keyEncoding,
                const Encoding valueEncoding)
      : keys_(keys),
        values_(values),
        data_(data),
        columnId_(column ? std::optional<uint32_t>(column->GetID()) : std::nullopt),
        keyEncoding_(keyEncoding),
        valueEncoding_(valueEncoding) {}

  napi_status Iterate(napi_env env, const rocksdb::WriteBatch& batch, napi_value* result) {
    cache_.reserve(batch.Count());

    ROCKS_STATUS_RETURN_NAPI(batch.Iterate(this));

    napi_value putStr;
    NAPI_STATUS_RETURN(napi_create_string_utf8(env, "put", NAPI_AUTO_LENGTH, &putStr));

    napi_value delStr;
    NAPI_STATUS_RETURN(napi_create_string_utf8(env, "del", NAPI_AUTO_LENGTH, &delStr));

    napi_value mergeStr;
    NAPI_STATUS_RETURN(napi_create_string_utf8(env, "merge", NAPI_AUTO_LENGTH, &mergeStr));

    napi_value dataStr;
    NAPI_STATUS_RETURN(napi_create_string_utf8(env, "data", NAPI_AUTO_LENGTH, &dataStr));

    napi_value clearStr;
    NAPI_STATUS_RETURN(napi_create_string_utf8(env, "clear", NAPI_AUTO_LENGTH, &clearStr));

    napi_value nullVal;
    NAPI_STATUS_RETURN(napi_get_null(env, &nullVal));

    NAPI_STATUS_RETURN(napi_create_array_with_length(env, cache_.size() * 4, result));
    for (size_t n = 0; n < cache_.size(); ++n) {
      napi_value op;
      if (cache_[n].op == BatchOp::Put) {
        op = putStr;
      } else if (cache_[n].op == BatchOp::Delete) {
        op = delStr;
      } else if (cache_[n].op == BatchOp::Merge) {
        op = mergeStr;
      } else if (cache_[n].op == BatchOp::Data) {
        op = dataStr;
      } else if (cache_[n].op == BatchOp::DeleteRange) {
        op = clearStr;
      } else {
        continue;
      }

      NAPI_STATUS_RETURN(napi_set_element(env, *result, n * 4 + 0, op));

      napi_value key;
      NAPI_STATUS_RETURN(Convert(env, cache_[n].key, keyEncoding_, key));
      NAPI_STATUS_RETURN(napi_set_element(env, *result, n * 4 + 1, key));

      napi_value val;
      NAPI_STATUS_RETURN(Convert(env, cache_[n].val,
                                 cache_[n].op == BatchOp::DeleteRange ? keyEncoding_ : valueEncoding_, val));
      NAPI_STATUS_RETURN(napi_set_element(env, *result, n * 4 + 2, val));

      // TODO (fix)
      // napi_value column = cache_[n].column ? cache_[n].column->val : nullVal;
      NAPI_STATUS_RETURN(napi_set_element(env, *result, n * 4 + 3, nullVal));
    }

    cache_.clear();

    return napi_ok;
  }

  rocksdb::Status PutCF(uint32_t column_family_id, const rocksdb::Slice& key, const rocksdb::Slice& value) override {
    if (columnId_ && *columnId_ != column_family_id) {
      return rocksdb::Status::OK();
    }

    BatchEntry entry = {BatchOp::Put};

    if (keys_) {
      entry.key = key.ToStringView();
    }

    if (values_) {
      entry.val = value.ToStringView();
    }

    // if (database_ && database_->columns.find(column_family_id) != database_->columns.end()) {
    //   entry.column = database_->columns[column_family_id];
    // }

    cache_.push_back(entry);

    return rocksdb::Status::OK();
  }

  rocksdb::Status DeleteCF(uint32_t column_family_id, const rocksdb::Slice& key) override {
    if (columnId_ && *columnId_ != column_family_id) {
      return rocksdb::Status::OK();
    }

    BatchEntry entry = {BatchOp::Delete};

    if (keys_) {
      entry.key = key.ToStringView();
    }

    // if (database_ && database_->columns.find(column_family_id) != database_->columns.end()) {
    //   entry.column = database_->columns[column_family_id];
    // }

    cache_.push_back(entry);

    return rocksdb::Status::OK();
  }

  rocksdb::Status MergeCF(uint32_t column_family_id, const rocksdb::Slice& key, const rocksdb::Slice& value) override {
    if (columnId_ && *columnId_ != column_family_id) {
      return rocksdb::Status::OK();
    }

    BatchEntry entry = {BatchOp::Merge};

    if (keys_) {
      entry.key = key.ToStringView();
    }

    if (values_) {
      entry.val = value.ToStringView();
    }

    // if (database_ && database_->columns.find(column_family_id) != database_->columns.end()) {
    //   entry.column = database_->columns[column_family_id];
    // }

    cache_.push_back(entry);

    return rocksdb::Status::OK();
  }

  rocksdb::Status DeleteRangeCF(uint32_t column_family_id,
                                const rocksdb::Slice& beginKey,
                                const rocksdb::Slice& endKey) override {
    if (columnId_ && *columnId_ != column_family_id) {
      return rocksdb::Status::OK();
    }

    BatchEntry entry = {BatchOp::DeleteRange};
    if (keys_) {
      entry.key = beginKey.ToStringView();
      entry.val = endKey.ToStringView();
    }
    cache_.push_back(std::move(entry));
    return rocksdb::Status::OK();
  }

  void LogData(const rocksdb::Slice& data) override {
    if (!data_) {
      return;
    }

    BatchEntry entry = {BatchOp::Data};

    entry.val = data.ToStringView();

    cache_.push_back(entry);
  }

  bool Continue() override { return true; }

 private:
  const bool keys_;
  const bool values_;
  const bool data_;
  const std::optional<uint32_t> columnId_;
  const Encoding keyEncoding_;
  const Encoding valueEncoding_;
  std::vector<BatchEntry> cache_;
};

struct BaseIterator : public Closable {
  BaseIterator(Database* database,
               std::shared_ptr<DatabaseReference> reference,
               rocksdb::ColumnFamilyHandle* column,
               const bool reverse,
               const std::optional<std::string>& lt,
               const std::optional<std::string>& lte,
               const std::optional<std::string>& gt,
               const std::optional<std::string>& gte,
               const int limit,
               rocksdb::ReadOptions readOptions = {})
      : database_(database), reference_(std::move(reference)), column_(column), reverse_(reverse), limit_(limit) {
    if (lte) {
      upper_bound_ = rocksdb::PinnableSlice();
      *upper_bound_->GetSelf() = *lte;
      upper_bound_->PinSelf();
      upper_inclusive_ = true;
    } else if (lt) {
      upper_bound_ = rocksdb::PinnableSlice();
      *upper_bound_->GetSelf() = *lt;
      upper_bound_->PinSelf();
    }

    if (gte) {
      lower_bound_ = rocksdb::PinnableSlice();
      *lower_bound_->GetSelf() = std::move(*gte);
      lower_bound_->PinSelf();
    } else if (gt) {
      lower_bound_ = rocksdb::PinnableSlice();
      *lower_bound_->GetSelf() = *gt;
      lower_bound_->PinSelf();
      lower_inclusive_ = false;
    }

    // RocksDB's upper bound is exclusive. `lte` and `gt` need comparator-aware
    // checks because there is no generally valid byte successor for a custom
    // comparator.
    if (upper_bound_ && !upper_inclusive_) {
      readOptions.iterate_upper_bound = &*upper_bound_;
    }

    if (lower_bound_) {
      readOptions.iterate_lower_bound = &*lower_bound_;
    }

    iterator_.reset(database_->db->NewIterator(readOptions, column_));
    ResetPosition();

    const auto status = database_->Attach(reference_, this);
    if (!status.ok()) {
      throw std::runtime_error(status.ToString());
    }
  }

  virtual ~BaseIterator() {
    if (!closed.load()) {
      database_->Close(reference_, this);
    }
  }

  virtual void Seek(const rocksdb::Slice& target) {
    assert(iterator_);

    if (!InRange(target)) {
      Invalidate();
    } else if (reverse_) {
      iterator_->SeekForPrev(target);
    } else {
      iterator_->Seek(target);
    }
  }

  rocksdb::Status Close() { return database_->Close(reference_, this); }

  rocksdb::Status CloseResources() override {
    std::lock_guard operationLock(operationMutex_);
    closed = true;
    // ReadOptions stores raw pointers to the bound slices, so the iterator must
    // be destroyed before their backing storage.
    iterator_.reset();
    lower_bound_.reset();
    upper_bound_.reset();
    return rocksdb::Status::OK();
  }

  rocksdb::Status RefreshSafe() {
    std::lock_guard operationLock(operationMutex_);
    if (!iterator_) {
      return rocksdb::Status::InvalidArgument("Iterator is not open");
    }
    return Refresh();
  }

  rocksdb::Status SeekSafe(const rocksdb::Slice& target, const uint32_t discardedCount) {
    std::lock_guard operationLock(operationMutex_);
    if (!iterator_) {
      return rocksdb::Status::InvalidArgument("Iterator is not open");
    }
    // Native limit accounting includes rows prefetched into the JS cache. Give
    // back only the undelivered rows that seek is about to discard, preserving
    // all public, raw and decode-failed reads that were already consumed.
    if (limit_ >= 0) {
      const auto credit = std::min(static_cast<uint32_t>(count_), discardedCount);
      count_ -= static_cast<int>(credit);
    }
    Seek(target);
    return Status();
  }

  bool Valid() const {
    assert(iterator_);
    return iterator_->Valid() && InRange(iterator_->key());
  }

  bool Increment() {
    assert(iterator_);
    if (limit_ < 0) return true;
    if (count_ >= limit_) return false;
    count_++;
    return true;
  }

  void Next() {
    assert(iterator_);

    if (reverse_)
      iterator_->Prev();
    else
      iterator_->Next();
  }

  rocksdb::Slice CurrentKey() const {
    assert(iterator_);
    return iterator_->key();
  }

  rocksdb::Slice CurrentValue() const {
    assert(iterator_);
    return iterator_->value();
  }

  rocksdb::Status Status() const {
    assert(iterator_);
    return iterator_->status();
  }

  virtual rocksdb::Status Refresh() {
    assert(iterator_);
    // Refresh restarts iteration, so the user `limit` budget must restart too;
    // otherwise an iterator that already yielded `limit` rows returns nothing
    // after a refresh even though every other piece of state was reset.
    count_ = 0;
    ROCKS_STATUS_RETURN(iterator_->Refresh());
    // Refresh invalidates the iterator, so restore its comparator-aware start.
    ResetPosition();
    return iterator_->status();
  }

  Database* database_;
  std::shared_ptr<DatabaseReference> reference_;
  rocksdb::ColumnFamilyHandle* column_;
  std::mutex operationMutex_;

 private:
  bool InRange(const rocksdb::Slice& key) const {
    const auto* comparator = column_->GetComparator();
    if (lower_bound_) {
      const auto compared = comparator->Compare(key, *lower_bound_);
      if (compared < 0 || (compared == 0 && !lower_inclusive_)) {
        return false;
      }
    }
    if (upper_bound_) {
      const auto compared = comparator->Compare(key, *upper_bound_);
      if (compared > 0 || (compared == 0 && !upper_inclusive_)) {
        return false;
      }
    }
    return true;
  }

  void Invalidate() {
    iterator_->SeekToLast();
    if (iterator_->Valid()) {
      iterator_->Next();
    }
  }

  void ResetPosition() {
    if (reverse_) {
      if (upper_bound_) {
        iterator_->SeekForPrev(*upper_bound_);
        if (!upper_inclusive_ && iterator_->Valid() &&
            column_->GetComparator()->Compare(iterator_->key(), *upper_bound_) == 0) {
          iterator_->Prev();
        }
      } else {
        iterator_->SeekToLast();
      }
    } else if (lower_bound_) {
      iterator_->Seek(*lower_bound_);
      if (!lower_inclusive_ && iterator_->Valid() &&
          column_->GetComparator()->Compare(iterator_->key(), *lower_bound_) == 0) {
        iterator_->Next();
      }
    } else {
      iterator_->SeekToFirst();
    }
  }

  int count_ = 0;
  std::optional<rocksdb::PinnableSlice> lower_bound_;
  std::optional<rocksdb::PinnableSlice> upper_bound_;
  bool lower_inclusive_ = true;
  bool upper_inclusive_ = false;
  std::unique_ptr<rocksdb::Iterator> iterator_;
  const bool reverse_;
  const int limit_;
};

class Iterator final : public BaseIterator, public std::enable_shared_from_this<Iterator> {
  Reference databaseContext_;
  const bool keys_;
  const bool values_;
  const size_t highWaterMarkBytes_;
  bool first_ = true;
  const Encoding keyEncoding_;
  const Encoding valueEncoding_;
  std::optional<re2::RE2> keyFilter_;
  std::optional<re2::RE2> valueFilter_;
  const bool unsafe_;

 public:
  Iterator(Database* database,
           std::shared_ptr<DatabaseReference> reference,
           Reference databaseContext,
           rocksdb::ColumnFamilyHandle* column,
           const bool reverse,
           const bool keys,
           const bool values,
           const int limit,
           const std::optional<std::string>& lt,
           const std::optional<std::string>& lte,
           const std::optional<std::string>& gt,
           const std::optional<std::string>& gte,
           const size_t highWaterMarkBytes,
           std::optional<std::string> keyFilter = std::nullopt,
           std::optional<std::string> valueFilter = std::nullopt,
           Encoding keyEncoding = Encoding::Invalid,
           Encoding valueEncoding = Encoding::Invalid,
           const bool unsafe = false,
           rocksdb::ReadOptions readOptions = {})
      : BaseIterator(database, std::move(reference), column, reverse, lt, lte, gt, gte, limit, readOptions),
        databaseContext_(std::move(databaseContext)),
        keys_(keys),
        values_(values),
        highWaterMarkBytes_(highWaterMarkBytes),
        keyEncoding_(keyEncoding),
        valueEncoding_(valueEncoding),
        unsafe_(unsafe) {
    if (keyFilter) {
      keyFilter_.emplace(*keyFilter);
      if (!keyFilter_->ok()) {
        throw std::invalid_argument("Invalid key filter regex");
      }
    }

    if (valueFilter) {
      valueFilter_.emplace(*valueFilter);
      if (!valueFilter_->ok()) {
        throw std::invalid_argument("Invalid value filter regex");
      }
    }
  }

  void Seek(const rocksdb::Slice& target) override {
    first_ = true;
    return BaseIterator::Seek(target);
  }

  rocksdb::Status Refresh() override {
    first_ = true;
    return BaseIterator::Refresh();
  }

  static std::shared_ptr<Iterator> create(napi_env env, napi_value db, napi_value options) {
    Database* database;
    std::shared_ptr<DatabaseReference> reference;
    NAPI_STATUS_THROWS(GetDatabase(env, db, database, &reference));
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));
    Reference databaseContext;
    NAPI_STATUS_THROWS(Reference::Create(env, db, databaseContext));

    bool unsafe = false;
    NAPI_STATUS_THROWS(GetProperty(env, options, "unsafe", unsafe));

    bool reverse = false;
    NAPI_STATUS_THROWS(GetProperty(env, options, "reverse", reverse));

    bool keys = true;
    NAPI_STATUS_THROWS(GetProperty(env, options, "keys", keys));

    bool values = true;
    NAPI_STATUS_THROWS(GetProperty(env, options, "values", values));

    int32_t limit = -1;
    NAPI_STATUS_THROWS(GetProperty(env, options, "limit", limit));

    // 64-bit: the value flows into a size_t cap, so parsing as int32 would wrap
    // any value > 2 GiB to a garbage cap. Default stays ~2 GiB (effectively no cap).
    int64_t highWaterMarkBytes = std::numeric_limits<int32_t>::max();
    NAPI_STATUS_THROWS(GetProperty(env, options, "highWaterMarkBytes", highWaterMarkBytes));
    if (highWaterMarkBytes < 0) {
      napi_throw_range_error(env, nullptr, "highWaterMarkBytes must be non-negative");
      return nullptr;
    }

    std::optional<std::string> lt;
    NAPI_STATUS_THROWS(GetProperty(env, options, "lt", lt));

    std::optional<std::string> lte;
    NAPI_STATUS_THROWS(GetProperty(env, options, "lte", lte));

    std::optional<std::string> gt;
    NAPI_STATUS_THROWS(GetProperty(env, options, "gt", gt));

    std::optional<std::string> gte;
    NAPI_STATUS_THROWS(GetProperty(env, options, "gte", gte));

    std::optional<std::string> keyFilter;
    NAPI_STATUS_THROWS(GetProperty(env, options, "keyFilter", keyFilter));

    std::optional<std::string> valueFilter;
    NAPI_STATUS_THROWS(GetProperty(env, options, "valueFilter", valueFilter));

    rocksdb::ColumnFamilyHandle* column = database->db->DefaultColumnFamily();
    NAPI_STATUS_THROWS(GetColumnProperty(env, options, database, column));

    Encoding keyEncoding = Encoding::Buffer;
    NAPI_STATUS_THROWS(GetProperty(env, options, "keyEncoding", keyEncoding));

    Encoding valueEncoding = Encoding::Buffer;
    NAPI_STATUS_THROWS(GetProperty(env, options, "valueEncoding", valueEncoding));

    rocksdb::ReadOptions readOptions;

    readOptions.background_purge_on_iterator_cleanup = true;
    NAPI_STATUS_THROWS(GetProperty(env, options, "backgroundPurgeOnIteratorCleanup",
                                   readOptions.background_purge_on_iterator_cleanup));

    readOptions.tailing = false;
    NAPI_STATUS_THROWS(GetProperty(env, options, "tailing", readOptions.tailing));

    readOptions.fill_cache = false;
    NAPI_STATUS_THROWS(GetProperty(env, options, "fillCache", readOptions.fill_cache));

    // Local NVMe/SSD gains nothing from RocksDB async I/O (io_uring): it only adds
    // CPU + ring overhead (async-io wins need high-latency/remote storage). Default
    // OFF; callers opt in per-request via `asyncIO`.
    readOptions.async_io = false;
    NAPI_STATUS_THROWS(GetProperty(env, options, "asyncIO", readOptions.async_io));

    readOptions.adaptive_readahead = true;
    NAPI_STATUS_THROWS(GetProperty(env, options, "adaptiveReadahead", readOptions.adaptive_readahead));

    readOptions.readahead_size = 0;
    NAPI_STATUS_THROWS(GetProperty(env, options, "readaheadSize", readOptions.readahead_size));

    readOptions.auto_readahead_size = true;
    NAPI_STATUS_THROWS(GetProperty(env, options, "autoReadaheadSize", readOptions.auto_readahead_size));

    readOptions.ignore_range_deletions = false;
    NAPI_STATUS_THROWS(GetProperty(env, options, "ignoreRangeDeletions", readOptions.ignore_range_deletions));

    // uint32_t timeout = 0;
    // NAPI_STATUS_THROWS(GetProperty(env, options, "timeout", timeout));

    // readOptions.deadline = timeout
    //   ? std::chrono::microseconds(database->db->GetEnv()->NowMicros() + timeout * 1000)
    //   : std::chrono::microseconds::zero();

    return std::make_shared<Iterator>(database, reference, std::move(databaseContext), column, reverse, keys,
                                      values, limit, lt, lte, gt, gte, highWaterMarkBytes, keyFilter, valueFilter,
                                      keyEncoding, valueEncoding, unsafe, readOptions);
  }

  napi_value nextv(napi_env env, uint32_t count, uint32_t timeout, napi_value callback, const bool packed = false) {
    struct State {
      std::vector<rocksdb::PinnableSlice> keys;
      std::vector<rocksdb::PinnableSlice> values;
      rocksdb::PinnableSlice packedData;
      std::vector<uint32_t> offsets;
      size_t count = 0;
      size_t bytes = 0;
      bool finished = false;
      bool limited = false;
    };

    napi_value resourceName;
    NAPI_STATUS_THROWS(GetResourceName(env, ResourceIteratorNextv, resourceName));

    const auto self = shared_from_this();
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database_, reference_, databaseOperation));

    NAPI_STATUS_THROWS(runAsync<State>(
        resourceName, env, callback,
        [self, this, count, timeout, databaseOperation, packed](auto& state) {
          const DatabaseOperationScope operationScope(databaseOperation);
          std::lock_guard operationLock(operationMutex_);
          if (closed.load()) {
            return rocksdb::Status::InvalidArgument("Iterator is not open");
          }

          // Query uses UINT32_MAX as its "all rows" sentinel. Reserving that
          // value would attempt a huge allocation before reading anything.
          const auto initialCapacity = std::min<size_t>(count, 4096);
          if (packed) {
            const auto fieldsPerRow = static_cast<size_t>(keys_) + static_cast<size_t>(values_);
            state.offsets.reserve(initialCapacity * fieldsPerRow + 1);
            state.offsets.push_back(0);
            state.packedData.GetSelf()->reserve(std::min<size_t>(highWaterMarkBytes_, initialCapacity * 128));
          } else {
            state.keys.reserve(initialCapacity);
            state.values.reserve(initialCapacity);
          }

          const auto deadline =
              timeout ? database_->db->GetEnv()->NowMicros() + static_cast<uint64_t>(timeout) * 1000 : 0;

          while (true) {
            if (state.count >= count || state.bytes > highWaterMarkBytes_) {
              // Batch cap (size/bytes) reached: more data may exist, so this is
              // "limited", not "finished".
              state.limited = true;
              break;
            }

            if (deadline > 0 && database_->db->GetEnv()->NowMicros() > deadline) {
              // Timed out: neither finished nor limited; the caller may retry.
              break;
            }

            if (!first_) {
              Next();
            } else {
              first_ = false;
            }

            ROCKS_STATUS_RETURN(Status());

            if (!Valid()) {
              // Iterator naturally exhausted.
              state.finished = true;
              break;
            }

            // Apply the key/value filters BEFORE charging the user `limit`, so
            // `limit` counts matched (emitted) rows, not rows merely scanned and
            // then discarded. Otherwise a `{ limit, keyFilter }` query could
            // exhaust its budget on non-matching rows and return fewer (or zero)
            // matches than exist.
            if (keyFilter_ && !re2::RE2::PartialMatch(CurrentKey().ToStringView(), *keyFilter_)) {
              continue;
            }

            if (valueFilter_ && !re2::RE2::PartialMatch(CurrentValue().ToStringView(), *valueFilter_)) {
              continue;
            }

            if (!Increment()) {
              // Hit the user's `limit` option: terminal, and flag that it was a
              // limit rather than natural exhaustion.
              state.finished = true;
              state.limited = true;
              break;
            }

            if (packed) {
              const auto append = [&](const rocksdb::Slice& value) {
                auto* data = state.packedData.GetSelf();
                if (value.size() > std::numeric_limits<uint32_t>::max() - data->size()) {
                  return rocksdb::Status::InvalidArgument("Packed iterator result exceeds 4 GiB");
                }
                data->append(value.data(), value.size());
                state.bytes += value.size();
                state.offsets.push_back(static_cast<uint32_t>(data->size()));
                return rocksdb::Status::OK();
              };

              if (keys_) {
                ROCKS_STATUS_RETURN(append(CurrentKey()));
              }
              if (values_) {
                ROCKS_STATUS_RETURN(append(CurrentValue()));
              }
            } else if (keys_ && values_) {
              rocksdb::PinnableSlice k;
              k.PinSelf(CurrentKey());
              state.bytes += k.size();
              state.keys.push_back(std::move(k));

              rocksdb::PinnableSlice v;
              v.PinSelf(CurrentValue());
              state.bytes += v.size();
              state.values.push_back(std::move(v));
            } else if (keys_) {
              rocksdb::PinnableSlice k;
              k.PinSelf(CurrentKey());
              state.bytes += k.size();
              state.keys.push_back(std::move(k));
            } else if (values_) {
              rocksdb::PinnableSlice v;
              v.PinSelf(CurrentValue());
              state.bytes += v.size();
              state.values.push_back(std::move(v));
            }
            // keys:false + values:false is valid per abstract-level: rows still
            // count, each entry surfaces as [undefined, undefined].
            state.count += 1;
          }

          return rocksdb::Status::OK();
        },
        [self, this, packed](auto& state, napi_env env, napi_value* result) {
          napi_value finished;
          NAPI_STATUS_RETURN(napi_get_boolean(env, state.finished, &finished));

          napi_value limited;
          NAPI_STATUS_RETURN(napi_get_boolean(env, state.limited, &limited));

          if (packed) {
            state.packedData.PinSelf();

            napi_value buffer;
            // The packed data owns its storage independently of RocksDB. For a
            // non-trivial batch, transfer that storage to the Buffer finalizer
            // instead of copying the whole arena a second time.
            NAPI_STATUS_RETURN(Convert(env, std::move(state.packedData), Encoding::Buffer, buffer, true));

            void* offsetsData = nullptr;
            napi_value offsetsBuffer;
            NAPI_STATUS_RETURN(
                napi_create_arraybuffer(env, state.offsets.size() * sizeof(uint32_t), &offsetsData, &offsetsBuffer));
            std::copy(state.offsets.begin(), state.offsets.end(), static_cast<uint32_t*>(offsetsData));

            napi_value offsets;
            NAPI_STATUS_RETURN(
                napi_create_typedarray(env, napi_uint32_array, state.offsets.size(), offsetsBuffer, 0, &offsets));

            napi_value count;
            NAPI_STATUS_RETURN(napi_create_uint32(env, static_cast<uint32_t>(state.count), &count));

            NAPI_STATUS_RETURN(napi_create_object(env, result));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "buffer", buffer));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "offsets", offsets));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "count", count));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "finished", finished));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "limited", limited));

            return napi_ok;
          }

          napi_value rows;
          NAPI_STATUS_RETURN(napi_create_array(env, &rows));

          for (size_t n = 0; n < state.count; n++) {
            napi_value key;
            napi_value val;

            if (keys_ && values_) {
              NAPI_STATUS_RETURN(Convert(env, std::move(state.keys[n]), keyEncoding_, key, unsafe_));
              NAPI_STATUS_RETURN(Convert(env, std::move(state.values[n]), valueEncoding_, val, unsafe_));
            } else if (keys_) {
              NAPI_STATUS_RETURN(Convert(env, std::move(state.keys[n]), keyEncoding_, key, unsafe_));
              NAPI_STATUS_RETURN(napi_get_undefined(env, &val));
            } else if (values_) {
              NAPI_STATUS_RETURN(napi_get_undefined(env, &key));
              NAPI_STATUS_RETURN(Convert(env, std::move(state.values[n]), valueEncoding_, val, unsafe_));
            } else {
              NAPI_STATUS_RETURN(napi_get_undefined(env, &key));
              NAPI_STATUS_RETURN(napi_get_undefined(env, &val));
            }

            NAPI_STATUS_RETURN(napi_set_element(env, rows, n * 2 + 0, key));
            NAPI_STATUS_RETURN(napi_set_element(env, rows, n * 2 + 1, val));
          }

          NAPI_STATUS_RETURN(napi_create_object(env, result));
          NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "rows", rows));
          NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "finished", finished));
          NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "limited", limited));

          return napi_ok;
        }));

    return 0;
  }

  napi_value nextv(napi_env env, uint32_t count, uint32_t timeout = 0) {
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database_, reference_, databaseOperation));
    std::lock_guard operationLock(operationMutex_);
    if (closed.load()) {
      napi_throw_error(env, "LEVEL_ITERATOR_NOT_OPEN", "Iterator is not open");
      return nullptr;
    }

    napi_value finished;
    NAPI_STATUS_THROWS(napi_get_boolean(env, false, &finished));

    napi_value limited;
    NAPI_STATUS_THROWS(napi_get_boolean(env, false, &limited));

    napi_value rows;
    NAPI_STATUS_THROWS(napi_create_array(env, &rows));

    const auto deadline =
        timeout ? database_->db->GetEnv()->NowMicros() + static_cast<uint64_t>(timeout) * 1000 : 0;

    size_t idx = 0;
    size_t bytes = 0;
    while (true) {
      if (idx >= static_cast<size_t>(count) * 2 || bytes > highWaterMarkBytes_) {
        // Batch cap (size/bytes) reached: more data may exist, so this is
        // "limited", not "finished". (count is uint32_t; widen before *2 so
        // query()'s UINT32_MAX count doesn't overflow to a small cap.)
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &limited));
        break;
      }

      if (deadline > 0 && database_->db->GetEnv()->NowMicros() > deadline) {
        // Timed out: neither finished nor limited; the caller may retry.
        break;
      }

      if (!first_) {
        Next();
      } else {
        first_ = false;
      }

      ROCKS_STATUS_THROWS_NAPI(Status());

      if (!Valid()) {
        // Iterator naturally exhausted.
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &finished));
        break;
      }

      // Apply the key/value filters BEFORE charging the user `limit`, so `limit`
      // counts matched (emitted) rows, not rows merely scanned and discarded.
      if (keyFilter_ && !re2::RE2::PartialMatch(CurrentKey().ToStringView(), *keyFilter_)) {
        continue;
      }

      if (valueFilter_ && !re2::RE2::PartialMatch(CurrentValue().ToStringView(), *valueFilter_)) {
        continue;
      }

      if (!Increment()) {
        // Hit the user's `limit` option: terminal, and flag that it was a limit
        // rather than natural exhaustion.
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &finished));
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &limited));
        break;
      }

      napi_value key;
      napi_value val;

      if (keys_ && values_) {
        bytes += CurrentKey().size() + CurrentValue().size();
        NAPI_STATUS_THROWS(Convert(env, CurrentKey(), keyEncoding_, key, unsafe_));
        NAPI_STATUS_THROWS(Convert(env, CurrentValue(), valueEncoding_, val, unsafe_));
      } else if (keys_) {
        bytes += CurrentKey().size();
        NAPI_STATUS_THROWS(Convert(env, CurrentKey(), keyEncoding_, key, unsafe_));
        NAPI_STATUS_THROWS(napi_get_undefined(env, &val));
      } else if (values_) {
        bytes += CurrentValue().size();
        NAPI_STATUS_THROWS(napi_get_undefined(env, &key));
        NAPI_STATUS_THROWS(Convert(env, CurrentValue(), valueEncoding_, val, unsafe_));
      } else {
        NAPI_STATUS_THROWS(napi_get_undefined(env, &key));
        NAPI_STATUS_THROWS(napi_get_undefined(env, &val));
      }

      NAPI_STATUS_THROWS(napi_set_element(env, rows, idx++, key));
      NAPI_STATUS_THROWS(napi_set_element(env, rows, idx++, val));
    }

    napi_value ret;
    NAPI_STATUS_THROWS(napi_create_object(env, &ret));
    NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "rows", rows));
    NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "finished", finished));
    NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "limited", limited));
    return ret;
  }
};

/**
 * Hook for when the environment exits. This hook will be called after
 * already-scheduled napi_async_work items have finished, which gives us
 * the guarantee that no db operations will be in-flight at this time.
 */
static void env_cleanup_hook(void* data) {
  auto holder = reinterpret_cast<std::shared_ptr<DatabaseReference>*>(data);

  // Do everything that db_close() does but synchronously. We're expecting that GC
  // did not (yet) collect the database because that would be a user mistake (not
  // closing their db) made during the lifetime of the environment. That's different
  // from an environment being torn down (like the main process or a worker thread)
  // where it's our responsibility to clean up. Note also, the following code must
  // be a safe noop if called before db_open() or after db_close().
  if (holder && *holder) {
    (*holder)->database->Close(*holder);
  }
}

static void FinalizeDatabase(napi_env env, void* data, void* hint) {
  auto holder = reinterpret_cast<std::shared_ptr<DatabaseReference>*>(data);
  if (holder) {
    napi_remove_env_cleanup_hook(env, env_cleanup_hook, holder);
    if (*holder) {
      (*holder)->database->Close(*holder);
    }
    delete holder;
  }
}

NAPI_METHOD(db_init) {
  NAPI_ARGV(2);

  napi_valuetype type;
  NAPI_STATUS_THROWS(napi_typeof(env, argv[0], &type));

  std::shared_ptr<Database> database;

  if (type == napi_string) {
    std::string location;
    NAPI_STATUS_THROWS(GetValue(env, argv[0], location));

    database = std::make_shared<Database>(std::move(location));
    database->handle = HandleRegistry<Database>::Instance().Insert(database);
  } else if (type == napi_bigint) {
    uint64_t value;
    bool lossless;
    NAPI_STATUS_THROWS(napi_get_value_bigint_uint64(env, argv[0], &value, &lossless));
    if (!lossless || !(database = HandleRegistry<Database>::Instance().Lookup(value))) {
      napi_throw_error(env, nullptr, "Invalid or stale database handle");
      return NULL;
    }
  } else {
    NAPI_STATUS_THROWS(napi_invalid_arg);
  }

  auto reference = std::make_shared<DatabaseReference>(std::move(database));
  if (type == napi_bigint) {
    const auto status = reference->database->Reserve(reference);
    if (!status.ok()) {
      napi_throw_error(env, nullptr, status.ToString().c_str());
      return nullptr;
    }
  }

  auto holder = std::make_unique<std::shared_ptr<DatabaseReference>>(reference);
  auto* holderPointer = holder.get();

  napi_value result;
  const auto status = napi_create_external(env, holder.get(), FinalizeDatabase, nullptr, &result);
  if (status != napi_ok) {
    reference->database->Close(reference);
    NAPI_STATUS_THROWS(status);
  }
  holder.release();
  NAPI_STATUS_THROWS(napi_type_tag_object(env, result, &kDatabaseReferenceTag));
  NAPI_STATUS_THROWS(napi_add_env_cleanup_hook(env, env_cleanup_hook, holderPointer));

  return result;
}

NAPI_METHOD(db_get_handle) {
  NAPI_ARGV(1);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  napi_value result;
  NAPI_STATUS_THROWS(napi_create_bigint_uint64(env, database->handle, &result));

  return result;
}

NAPI_METHOD(db_get_location) {
  NAPI_ARGV(1);

  Database* database;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, nullptr, false));

  napi_value result;
  NAPI_STATUS_THROWS(Convert(env, database->location, Encoding::String, result));

  return result;
}

NAPI_METHOD(db_query_sync) {
  NAPI_ARGV(2);

  try {
    auto iterator = Iterator::create(env, argv[0], argv[1]);
    // Iterator::create uses NAPI_STATUS_THROWS internally, which on a N-API
    // failure schedules a pending JS exception and `return NULL` — i.e. an empty
    // unique_ptr. Dereferencing it (->nextv) would be a null deref / crash, so
    // bail out and let the pending exception surface.
    if (!iterator) {
      return nullptr;
    }
    return iterator->nextv(env, std::numeric_limits<uint32_t>::max());
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(db_query) {
  NAPI_ARGV(3);

  try {
    auto iterator = Iterator::create(env, argv[0], argv[1]);
    if (!iterator) {
      return nullptr;
    }
    return iterator->nextv(env, std::numeric_limits<uint32_t>::max(), 0, argv[2]);
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

template <typename T, typename U>
napi_status InitOptions(napi_env env, T& columnOptions, const U& options) {
  rocksdb::ConfigOptions configOptions;

  uint64_t memtable_memory_budget = 256 * 1024 * 1024;
  NAPI_STATUS_RETURN(GetProperty(env, options, "memtableMemoryBudget", memtable_memory_budget));

  std::string compaction;
  NAPI_STATUS_RETURN(GetProperty(env, options, "compaction", compaction));
  if (compaction == "") {
    // Do nothing...
  } else if (compaction == "universal") {
    columnOptions.write_buffer_size = memtable_memory_budget / 4;
    // merge two memtables when flushing to L0
    columnOptions.min_write_buffer_number_to_merge = 2;
    // this means we'll use 50% extra memory in the worst case, but will reduce
    // write stalls.
    columnOptions.max_write_buffer_number = 6;
    // universal style compaction
    columnOptions.compaction_style = rocksdb::kCompactionStyleUniversal;
    columnOptions.compaction_options_universal.compression_size_percent = 80;
  } else if (compaction == "level") {
    columnOptions.write_buffer_size = static_cast<size_t>(memtable_memory_budget / 4);
    // merge two memtables when flushing to L0
    columnOptions.min_write_buffer_number_to_merge = 2;
    // this means we'll use 50% extra memory in the worst case, but will reduce
    // write stalls.
    columnOptions.max_write_buffer_number = 6;
    // start flushing L0->L1 as soon as possible. each file on level0 is
    // (memtable_memory_budget / 2). This will flush level 0 when it's bigger than
    // memtable_memory_budget.
    columnOptions.level0_file_num_compaction_trigger = 2;
    // doesn't really matter much, but we don't want to create too many files
    columnOptions.target_file_size_base = memtable_memory_budget / 8;
    // make Level1 size equal to Level0 size, so that L0->L1 compactions are fast
    columnOptions.max_bytes_for_level_base = memtable_memory_budget;

    // level style compaction
    columnOptions.compaction_style = rocksdb::kCompactionStyleLevel;

    // only compress levels >= 2
    columnOptions.compression_per_level.resize(columnOptions.num_levels);
    for (int i = 0; i < columnOptions.num_levels; ++i) {
      if (i < 2) {
        columnOptions.compression_per_level[i] = rocksdb::kNoCompression;
      } else {
        columnOptions.compression_per_level[i] = rocksdb::kZSTD;
      }
    }
  } else {
    return napi_invalid_arg;
  }

  bool compression = true;
  NAPI_STATUS_RETURN(GetProperty(env, options, "compression", compression));

  if (compression) {
    columnOptions.compression = rocksdb::kZSTD;
    columnOptions.compression_opts.max_dict_bytes = 16 * 1024;
    columnOptions.compression_opts.zstd_max_train_bytes = 16 * 1024 * 100;
    NAPI_STATUS_RETURN(GetProperty(env, options, "compressionLevel", columnOptions.compression_opts.level));
    NAPI_STATUS_RETURN(GetProperty(env, options, "maxDictBytes", columnOptions.compression_opts.max_dict_bytes));
    NAPI_STATUS_RETURN(
        GetProperty(env, options, "zstdMaxTrainBytes", columnOptions.compression_opts.zstd_max_train_bytes));
    // TODO (perf): compression_opts.parallel_threads
  } else {
    columnOptions.compression = rocksdb::kNoCompression;
    for (auto& c : columnOptions.compression_per_level) {
      c = rocksdb::kNoCompression;
    }
  }

  std::string prefixExtractor;
  NAPI_STATUS_RETURN(GetProperty(env, options, "prefixExtractor", prefixExtractor));
  if (prefixExtractor == "") {
    // Do nothing...
  } else {
    ROCKS_STATUS_RETURN_NAPI(
        rocksdb::SliceTransform::CreateFromString(configOptions, prefixExtractor, &columnOptions.prefix_extractor));
  }

  std::string comparator;
  NAPI_STATUS_RETURN(GetProperty(env, options, "comparator", comparator));
  if (comparator == "") {
    // Do nothing...
  } else {
    ROCKS_STATUS_RETURN_NAPI(
        rocksdb::Comparator::CreateFromString(configOptions, comparator, &columnOptions.comparator));
  }

  std::string mergeOperator;
  NAPI_STATUS_RETURN(GetProperty(env, options, "mergeOperator", mergeOperator));
  if (mergeOperator == "") {
    // Do nothing...
  } else if (mergeOperator == "maxRev") {
    columnOptions.merge_operator = std::make_shared<MaxRevOperator>();
  } else {
    ROCKS_STATUS_RETURN_NAPI(
        rocksdb::MergeOperator::CreateFromString(configOptions, mergeOperator, &columnOptions.merge_operator));
  }

  std::string compactionPriority;
  NAPI_STATUS_RETURN(GetProperty(env, options, "compactionPriority", compactionPriority));
  if (compactionPriority == "") {
    // Do nothing...
  } else if (compactionPriority == "byCompensatedSize") {
    columnOptions.compaction_pri = rocksdb::kByCompensatedSize;
  } else if (compactionPriority == "oldestLargestSeqFirst") {
    columnOptions.compaction_pri = rocksdb::kOldestLargestSeqFirst;
  } else if (compactionPriority == "smallestSeqFirst") {
    columnOptions.compaction_pri = rocksdb::kOldestSmallestSeqFirst;
  } else if (compactionPriority == "overlappingRatio") {
    columnOptions.compaction_pri = rocksdb::kMinOverlappingRatio;
  } else if (compactionPriority == "roundRobin") {
    columnOptions.compaction_pri = rocksdb::kRoundRobin;
  } else {
    return napi_invalid_arg;
  }

  NAPI_STATUS_RETURN(GetProperty(env, options, "optimizeFiltersForHits", columnOptions.optimize_filters_for_hits));
  NAPI_STATUS_RETURN(GetProperty(env, options, "periodicCompactionSeconds", columnOptions.periodic_compaction_seconds));
  // memtable_huge_page_size is a column-family option: when the DB is opened
  // with explicit column descriptors the copy read into dbOptions in db_open is
  // sliced away, so it must be settable per column to take effect at all.
  NAPI_STATUS_RETURN(GetProperty(env, options, "memTableHugePageSize", columnOptions.memtable_huge_page_size));

  NAPI_STATUS_RETURN(GetProperty(env, options, "blobFiles", columnOptions.enable_blob_files));
  NAPI_STATUS_RETURN(GetProperty(env, options, "blobMinSize", columnOptions.min_blob_size));
  NAPI_STATUS_RETURN(GetProperty(env, options, "blobGarbageCollection", columnOptions.enable_blob_garbage_collection));
  NAPI_STATUS_RETURN(GetProperty(env, options, "blobFileSize", columnOptions.blob_file_size));
  NAPI_STATUS_RETURN(
      GetProperty(env, options, "blobGarbageCollectionAgeCutoff", columnOptions.blob_garbage_collection_age_cutoff));
  NAPI_STATUS_RETURN(GetProperty(env, options, "blobGarbageCollectionForceThreshold",
                                 columnOptions.blob_garbage_collection_force_threshold));
  NAPI_STATUS_RETURN(
      GetProperty(env, options, "blobCompactionReadaheadSize", columnOptions.blob_compaction_readahead_size));
  NAPI_STATUS_RETURN(GetProperty(env, options, "blobFileStartingLevel", columnOptions.blob_file_starting_level));
  NAPI_STATUS_RETURN(GetProperty(env, options, "blobCompression", columnOptions.blob_compression_type));

  rocksdb::BlockBasedTableOptions tableOptions;
  tableOptions.decouple_partitioned_filters = true;

  std::shared_ptr<rocksdb::Cache> cache;

  {
    napi_value cacheValue;
    NAPI_STATUS_RETURN(napi_get_named_property(env, options, "cache", &cacheValue));

    napi_valuetype cacheType;
    NAPI_STATUS_RETURN(napi_typeof(env, cacheValue, &cacheType));

    if (cacheType == napi_object || cacheType == napi_bigint) {
      std::shared_ptr<CacheResource> resource;
      NAPI_STATUS_RETURN(
          LookupResourceHandle(env, cacheValue, HandleRegistry<CacheResource>::Instance(), resource));
      cache = resource->value;
    } else if (cacheType != napi_undefined && cacheType != napi_null) {
      return napi_invalid_arg;
    }
  }

  if (!cache) {
    // size_t: RocksDB cache capacity is size_t; a 32-bit type silently wraps
    // requests >= 4 GiB (and 4 GiB exactly wraps to 0 -> cache disabled).
    uint64_t cacheSize = 8 << 20;
    double compressedRatio = 0.0;

    NAPI_STATUS_RETURN(GetProperty(env, options, "cacheSize", cacheSize));
    NAPI_STATUS_RETURN(GetProperty(env, options, "cacheCompressedRatio", compressedRatio));

    if (!std::isfinite(compressedRatio) || compressedRatio < 0.0 || compressedRatio > 1.0) {
      return napi_invalid_arg;
    }

    if (cacheSize == 0) {
      // Do nothing...
    } else if (compressedRatio > 0.0) {
      rocksdb::TieredCacheOptions options;
      options.cache_type = rocksdb::PrimaryCacheType::kCacheTypeHCC;
      options.total_capacity = cacheSize;
      options.compressed_secondary_ratio = compressedRatio;
      cache = rocksdb::NewTieredCache(options);
    } else {
      cache = rocksdb::HyperClockCacheOptions(cacheSize, 0).MakeSharedCache();
    }
  }

  {
    // int64: -1 means "unset" (inherit the shared cache); a 32-bit type both
    // wraps requests >= 4 GiB and collides the unset sentinel with a real
    // 4294967295-byte request.
    int64_t cacheSize = -1;
    double compressedRatio = 0.0;

    NAPI_STATUS_RETURN(GetProperty(env, options, "cachePrepopulate", tableOptions.prepopulate_block_cache));
    NAPI_STATUS_RETURN(GetProperty(env, options, "prepopulateBlockCache", tableOptions.prepopulate_block_cache));

    NAPI_STATUS_RETURN(GetProperty(env, options, "blockCacheSize", cacheSize));
    NAPI_STATUS_RETURN(GetProperty(env, options, "blockCacheCompressedRatio", compressedRatio));
    NAPI_STATUS_RETURN(GetProperty(env, options, "blockCachePrepopulate", tableOptions.prepopulate_block_cache));

    if (cacheSize < -1 || !std::isfinite(compressedRatio) || compressedRatio < 0.0 || compressedRatio > 1.0) {
      return napi_invalid_arg;
    }

    if (cacheSize == -1) {
      if (cache) {
        tableOptions.block_cache = cache;
      } else {
        tableOptions.no_block_cache = true;
      }
    } else if (cacheSize == 0) {
      tableOptions.block_cache.reset();
      tableOptions.no_block_cache = true;
    } else if (compressedRatio > 0.0) {
      rocksdb::TieredCacheOptions options;
      options.cache_type = rocksdb::PrimaryCacheType::kCacheTypeHCC;
      options.total_capacity = cacheSize;
      options.compressed_secondary_ratio = compressedRatio;
      tableOptions.block_cache = rocksdb::NewTieredCache(options);
    } else {
      tableOptions.block_cache = rocksdb::HyperClockCacheOptions(cacheSize, 0).MakeSharedCache();
    }
  }

  {
    // int64: see the block-cache block above — -1 = unset, avoids 32-bit wrap
    // and the unset/4-GiB sentinel collision.
    int64_t cacheSize = -1;
    double compressedRatio = 0.0;

    NAPI_STATUS_RETURN(GetProperty(env, options, "cachePrepopulate", columnOptions.prepopulate_blob_cache));
    NAPI_STATUS_RETURN(GetProperty(env, options, "prepopulateBlobCache", columnOptions.prepopulate_blob_cache));

    NAPI_STATUS_RETURN(GetProperty(env, options, "blobCacheSize", cacheSize));
    NAPI_STATUS_RETURN(GetProperty(env, options, "blobCacheCompressedRatio", compressedRatio));
    NAPI_STATUS_RETURN(GetProperty(env, options, "blobCachePrepopulate", columnOptions.prepopulate_blob_cache));

    if (cacheSize < -1 || !std::isfinite(compressedRatio) || compressedRatio < 0.0 || compressedRatio > 1.0) {
      return napi_invalid_arg;
    }

    if (cacheSize == -1) {
      columnOptions.blob_cache = cache;
    } else if (cacheSize == 0) {
      columnOptions.blob_cache = nullptr;
    } else if (compressedRatio > 0.0) {
      rocksdb::TieredCacheOptions options;
      // Match the block/main cache tiers: pin the primary tier to HyperClockCache
      // explicitly rather than letting it default to LRU.
      options.cache_type = rocksdb::PrimaryCacheType::kCacheTypeHCC;
      options.total_capacity = cacheSize;
      options.compressed_secondary_ratio = compressedRatio;
      options.comp_cache_opts.compression_type = rocksdb::CompressionType::kZSTD;
      columnOptions.blob_cache = rocksdb::NewTieredCache(options);
    } else {
      columnOptions.blob_cache = rocksdb::HyperClockCacheOptions(cacheSize, 0).MakeSharedCache();
    }
  }

  std::string optimize = "";
  NAPI_STATUS_RETURN(GetProperty(env, options, "optimize", optimize));

  if (optimize == "") {
    tableOptions.filter_policy.reset(rocksdb::NewBloomFilterPolicy(10));
  } else if (optimize == "point-lookup") {
    tableOptions.data_block_index_type = rocksdb::BlockBasedTableOptions::kDataBlockBinaryAndHash;
    tableOptions.data_block_hash_table_util_ratio = 0.75;
    tableOptions.filter_policy.reset(rocksdb::NewRibbonFilterPolicy(10, 2));

    columnOptions.memtable_prefix_bloom_size_ratio = 0.02;
    columnOptions.memtable_whole_key_filtering = true;
  } else if (optimize == "range-lookup") {
    // TODO?
  } else {
    return napi_invalid_arg;
  }

  std::string indexType;
  NAPI_STATUS_RETURN(GetProperty(env, options, "indexType", indexType));
  if (indexType == "") {
    // Do nothing...
  } else if (indexType == "binarySearch") {
    tableOptions.index_type = rocksdb::BlockBasedTableOptions::kBinarySearch;
  } else if (indexType == "hashSearch") {
    tableOptions.index_type = rocksdb::BlockBasedTableOptions::kHashSearch;
  } else if (indexType == "twoLevelIndexSearch") {
    tableOptions.index_type = rocksdb::BlockBasedTableOptions::kTwoLevelIndexSearch;
  } else if (indexType == "binarySearchWithFirstKey") {
    tableOptions.index_type = rocksdb::BlockBasedTableOptions::kBinarySearchWithFirstKey;
  } else {
    return napi_invalid_arg;
  }

  std::string dataBlockIndexType;
  NAPI_STATUS_RETURN(GetProperty(env, options, "dataBlockIndexType", dataBlockIndexType));
  if (dataBlockIndexType == "") {
    // Do nothing...
  } else if (dataBlockIndexType == "dataBlockBinarySearch") {
    tableOptions.data_block_index_type = rocksdb::BlockBasedTableOptions::kDataBlockBinarySearch;
  } else if (dataBlockIndexType == "dataBlockBinaryAndHash") {
    tableOptions.data_block_index_type = rocksdb::BlockBasedTableOptions::kDataBlockBinaryAndHash;
  } else {
    return napi_invalid_arg;
  }

  std::string filterPolicy;
  NAPI_STATUS_RETURN(GetProperty(env, options, "filterPolicy", filterPolicy));
  if (filterPolicy != "") {
    ROCKS_STATUS_RETURN_NAPI(
        rocksdb::FilterPolicy::CreateFromString(configOptions, filterPolicy, &tableOptions.filter_policy));
  }

  std::string indexShortening;
  NAPI_STATUS_RETURN(GetProperty(env, options, "indexShortening", indexShortening));
  if (indexShortening == "") {
    // Do nothing..
  } else if (indexShortening == "noShortening") {
    tableOptions.index_shortening = rocksdb::BlockBasedTableOptions::IndexShorteningMode::kNoShortening;
  } else if (indexShortening == "shortenSeparators") {
    tableOptions.index_shortening = rocksdb::BlockBasedTableOptions::IndexShorteningMode::kShortenSeparators;
  } else if (indexShortening == "shortenSeparatorsAndSuccessor") {
    tableOptions.index_shortening =
        rocksdb::BlockBasedTableOptions::IndexShorteningMode::kShortenSeparatorsAndSuccessor;
  } else {
    return napi_invalid_arg;
  }

  NAPI_STATUS_RETURN(
      GetProperty(env, options, "dataBlockHashTableUtilRatio", tableOptions.data_block_hash_table_util_ratio));
  NAPI_STATUS_RETURN(GetProperty(env, options, "blockSize", tableOptions.block_size));
  NAPI_STATUS_RETURN(GetProperty(env, options, "blockRestartInterval", tableOptions.block_restart_interval));
  NAPI_STATUS_RETURN(GetProperty(env, options, "blockAlign", tableOptions.block_align));
  NAPI_STATUS_RETURN(
      GetProperty(env, options, "cacheIndexAndFilterBlocks", tableOptions.cache_index_and_filter_blocks));
  NAPI_STATUS_RETURN(GetProperty(env, options, "cacheIndexAndFilterBlocksWithHighPriority",
                                 tableOptions.cache_index_and_filter_blocks_with_high_priority));
  NAPI_STATUS_RETURN(GetProperty(env, options, "decouplePartitionedFilters", tableOptions.decouple_partitioned_filters));
  NAPI_STATUS_RETURN(GetProperty(env, options, "optimizeFiltersForMemory", tableOptions.optimize_filters_for_memory));
  NAPI_STATUS_RETURN(GetProperty(env, options, "maxAutoReadaheadSize", tableOptions.max_auto_readahead_size));
  NAPI_STATUS_RETURN(GetProperty(env, options, "initialAutoReadaheadSize", tableOptions.initial_auto_readahead_size));
  NAPI_STATUS_RETURN(
      GetProperty(env, options, "numFileReadsForAutoReadahead", tableOptions.num_file_reads_for_auto_readahead));

  columnOptions.table_factory.reset(rocksdb::NewBlockBasedTableFactory(tableOptions));

  return napi_ok;
}

NAPI_METHOD(db_get_identity) {
  NAPI_ARGV(1);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  if (!database->db) {
    napi_throw_error(env, "LEVEL_DATABASE_NOT_OPEN", "Database is not open");
    return NULL;
  }

  std::string identity;
  ROCKS_STATUS_THROWS_NAPI(database->db->GetDbIdentity(identity));

  napi_value result;
  NAPI_STATUS_THROWS(Convert(env, identity, Encoding::String, result));

  return result;
}

NAPI_METHOD(db_open) {
  NAPI_ARGV(3);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference, false));

  {
    rocksdb::Options dbOptions;

    const auto options = argv[1];

    int parallelism = std::max<int>(1, std::thread::hardware_concurrency() / 2);
    NAPI_STATUS_THROWS(GetProperty(env, options, "parallelism", parallelism));
    dbOptions.IncreaseParallelism(parallelism);

    // IncreaseParallelism sizes the (process-wide) Env LOW pool to `parallelism`
    // but pins the HIGH pool — where every flush of every DB sharing the default
    // Env runs — at a single thread, so flushes across DBs serialize behind one
    // thread. Both pools are process-wide: the last opened DB's value wins.
    int flushParallelism = std::max(1, parallelism / 4);
    NAPI_STATUS_THROWS(GetProperty(env, options, "flushParallelism", flushParallelism));
    dbOptions.env->SetBackgroundThreads(std::max(1, flushParallelism), rocksdb::Env::HIGH);

    NAPI_STATUS_THROWS(GetProperty(env, options, "walDir", dbOptions.wal_dir));

    // 64-bit inputs: walTTL is in ms and walSizeLimit in bytes, so a 32-bit type
    // wraps a >= ~4.3 GB size limit (or a ~49-day TTL) before the unit conversion.
    uint64_t walTTL = 0;
    NAPI_STATUS_THROWS(GetProperty(env, options, "walTTL", walTTL));
    dbOptions.WAL_ttl_seconds = static_cast<uint64_t>(std::ceil(walTTL / 1e3));

    uint64_t walSizeLimit = 0;
    NAPI_STATUS_THROWS(GetProperty(env, options, "walSizeLimit", walSizeLimit));
    dbOptions.WAL_size_limit_MB = static_cast<uint64_t>(std::ceil(walSizeLimit / 1e6));

    NAPI_STATUS_THROWS(GetProperty(env, options, "maxTotalWalSize", dbOptions.max_total_wal_size));

    bool walCompression = true;
    NAPI_STATUS_THROWS(GetProperty(env, options, "walCompression", walCompression));
    dbOptions.wal_compression =
        walCompression ? rocksdb::CompressionType::kZSTD : rocksdb::CompressionType::kNoCompression;

    dbOptions.avoid_unnecessary_blocking_io = true;
    NAPI_STATUS_THROWS(
        GetProperty(env, options, "avoidUnnecessaryBlockingIO", dbOptions.avoid_unnecessary_blocking_io));

    dbOptions.create_missing_column_families = true;
    NAPI_STATUS_THROWS(
        GetProperty(env, options, "createMissingColumnFamilies", dbOptions.create_missing_column_families));

    NAPI_STATUS_THROWS(GetProperty(env, options, "writeDbIdToManifest", dbOptions.write_dbid_to_manifest));

    NAPI_STATUS_THROWS(GetProperty(env, options, "adviseRandomOnOpen", dbOptions.advise_random_on_open));

    NAPI_STATUS_THROWS(GetProperty(env, options, "bytesPerSync", dbOptions.bytes_per_sync));

    NAPI_STATUS_THROWS(GetProperty(env, options, "walBytesPerSync", dbOptions.wal_bytes_per_sync));

    NAPI_STATUS_THROWS(GetProperty(env, options, "strictBytesPerSync", dbOptions.strict_bytes_per_sync));

    NAPI_STATUS_THROWS(GetProperty(env, options, "delayedWriteRate", dbOptions.delayed_write_rate));

    NAPI_STATUS_THROWS(GetProperty(env, options, "createIfMissing", dbOptions.create_if_missing));

    NAPI_STATUS_THROWS(GetProperty(env, options, "errorIfExists", dbOptions.error_if_exists));

    NAPI_STATUS_THROWS(GetProperty(env, options, "pipelinedWrite", dbOptions.enable_pipelined_write));

    NAPI_STATUS_THROWS(GetProperty(env, options, "dailyOffpeakTime", dbOptions.daily_offpeak_time_utc));

    NAPI_STATUS_THROWS(GetProperty(env, options, "unorderedWrite", dbOptions.unordered_write));

    NAPI_STATUS_THROWS(GetProperty(env, options, "allowMmapReads", dbOptions.allow_mmap_reads));

    NAPI_STATUS_THROWS(GetProperty(env, options, "allowMmapWrites", dbOptions.allow_mmap_writes));

    NAPI_STATUS_THROWS(GetProperty(env, options, "memTableHugePageSize", dbOptions.memtable_huge_page_size));

    NAPI_STATUS_THROWS(GetProperty(env, options, "useDirectIOReads", dbOptions.use_direct_reads));

    NAPI_STATUS_THROWS(GetProperty(env, options, "useDirectIOForFlushAndCompaction",
                                   dbOptions.use_direct_io_for_flush_and_compaction));

    NAPI_STATUS_THROWS(GetProperty(env, options, "compactionReadaheadSize", dbOptions.compaction_readahead_size));

    NAPI_STATUS_THROWS(GetProperty(env, options, "useAdaptiveMutex", dbOptions.use_adaptive_mutex));

    NAPI_STATUS_THROWS(GetProperty(env, options, "writeBufferSize", dbOptions.db_write_buffer_size));

    {
      napi_value wbmValue;
      NAPI_STATUS_THROWS(napi_get_named_property(env, options, "writeBufferManager", &wbmValue));

      napi_valuetype wbmType;
      NAPI_STATUS_THROWS(napi_typeof(env, wbmValue, &wbmType));

      if (wbmType == napi_object || wbmType == napi_bigint) {
        std::shared_ptr<WriteBufferManagerResource> resource;
        if (LookupResourceHandle(env, wbmValue, HandleRegistry<WriteBufferManagerResource>::Instance(), resource) !=
            napi_ok) {
          napi_throw_error(env, nullptr, "invalid writeBufferManager handle");
          return NULL;
        }
        dbOptions.write_buffer_manager = resource->value;
      } else if (wbmType != napi_undefined && wbmType != napi_null) {
        napi_throw_error(env, nullptr, "invalid writeBufferManager");
        return NULL;
      }
    }

    NAPI_STATUS_THROWS(GetProperty(env, options, "manualWALFlush", dbOptions.manual_wal_flush));
    NAPI_STATUS_THROWS(GetProperty(env, options, "walManualFlush", dbOptions.manual_wal_flush));

    // TODO (feat): dbOptions.listeners

    std::string infoLogLevel;
    NAPI_STATUS_THROWS(GetProperty(env, options, "infoLogLevel", infoLogLevel));
    if (infoLogLevel.size() > 0) {
      rocksdb::InfoLogLevel lvl = {};

      if (infoLogLevel == "debug")
        lvl = rocksdb::InfoLogLevel::DEBUG_LEVEL;
      else if (infoLogLevel == "info")
        lvl = rocksdb::InfoLogLevel::INFO_LEVEL;
      else if (infoLogLevel == "warn")
        lvl = rocksdb::InfoLogLevel::WARN_LEVEL;
      else if (infoLogLevel == "error")
        lvl = rocksdb::InfoLogLevel::ERROR_LEVEL;
      else if (infoLogLevel == "fatal")
        lvl = rocksdb::InfoLogLevel::FATAL_LEVEL;
      else if (infoLogLevel == "header")
        lvl = rocksdb::InfoLogLevel::HEADER_LEVEL;
      else {
        napi_throw_error(env, nullptr, "invalid log level");
        return nullptr;
      }

      dbOptions.info_log_level = lvl;
    } else {
      // In some places RocksDB checks this option to see if it should prepare
      // debug information (ahead of logging), so set it to the highest level.
      dbOptions.info_log_level = rocksdb::InfoLogLevel::HEADER_LEVEL;
      dbOptions.info_log.reset(new NullLogger());
    }

    {
      napi_value statisticsValue;
      NAPI_STATUS_THROWS(napi_get_named_property(env, options, "statistics", &statisticsValue));

      napi_valuetype statisticsType;
      NAPI_STATUS_THROWS(napi_typeof(env, statisticsValue, &statisticsType));

      if (statisticsType == napi_boolean) {
        bool enableStatistics = false;
        NAPI_STATUS_THROWS(napi_get_value_bool(env, statisticsValue, &enableStatistics));
        if (enableStatistics) {
          auto statistics = rocksdb::CreateDBStatistics();
          // The legacy per-DB collector starts disabled unless explicitly
          // enabled. A shared resource owns its level independently below.
          bool statisticsEnabled = false;
          NAPI_STATUS_THROWS(GetProperty(env, options, "statisticsEnabled", statisticsEnabled));
          statistics->set_stats_level(statisticsEnabled
                                          ? rocksdb::StatsLevel::kExceptHistogramOrTimers
                                          : rocksdb::StatsLevel::kExceptTickers);
          dbOptions.statistics = std::move(statistics);
        }
      } else if (statisticsType == napi_external) {
        bool isStatistics = false;
        NAPI_STATUS_THROWS(
            napi_check_object_type_tag(env, statisticsValue, &kStatisticsTypeTag, &isStatistics));
        if (!isStatistics) {
          napi_throw_type_error(env, nullptr, "invalid statistics resource");
          return NULL;
        }

        std::shared_ptr<rocksdb::Statistics>* statistics;
        NAPI_STATUS_THROWS(
            napi_get_value_external(env, statisticsValue, reinterpret_cast<void**>(&statistics)));
        if (!statistics || !*statistics) {
          napi_throw_type_error(env, nullptr, "invalid statistics resource");
          return NULL;
        }

        // Copy the shared_ptr while the external is alive. DBOptions and the
        // Database retain the collector even if the JS resource is collected.
        dbOptions.statistics = *statistics;
      } else if (statisticsType != napi_undefined && statisticsType != napi_null) {
        napi_throw_type_error(env, nullptr, "statistics must be a boolean or RocksStatistics resource");
        return NULL;
      }
    }

    std::vector<rocksdb::ColumnFamilyDescriptor> descriptors;

    bool hasColumns;
    NAPI_STATUS_THROWS(napi_has_named_property(env, options, "columns", &hasColumns));

    if (hasColumns) {
      napi_value columns;
      NAPI_STATUS_THROWS(napi_get_named_property(env, options, "columns", &columns));

      napi_value keys;
      NAPI_STATUS_THROWS(napi_get_property_names(env, columns, &keys));

      uint32_t len;
      NAPI_STATUS_THROWS(napi_get_array_length(env, keys, &len));

      descriptors.resize(len);
      for (uint32_t n = 0; n < len; ++n) {
        napi_value key;
        NAPI_STATUS_THROWS(napi_get_element(env, keys, n, &key));

        napi_value column;
        NAPI_STATUS_THROWS(napi_get_property(env, columns, key, &column));

        NAPI_STATUS_THROWS(InitOptions(env, descriptors[n].options, column));

        NAPI_STATUS_THROWS(GetValue(env, key, descriptors[n].name));
      }
    }

    // In the descriptor overload RocksDB consumes DBOptions plus each explicit
    // ColumnFamilyOptions; the ColumnFamilyOptions half of `dbOptions` is
    // ignored. Avoid constructing an unused cache/table factory on every
    // multi-column open.
    if (descriptors.empty()) {
      NAPI_STATUS_THROWS(InitOptions(env, dbOptions, options));
    }

    auto callback = argv[2];

    napi_value resourceName;
    NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownOpen, resourceName));

    NAPI_STATUS_THROWS(runAsyncKeepAlive<OpenSnapshot>(
        resourceName, env, callback, argv[0],
        [database, reference, dbOptions = std::move(dbOptions), descriptors = std::move(descriptors)](
            auto& snapshot) {
          return database->Open(reference, dbOptions, descriptors, snapshot);
        },
        [reference](auto& snapshot, napi_env env, napi_value* result) {
          return CreateColumnsObject(env, reference->database, snapshot, result);
        }));
  }

  return 0;
}

NAPI_METHOD(db_close) {
  NAPI_ARGV(2);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference, false));

  auto callback = argv[1];

  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownClose, resourceName));

  NAPI_STATUS_THROWS(
      runAsyncKeepAlive(resourceName, env, callback, argv[0], [=](auto& state) { return database->Close(reference); }));

  return 0;
}

NAPI_METHOD(db_dispose) {
  NAPI_ARGV(1);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference, false));
  ROCKS_STATUS_THROWS_NAPI(database->Dispose(reference));
  return nullptr;
}

NAPI_METHOD(db_get_many_sync) {
  NAPI_ARGV(3);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  uint32_t count;
  NAPI_STATUS_THROWS(napi_get_array_length(env, argv[1], &count));

  rocksdb::ColumnFamilyHandle* column = database->db->DefaultColumnFamily();
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[2], database, column));

  Encoding valueEncoding = Encoding::Buffer;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "valueEncoding", valueEncoding));

  uint32_t timeout = 0;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "timeout", timeout));

  bool unsafe = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "unsafe", unsafe));

  std::vector<rocksdb::Slice> keys;
  keys.resize(count);
  std::vector<rocksdb::Status> statuses;
  statuses.resize(count);
  std::vector<rocksdb::PinnableSlice> values;
  values.resize(count);

  for (uint32_t n = 0; n < count; n++) {
    napi_value element;
    NAPI_STATUS_THROWS(napi_get_element(env, argv[1], n, &element));
    NAPI_STATUS_THROWS(GetValue(env, element, keys[n]));
  }

  rocksdb::ReadOptions readOptions;
  readOptions.deadline =
      timeout ? std::chrono::microseconds(database->db->GetEnv()->NowMicros() + static_cast<uint64_t>(timeout) * 1000)
              : std::chrono::microseconds::zero();

  readOptions.fill_cache = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "fillCache", readOptions.fill_cache));

  // Local NVMe/SSD gains nothing from RocksDB async I/O (io_uring): it only adds
  // CPU + ring overhead (async-io wins need high-latency/remote storage). Default
  // OFF; callers opt in per-request via `asyncIO`.
  readOptions.async_io = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "asyncIO", readOptions.async_io));

  readOptions.optimize_multiget_for_io = true;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "optimizeMultigetForIO", readOptions.optimize_multiget_for_io));

  readOptions.value_size_soft_limit = std::numeric_limits<int32_t>::max();
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "highWaterMarkBytes", readOptions.value_size_soft_limit));

  database->db->MultiGet(readOptions, column, count, keys.data(), values.data(), statuses.data());

  napi_value rows;
  NAPI_STATUS_THROWS(napi_create_array_with_length(env, count, &rows));

  for (uint32_t n = 0; n < count; n++) {
    napi_value row;
    if (statuses[n].IsNotFound()) {
      NAPI_STATUS_THROWS(napi_get_undefined(env, &row));
    } else if (statuses[n].IsAborted() || statuses[n].IsTimedOut()) {
      NAPI_STATUS_THROWS(napi_get_null(env, &row));
    } else {
      ROCKS_STATUS_THROWS_NAPI(statuses[n]);
      // MultiGet may return either cache-pinned or internally-owned slices.
      // Keep one stable copy policy for the whole batch: hundreds of external
      // Buffer finalizers were slower in profiling and cannot safely outlive
      // every RocksDB ownership mode.
      NAPI_STATUS_THROWS(Convert(env, std::move(values[n]), valueEncoding, row, unsafe, false));
    }
    NAPI_STATUS_THROWS(napi_set_element(env, rows, n, row));
  }

  return rows;
}

NAPI_METHOD(db_get_many) {
  NAPI_ARGV(4);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  uint32_t count;
  NAPI_STATUS_THROWS(napi_get_array_length(env, argv[1], &count));

  rocksdb::ColumnFamilyHandle* column = database->db->DefaultColumnFamily();
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[2], database, column));

  Encoding valueEncoding = Encoding::Buffer;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "valueEncoding", valueEncoding));

  uint32_t timeout = 0;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "timeout", timeout));

  bool unsafe = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "unsafe", unsafe));

  auto callback = argv[3];

  std::vector<std::string> ownedKeys(count);

  for (uint32_t n = 0; n < count; n++) {
    napi_value element;
    NAPI_STATUS_THROWS(napi_get_element(env, argv[1], n, &element));
    // Async work must not borrow Buffer or SliceLike storage. The caller can
    // mutate or release the original objects as soon as this method returns.
    // Snapshot every key on the JS thread regardless of output options.
    NAPI_STATUS_THROWS(GetValue(env, element, ownedKeys[n]));
  }

  rocksdb::ReadOptions readOptions;
  readOptions.deadline =
      timeout ? std::chrono::microseconds(database->db->GetEnv()->NowMicros() + static_cast<uint64_t>(timeout) * 1000)
              : std::chrono::microseconds::zero();
  readOptions.fill_cache = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "fillCache", readOptions.fill_cache));

  // Local NVMe/SSD gains nothing from RocksDB async I/O (io_uring): it only adds
  // CPU + ring overhead (async-io wins need high-latency/remote storage). Default
  // OFF; callers opt in per-request via `asyncIO`.
  readOptions.async_io = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "asyncIO", readOptions.async_io));

  readOptions.optimize_multiget_for_io = true;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "optimizeMultigetForIO", readOptions.optimize_multiget_for_io));

  readOptions.value_size_soft_limit = std::numeric_limits<int32_t>::max();
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "highWaterMarkBytes", readOptions.value_size_soft_limit));

  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownGetMany, resourceName));

  struct State {
    std::vector<rocksdb::Status> statuses;
    std::vector<rocksdb::PinnableSlice> values;
  };

  NAPI_STATUS_THROWS(runAsyncKeepAlive<State>(
      resourceName, env, callback, argv[0],
      [=, ownedKeys = std::move(ownedKeys), readOptions = std::move(readOptions)](auto& state) {
        // MultiGet can return slices pinned to RocksDB cache memory. Retain the
        // operation through JS conversion (the async worker owns this functor
        // until Complete) so safe conversion performs only its one required
        // copy and raw db_close cannot tear down the cache first.
        (void)databaseOperation;

        std::vector<rocksdb::Slice> keys;
        keys.reserve(ownedKeys.size());
        for (const auto& key : ownedKeys) {
          keys.emplace_back(key);
        }

        state.statuses.resize(count);
        state.values.resize(count);

        database->db->MultiGet(readOptions, column, count, keys.data(), state.values.data(), state.statuses.data());

        return rocksdb::Status::OK();
      },
      [=](auto& state, napi_env env, napi_value* result) {
        NAPI_STATUS_RETURN(napi_create_array_with_length(env, count, result));

        for (uint32_t n = 0; n < count; n++) {
          napi_value row;
          if (state.statuses[n].IsNotFound()) {
            NAPI_STATUS_RETURN(napi_get_undefined(env, &row));
          } else if (state.statuses[n].IsAborted() || state.statuses[n].IsTimedOut()) {
            NAPI_STATUS_RETURN(napi_get_null(env, &row));
          } else {
            ROCKS_STATUS_RETURN_NAPI(state.statuses[n]);
            NAPI_STATUS_RETURN(Convert(env, std::move(state.values[n]), valueEncoding, row, unsafe, false));
          }
          NAPI_STATUS_RETURN(napi_set_element(env, *result, n, row));
        }

        return napi_ok;
      }));

  return 0;
}

NAPI_METHOD(db_clear) {
  NAPI_ARGV(3);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  const auto options = argv[1];

  bool reverse = false;
  NAPI_STATUS_THROWS(GetProperty(env, options, "reverse", reverse));

  int32_t limit = -1;
  NAPI_STATUS_THROWS(GetProperty(env, options, "limit", limit));
  if (limit < -1) {
    napi_throw_range_error(env, nullptr, "limit must be -1 or non-negative");
    return nullptr;
  }

  rocksdb::ColumnFamilyHandle* column = database->db->DefaultColumnFamily();
  NAPI_STATUS_THROWS(GetColumnProperty(env, options, database, column));

  std::optional<std::string> lt;
  NAPI_STATUS_THROWS(GetProperty(env, options, "lt", lt));

  std::optional<std::string> lte;
  NAPI_STATUS_THROWS(GetProperty(env, options, "lte", lte));

  std::optional<std::string> gt;
  NAPI_STATUS_THROWS(GetProperty(env, options, "gt", gt));

  std::optional<std::string> gte;
  NAPI_STATUS_THROWS(GetProperty(env, options, "gte", gte));

  // Match abstract-level range precedence when both forms are present.
  if (gte) gt.reset();
  if (lte) lt.reset();

  bool sync = false;
  NAPI_STATUS_THROWS(GetProperty(env, options, "sync", sync));

  bool lowPriority = false;
  NAPI_STATUS_THROWS(GetProperty(env, options, "lowPriority", lowPriority));

  const auto callback = argv[2];
  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownClear, resourceName));

  NAPI_STATUS_THROWS(runAsyncKeepAlive(
      resourceName, env, callback, argv[0],
      [database, databaseOperation, column, reverse, limit, lt = std::move(lt), lte = std::move(lte),
       gt = std::move(gt), gte = std::move(gte), sync, lowPriority](auto& state) {
        const DatabaseOperationScope operationScope(databaseOperation);
        if (limit == 0) {
          return rocksdb::Status::OK();
        }

        rocksdb::WriteOptions writeOptions;
        writeOptions.sync = sync;
        writeOptions.low_pri = lowPriority;
        rocksdb::ReadOptions readOptions;
        readOptions.fill_cache = false;
        const auto* comparator = column->GetComparator();

        // An unlimited bytewise range can be represented by one range tombstone.
        // For an unbounded upper end, derive a finite successor from the actual
        // last key instead of guessing at a maximum key length.
        if (limit == -1 && comparator == rocksdb::BytewiseComparator()) {
          std::string begin;
          if (gte) {
            begin = *gte;
          } else if (gt) {
            begin = *gt;
            begin.push_back('\0');
          }

          std::string end;
          if (lte) {
            end = *lte;
            end.push_back('\0');
          } else if (lt) {
            end = *lt;
          } else {
            std::unique_ptr<rocksdb::Iterator> iterator(database->db->NewIterator(readOptions, column));
            iterator->SeekToLast();
            ROCKS_STATUS_RETURN(iterator->status());
            if (!iterator->Valid()) {
              return rocksdb::Status::OK();
            }
            end = iterator->key().ToString();
            end.push_back('\0');
          }

          if (rocksdb::Slice(begin).compare(end) < 0) {
            return database->db->DeleteRange(writeOptions, column, begin, end);
          }
          return rocksdb::Status::OK();
        }

        // Limited clears and custom comparators cannot safely synthesize an
        // exclusive successor. Delete concrete keys in bounded write batches.
        std::unique_ptr<rocksdb::Iterator> iterator(database->db->NewIterator(readOptions, column));
        const auto equal = [comparator](const rocksdb::Slice& a, const std::string& b) {
          return comparator->Compare(a, b) == 0;
        };

        if (reverse) {
          if (lte) {
            iterator->SeekForPrev(*lte);
          } else if (lt) {
            iterator->SeekForPrev(*lt);
            if (iterator->Valid() && equal(iterator->key(), *lt)) {
              iterator->Prev();
            }
          } else {
            iterator->SeekToLast();
          }
        } else if (gte) {
          iterator->Seek(*gte);
        } else if (gt) {
          iterator->Seek(*gt);
          if (iterator->Valid() && equal(iterator->key(), *gt)) {
            iterator->Next();
          }
        } else {
          iterator->SeekToFirst();
        }

        const auto inRange = [&](const rocksdb::Slice& key) {
          if (gte && comparator->Compare(key, *gte) < 0) return false;
          if (gt && comparator->Compare(key, *gt) <= 0) return false;
          if (lte && comparator->Compare(key, *lte) > 0) return false;
          if (lt && comparator->Compare(key, *lt) >= 0) return false;
          return true;
        };

        rocksdb::WriteBatch batch;
        size_t batchBytes = 0;
        int64_t deleted = 0;
        while (iterator->Valid() && inRange(iterator->key()) && (limit < 0 || deleted < limit)) {
          const auto key = iterator->key();
          ROCKS_STATUS_RETURN(batch.Delete(column, key));
          batchBytes += key.size();
          ++deleted;

          if (reverse) {
            iterator->Prev();
          } else {
            iterator->Next();
          }

          if (batchBytes >= 16 * 1024) {
            ROCKS_STATUS_RETURN(database->db->Write(writeOptions, &batch));
            batch.Clear();
            batchBytes = 0;
          }
        }

        ROCKS_STATUS_RETURN(iterator->status());
        return batch.Count() == 0 ? rocksdb::Status::OK() : database->db->Write(writeOptions, &batch);
      }));

  return nullptr;
}

NAPI_METHOD(db_get_property) {
  NAPI_ARGV(3);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  if (!database->db) {
    napi_throw_error(env, "LEVEL_DATABASE_NOT_OPEN", "Database is not open");
    return NULL;
  }

  rocksdb::PinnableSlice property;
  NAPI_STATUS_THROWS(GetValue(env, argv[1], property));

  // Most rocksdb properties are column-family scoped; without an explicit
  // column they answer for the default CF only.
  rocksdb::ColumnFamilyHandle* column = database->db->DefaultColumnFamily();
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[2], database, column));

  std::string value;
  database->db->GetProperty(column, property, &value);

  napi_value result;
  NAPI_STATUS_THROWS(napi_create_string_utf8(env, value.data(), value.size(), &result));

  return result;
}

static napi_status CreateStatisticsSnapshot(napi_env env,
                                            const std::shared_ptr<rocksdb::Statistics>& statistics,
                                            napi_value* result) {
  NAPI_STATUS_RETURN(napi_create_object(env, result));

  auto setTicker = [&](const char* name, uint32_t ticker) -> napi_status {
    napi_value value;
    NAPI_STATUS_RETURN(
        napi_create_double(env, static_cast<double>(statistics->getTickerCount(ticker)), &value));
    return napi_set_named_property(env, *result, name, value);
  };

  NAPI_STATUS_RETURN(setTicker("blockCacheHit", rocksdb::BLOCK_CACHE_HIT));
  NAPI_STATUS_RETURN(setTicker("blockCacheMiss", rocksdb::BLOCK_CACHE_MISS));
  NAPI_STATUS_RETURN(setTicker("blockCacheDataHit", rocksdb::BLOCK_CACHE_DATA_HIT));
  NAPI_STATUS_RETURN(setTicker("blockCacheDataMiss", rocksdb::BLOCK_CACHE_DATA_MISS));
  NAPI_STATUS_RETURN(setTicker("blockCacheIndexHit", rocksdb::BLOCK_CACHE_INDEX_HIT));
  NAPI_STATUS_RETURN(setTicker("blockCacheIndexMiss", rocksdb::BLOCK_CACHE_INDEX_MISS));
  NAPI_STATUS_RETURN(setTicker("blockCacheFilterHit", rocksdb::BLOCK_CACHE_FILTER_HIT));
  NAPI_STATUS_RETURN(setTicker("blockCacheFilterMiss", rocksdb::BLOCK_CACHE_FILTER_MISS));
  NAPI_STATUS_RETURN(setTicker("blockCacheBytesRead", rocksdb::BLOCK_CACHE_BYTES_READ));
  NAPI_STATUS_RETURN(setTicker("blockCacheBytesWrite", rocksdb::BLOCK_CACHE_BYTES_WRITE));

  NAPI_STATUS_RETURN(setTicker("blobCacheHit", rocksdb::BLOB_DB_CACHE_HIT));
  NAPI_STATUS_RETURN(setTicker("blobCacheMiss", rocksdb::BLOB_DB_CACHE_MISS));
  NAPI_STATUS_RETURN(setTicker("blobCacheAdd", rocksdb::BLOB_DB_CACHE_ADD));
  NAPI_STATUS_RETURN(setTicker("blobCacheAddFailures", rocksdb::BLOB_DB_CACHE_ADD_FAILURES));
  NAPI_STATUS_RETURN(setTicker("blobCacheBytesRead", rocksdb::BLOB_DB_CACHE_BYTES_READ));
  NAPI_STATUS_RETURN(setTicker("blobCacheBytesWrite", rocksdb::BLOB_DB_CACHE_BYTES_WRITE));

  NAPI_STATUS_RETURN(setTicker("bloomFilterUseful", rocksdb::BLOOM_FILTER_USEFUL));
  NAPI_STATUS_RETURN(setTicker("bloomFilterFullPositive", rocksdb::BLOOM_FILTER_FULL_POSITIVE));
  NAPI_STATUS_RETURN(
      setTicker("bloomFilterFullTruePositive", rocksdb::BLOOM_FILTER_FULL_TRUE_POSITIVE));

  NAPI_STATUS_RETURN(setTicker("memtableHit", rocksdb::MEMTABLE_HIT));
  NAPI_STATUS_RETURN(setTicker("memtableMiss", rocksdb::MEMTABLE_MISS));
  NAPI_STATUS_RETURN(setTicker("getHitL0", rocksdb::GET_HIT_L0));
  NAPI_STATUS_RETURN(setTicker("getHitL1", rocksdb::GET_HIT_L1));
  NAPI_STATUS_RETURN(setTicker("getHitL2AndUp", rocksdb::GET_HIT_L2_AND_UP));

  // RocksLevel implements point reads with MultiGet, so the MultiGet tickers
  // are its user-visible read volume rather than DB::Get-only counters.
  NAPI_STATUS_RETURN(setTicker("bytesRead", rocksdb::NUMBER_MULTIGET_BYTES_READ));
  NAPI_STATUS_RETURN(setTicker("bytesWritten", rocksdb::BYTES_WRITTEN));
  NAPI_STATUS_RETURN(setTicker("numberKeysRead", rocksdb::NUMBER_MULTIGET_KEYS_READ));
  NAPI_STATUS_RETURN(setTicker("numberKeysWritten", rocksdb::NUMBER_KEYS_WRITTEN));
  NAPI_STATUS_RETURN(setTicker("numberDbSeek", rocksdb::NUMBER_DB_SEEK));
  NAPI_STATUS_RETURN(setTicker("numberDbNext", rocksdb::NUMBER_DB_NEXT));
  NAPI_STATUS_RETURN(setTicker("iterBytesRead", rocksdb::ITER_BYTES_READ));

  NAPI_STATUS_RETURN(setTicker("compactReadBytes", rocksdb::COMPACT_READ_BYTES));
  NAPI_STATUS_RETURN(setTicker("compactWriteBytes", rocksdb::COMPACT_WRITE_BYTES));
  NAPI_STATUS_RETURN(setTicker("flushWriteBytes", rocksdb::FLUSH_WRITE_BYTES));

  NAPI_STATUS_RETURN(setTicker("walFileBytes", rocksdb::WAL_FILE_BYTES));
  NAPI_STATUS_RETURN(setTicker("walFileSynced", rocksdb::WAL_FILE_SYNCED));
  NAPI_STATUS_RETURN(setTicker("stallMicros", rocksdb::STALL_MICROS));
  NAPI_STATUS_RETURN(setTicker("numberBlockCompressed", rocksdb::NUMBER_BLOCK_COMPRESSED));
  NAPI_STATUS_RETURN(setTicker("numberBlockDecompressed", rocksdb::NUMBER_BLOCK_DECOMPRESSED));

  return napi_ok;
}

// Toggle ticker collection at runtime on a DB with an attached collector.
// A shared collector changes globally for every DB that uses the resource.
NAPI_METHOD(db_set_stats_level) {
  NAPI_ARGV(2);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  bool enabled = false;
  NAPI_STATUS_THROWS(napi_get_value_bool(env, argv[1], &enabled));

  napi_value result;
  if (!database->statistics) {
    NAPI_STATUS_THROWS(napi_get_boolean(env, false, &result));
    return result;
  }

  database->statistics->set_stats_level(enabled ? rocksdb::StatsLevel::kExceptHistogramOrTimers
                                                : rocksdb::StatsLevel::kExceptTickers);

  NAPI_STATUS_THROWS(napi_get_boolean(env, true, &result));
  return result;
}

// Curated RocksDB ticker counts accumulated while collection is enabled, or
// null when no collector is attached. A resource snapshot spans every DB that
// shares it. Values above Number.MAX_SAFE_INTEGER may lose integer precision.
NAPI_METHOD(db_get_statistics) {
  NAPI_ARGV(1);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  if (!database->statistics) {
    napi_value nullResult;
    NAPI_STATUS_THROWS(napi_get_null(env, &nullResult));
    return nullResult;
  }

  napi_value result;
  NAPI_STATUS_THROWS(CreateStatisticsSnapshot(env, database->statistics, &result));
  return result;
}

NAPI_METHOD(db_get_latest_sequence) {
  NAPI_ARGV(1);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  if (!database->db) {
    napi_throw_error(env, "LEVEL_DATABASE_NOT_OPEN", "Database is not open");
    return NULL;
  }

  const auto seq = database->db->GetLatestSequenceNumber();

  napi_value result;
  NAPI_STATUS_THROWS(napi_create_int64(env, seq, &result));

  return result;
}

NAPI_METHOD(db_flush_wal) {
  NAPI_ARGV(3);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));

  bool sync;
  NAPI_STATUS_THROWS(GetValue(env, argv[1], sync));

  auto callback = argv[2];

  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownFlushWal, resourceName));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  NAPI_STATUS_THROWS(runAsyncKeepAlive(resourceName, env, callback, argv[0], [=](auto& state) {
    const DatabaseOperationScope operationScope(databaseOperation);
    return database->db->FlushWAL(sync);
  }));

  return 0;
}

NAPI_METHOD(iterator_init_sync) {
  NAPI_ARGV(2);

  napi_value result;
  try {
    auto iterator = Iterator::create(env, argv[0], argv[1]);
    // create() returns an empty shared_ptr (and a pending JS exception) on a
    // N-API failure; surface that instead of wrapping a null pointer.
    if (!iterator) {
      return nullptr;
    }

    NAPI_STATUS_THROWS(CreateResourceExternal(env, iterator, kIteratorReferenceTag, result));
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }

  return result;
}

NAPI_METHOD(iterator_refresh_sync) {
  NAPI_ARGV(1);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(
        BeginDatabaseOperation(env, iterator->database_, iterator->reference_, databaseOperation));

    ROCKS_STATUS_THROWS_NAPI(iterator->RefreshSafe());
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }

  return 0;
}

NAPI_METHOD(iterator_seek) {
  NAPI_ARGV(4);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    rocksdb::PinnableSlice target;
    NAPI_STATUS_THROWS(GetValue(env, argv[1], target));

    uint32_t discardedCount = 0;
    NAPI_STATUS_THROWS(GetValue(env, argv[2], discardedCount));

    auto callback = argv[3];

    napi_value resourceName;
    NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownIteratorSeek, resourceName));
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(
        BeginDatabaseOperation(env, iterator->database_, iterator->reference_, databaseOperation));

    NAPI_STATUS_THROWS(runAsync(resourceName, env, callback,
                                [iterator, databaseOperation, target = std::move(target),
                                 discardedCount](auto& state) {
                                  const DatabaseOperationScope operationScope(databaseOperation);
                                  return iterator->SeekSafe(target, discardedCount);
                                }));
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }

  return 0;
}

NAPI_METHOD(iterator_seek_sync) {
  NAPI_ARGV(3);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(
        BeginDatabaseOperation(env, iterator->database_, iterator->reference_, databaseOperation));

    rocksdb::PinnableSlice target;
    NAPI_STATUS_THROWS(GetValue(env, argv[1], target));

    uint32_t discardedCount = 0;
    NAPI_STATUS_THROWS(GetValue(env, argv[2], discardedCount));

    ROCKS_STATUS_THROWS_NAPI(iterator->SeekSafe(target, discardedCount));
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }

  return 0;
}

NAPI_METHOD(iterator_close_sync) {
  NAPI_ARGV(1);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    ROCKS_STATUS_THROWS_NAPI(iterator->Close());
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }

  return 0;
}

NAPI_METHOD(iterator_nextv) {
  NAPI_ARGV(4);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    uint32_t count = 1024;
    NAPI_STATUS_THROWS(GetValue(env, argv[1], count));

    uint32_t timeout = 0;
    NAPI_STATUS_THROWS(GetProperty(env, argv[2], "timeout", timeout));

    return iterator->nextv(env, count, timeout, argv[3]);
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(iterator_nextv_packed) {
  NAPI_ARGV(4);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    uint32_t count = 1024;
    NAPI_STATUS_THROWS(GetValue(env, argv[1], count));

    uint32_t timeout = 0;
    NAPI_STATUS_THROWS(GetProperty(env, argv[2], "timeout", timeout));

    return iterator->nextv(env, count, timeout, argv[3], true);
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(iterator_nextv_sync) {
  NAPI_ARGV(3);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    uint32_t count = 1024;
    NAPI_STATUS_THROWS(GetValue(env, argv[1], count));

    uint32_t timeout = 0;
    NAPI_STATUS_THROWS(GetProperty(env, argv[2], "timeout", timeout));

    return iterator->nextv(env, count, timeout);
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(batch_init) {
  NAPI_ARGV(1);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  auto batch = std::make_shared<NativeBatch>(std::move(reference));

  napi_value result;
  NAPI_STATUS_THROWS(CreateResourceExternal(env, batch, kBatchReferenceTag, result));

  return result;
}

NAPI_METHOD(batch_put) {
  NAPI_ARGV(4);

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[0], batch));
  Database* database = batch->reference->database.get();
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, batch->reference, databaseOperation));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, batch->reference));

  rocksdb::Slice key;
  NAPI_STATUS_THROWS(GetValue(env, argv[1], key));

  rocksdb::Slice val;
  NAPI_STATUS_THROWS(GetValue(env, argv[2], val));

  rocksdb::ColumnFamilyHandle* column = nullptr;
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[3], database, column, false));

  std::lock_guard lock(batch->mutex);
  if (column) {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Put(column, key, val));
  } else {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Put(key, val));
  }

  return 0;
}

// RocksDB copies SliceParts into the WriteBatch synchronously. Keep the common
// record layout (a handful of header/body slices) on the stack so accepting
// scatter/gather input does not replace one staging copy with a heap allocation.
struct NapiSliceParts {
  static constexpr size_t kInlineParts = 8;

  std::array<rocksdb::Slice, kInlineParts> inlineParts;
  std::vector<rocksdb::Slice> overflowParts;
  rocksdb::Slice* parts = inlineParts.data();
  int count = 0;

  rocksdb::SliceParts value() const { return {parts, count}; }
};

static napi_status GetBatchSliceParts(napi_env env, napi_value value, NapiSliceParts& result) {
  bool isArray = false;
  NAPI_STATUS_RETURN(napi_is_array(env, value, &isArray));

  if (!isArray) {
    result.count = 1;
    return GetValue(env, value, result.inlineParts[0]);
  }

  uint32_t count = 0;
  NAPI_STATUS_RETURN(napi_get_array_length(env, value, &count));
  if (count > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
    return napi_invalid_arg;
  }

  result.count = static_cast<int>(count);
  if (count > NapiSliceParts::kInlineParts) {
    result.overflowParts.resize(count);
    result.parts = result.overflowParts.data();
  }

  for (uint32_t index = 0; index < count; ++index) {
    napi_value part;
    NAPI_STATUS_RETURN(napi_get_element(env, value, index, &part));
    NAPI_STATUS_RETURN(GetValue(env, part, result.parts[index]));
  }

  return napi_ok;
}

NAPI_METHOD(batch_put_parts) {
  NAPI_ARGV(4);

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[0], batch));
  Database* database = batch->reference->database.get();
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, batch->reference, databaseOperation));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, batch->reference));

  NapiSliceParts keyStorage;
  NAPI_STATUS_THROWS(GetBatchSliceParts(env, argv[1], keyStorage));
  const auto key = keyStorage.value();

  NapiSliceParts valStorage;
  NAPI_STATUS_THROWS(GetBatchSliceParts(env, argv[2], valStorage));
  const auto val = valStorage.value();

  rocksdb::ColumnFamilyHandle* column = nullptr;
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[3], database, column, false));

  std::lock_guard lock(batch->mutex);
  if (column) {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Put(column, key, val));
  } else {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Put(key, val));
  }

  return 0;
}

NAPI_METHOD(batch_put_log_data) {
  NAPI_ARGV(2);

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[0], batch));
  Database* database = batch->reference->database.get();
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, batch->reference, databaseOperation));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, batch->reference));

  rocksdb::Slice blob;
  NAPI_STATUS_THROWS(GetValue(env, argv[1], blob));

  std::lock_guard lock(batch->mutex);
  ROCKS_STATUS_THROWS_NAPI(batch->batch.PutLogData(blob));

  return 0;
}

NAPI_METHOD(batch_del) {
  NAPI_ARGV(3);

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[0], batch));
  Database* database = batch->reference->database.get();
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, batch->reference, databaseOperation));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, batch->reference));

  rocksdb::Slice key;
  NAPI_STATUS_THROWS(GetValue(env, argv[1], key));

  rocksdb::ColumnFamilyHandle* column = nullptr;
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[2], database, column, false));

  std::lock_guard lock(batch->mutex);
  if (column) {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Delete(column, key));
  } else {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Delete(key));
  }

  return 0;
}

NAPI_METHOD(batch_merge) {
  NAPI_ARGV(4);

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[0], batch));
  Database* database = batch->reference->database.get();
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, batch->reference, databaseOperation));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, batch->reference));

  rocksdb::Slice key;
  NAPI_STATUS_THROWS(GetValue(env, argv[1], key));

  rocksdb::Slice val;
  NAPI_STATUS_THROWS(GetValue(env, argv[2], val));

  rocksdb::ColumnFamilyHandle* column = nullptr;
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[3], database, column, false));

  std::lock_guard lock(batch->mutex);
  if (column) {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Merge(column, key, val));
  } else {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Merge(key, val));
  }

  return 0;
}

NAPI_METHOD(batch_merge_parts) {
  NAPI_ARGV(4);

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[0], batch));
  Database* database = batch->reference->database.get();
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, batch->reference, databaseOperation));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, batch->reference));

  NapiSliceParts keyStorage;
  NAPI_STATUS_THROWS(GetBatchSliceParts(env, argv[1], keyStorage));
  const auto key = keyStorage.value();

  NapiSliceParts valStorage;
  NAPI_STATUS_THROWS(GetBatchSliceParts(env, argv[2], valStorage));
  const auto val = valStorage.value();

  rocksdb::ColumnFamilyHandle* column = nullptr;
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[3], database, column, false));

  std::lock_guard lock(batch->mutex);
  if (column) {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Merge(column, key, val));
  } else {
    ROCKS_STATUS_THROWS_NAPI(batch->batch.Merge(key, val));
  }

  return 0;
}

NAPI_METHOD(batch_clear) {
  NAPI_ARGV(1);

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[0], batch));

  std::lock_guard lock(batch->mutex);
  batch->batch.Clear();

  return 0;
}

NAPI_METHOD(batch_write) {
  NAPI_ARGV(4);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[1], batch));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, reference));
  bool sync = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "sync", sync));

  bool lowPriority = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "lowPriority", lowPriority));

  auto callback = argv[3];

  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownBatchWrite, resourceName));

  NAPI_STATUS_THROWS(runAsyncKeepAlive(resourceName, env, callback, argv[0], [=](auto& state) {
    const DatabaseOperationScope operationScope(databaseOperation);
    std::lock_guard lock(batch->mutex);
    rocksdb::WriteOptions writeOptions;
    writeOptions.sync = sync;
    writeOptions.low_pri = lowPriority;
    return database->db->Write(writeOptions, &batch->batch);
  }));

  return 0;
}

NAPI_METHOD(batch_write_sync) {
  NAPI_ARGV(3);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[1], batch));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, reference));

  bool sync = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "sync", sync));

  bool lowPriority = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "lowPriority", lowPriority));

  rocksdb::WriteOptions writeOptions;
  writeOptions.sync = sync;
  writeOptions.low_pri = lowPriority;
  std::lock_guard lock(batch->mutex);
  ROCKS_STATUS_THROWS_NAPI(database->db->Write(writeOptions, &batch->batch));

  return 0;
}

NAPI_METHOD(batch_count) {
  NAPI_ARGV(1);

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[0], batch));

  napi_value result;
  std::lock_guard lock(batch->mutex);
  NAPI_STATUS_THROWS(napi_create_int64(env, batch->batch.Count(), &result));

  return result;
}

NAPI_METHOD(batch_iterate) {
  NAPI_ARGV(3);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[1], batch));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, reference));

  const auto options = argv[2];

  bool keys = true;
  NAPI_STATUS_THROWS(GetProperty(env, options, "keys", keys));

  bool values = true;
  NAPI_STATUS_THROWS(GetProperty(env, options, "values", values));

  bool data = true;
  NAPI_STATUS_THROWS(GetProperty(env, options, "data", data));

  Encoding keyEncoding = Encoding::String;
  NAPI_STATUS_THROWS(GetProperty(env, options, "keyEncoding", keyEncoding));

  Encoding valueEncoding = Encoding::String;
  NAPI_STATUS_THROWS(GetProperty(env, options, "valueEncoding", valueEncoding));

  rocksdb::ColumnFamilyHandle* column = nullptr;
  NAPI_STATUS_THROWS(GetColumnProperty(env, options, database, column, false));

  BatchIterator iterator(keys, values, data, column, keyEncoding, valueEncoding);

  napi_value result;
  std::lock_guard lock(batch->mutex);
  NAPI_STATUS_THROWS(iterator.Iterate(env, batch->batch, &result));

  return result;
}

struct Updates : public BatchIterator, public Closable {
  Updates(Database* database,
          std::shared_ptr<DatabaseReference> reference,
          Reference databaseContext,
          const int64_t since,
          const bool keys,
          const bool values,
          const bool data,
          const rocksdb::ColumnFamilyHandle* column,
          const Encoding keyEncoding,
          const Encoding valueEncoding)
      : BatchIterator(keys, values, data, column, keyEncoding, valueEncoding),
        database_(database),
        reference_(std::move(reference)),
        databaseContext_(std::move(databaseContext)),
        start_(since) {
    const auto status = database_->Attach(reference_, this);
    if (!status.ok()) {
      throw std::runtime_error(status.ToString());
    }
  }

  virtual ~Updates() {
    if (!closed.load()) {
      database_->Close(reference_, this);
    }
  }

  rocksdb::Status Close() { return database_->Close(reference_, this); }

  rocksdb::Status CloseResources() override {
    std::lock_guard operationLock(operationMutex_);
    closed = true;
    iterator_.reset();
    return rocksdb::Status::OK();
  }

  rocksdb::Status Next(rocksdb::BatchResult& result) {
    std::lock_guard operationLock(operationMutex_);
    if (closed.load()) {
      return rocksdb::Status::InvalidArgument("Updates iterator is not open");
    }

    if (iterator_) {
      iterator_->Next();
      const auto status = iterator_->status();
      if (status.IsTryAgain()) {
        std::unique_ptr<rocksdb::TransactionLogIterator> replacement;
        rocksdb::TransactionLogIterator::ReadOptions options;
        ROCKS_STATUS_RETURN(database_->db->GetUpdatesSince(start_, &replacement, options));
        iterator_ = std::move(replacement);
      } else {
        ROCKS_STATUS_RETURN(status);
      }
    } else {
      rocksdb::TransactionLogIterator::ReadOptions options;
      ROCKS_STATUS_RETURN(database_->db->GetUpdatesSince(start_, &iterator_, options));
    }

    if (iterator_ && iterator_->Valid()) {
      result = iterator_->GetBatch();
      if (result.writeBatchPtr) {
        start_ = result.sequence + result.writeBatchPtr->Count();
      }
    }

    return rocksdb::Status::OK();
  }

  Database* database_;
  std::shared_ptr<DatabaseReference> reference_;
  Reference databaseContext_;
  int64_t start_;
  std::unique_ptr<rocksdb::TransactionLogIterator> iterator_;
  std::mutex operationMutex_;
};

NAPI_METHOD(updates_init) {
  NAPI_ARGV(2);

  try {
    Database* database;
    std::shared_ptr<DatabaseReference> reference;
    NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

    const auto options = argv[1];

    int64_t since = 0;
    NAPI_STATUS_THROWS(GetProperty(env, options, "since", since));

    bool keys = true;
    NAPI_STATUS_THROWS(GetProperty(env, options, "keys", keys));

    bool values = true;
    NAPI_STATUS_THROWS(GetProperty(env, options, "values", values));

    bool data = true;
    NAPI_STATUS_THROWS(GetProperty(env, options, "data", data));

    Encoding keyEncoding = Encoding::String;
    NAPI_STATUS_THROWS(GetProperty(env, options, "keyEncoding", keyEncoding));

    Encoding valueEncoding = Encoding::String;
    NAPI_STATUS_THROWS(GetProperty(env, options, "valueEncoding", valueEncoding));

    rocksdb::ColumnFamilyHandle* column = nullptr;
    NAPI_STATUS_THROWS(GetColumnProperty(env, options, database, column, false));
    Reference databaseContext;
    NAPI_STATUS_THROWS(Reference::Create(env, argv[0], databaseContext));

    napi_value result;
    auto updates = std::make_shared<Updates>(
        database, reference, std::move(databaseContext), since, keys, values, data, column, keyEncoding,
        valueEncoding);

    NAPI_STATUS_THROWS(CreateResourceExternal(env, updates, kUpdatesReferenceTag, result));

    return result;
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(updates_next) {
  NAPI_ARGV(2);

  std::shared_ptr<Updates> updates;
  NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kUpdatesReferenceTag, updates));

  auto callback = argv[1];

  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownUpdatesSince, resourceName));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(
      BeginDatabaseOperation(env, updates->database_, updates->reference_, databaseOperation));

  struct State {
    rocksdb::BatchResult batchResult;
  };

  NAPI_STATUS_THROWS(runAsync<State>(
      resourceName, env, callback,
      [updates, databaseOperation](auto& state) {
        const DatabaseOperationScope operationScope(databaseOperation);
        return updates->Next(state.batchResult);
      },
      [updates](auto& state, napi_env env, napi_value* result) {
        if (state.batchResult.writeBatchPtr != nullptr) {
          napi_value rows;
          napi_value sequence;

          NAPI_STATUS_RETURN(updates->Iterate(env, *state.batchResult.writeBatchPtr, &rows));
          NAPI_STATUS_RETURN(napi_create_int64(env, state.batchResult.sequence, &sequence));

          NAPI_STATUS_RETURN(napi_create_object(env, result));
          NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "rows", rows));
          NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "seq", sequence));
        }

        return napi_ok;
      }));

  return 0;
}

NAPI_METHOD(updates_close) {
  NAPI_ARGV(1);

  try {
    std::shared_ptr<Updates> updates;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kUpdatesReferenceTag, updates));

    ROCKS_STATUS_THROWS_NAPI(updates->Close());
    return 0;
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(db_compact_range_sync) {
  NAPI_ARGV(2);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  std::optional<std::string> start;
  std::optional<std::string> end;

  NAPI_STATUS_THROWS(GetProperty(env, argv[1], "start", start));
  NAPI_STATUS_THROWS(GetProperty(env, argv[1], "end", end));

  rocksdb::CompactRangeOptions options;

  auto begin = start ? std::make_unique<rocksdb::Slice>(*start) : nullptr;
  auto finish = end ? std::make_unique<rocksdb::Slice>(*end) : nullptr;

  ROCKS_STATUS_THROWS_NAPI(database->db->CompactRange(options, begin.get(), finish.get()));

  return 0;
}

NAPI_METHOD(db_compact_range) {
  NAPI_ARGV(3);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));

  std::optional<std::string> start;
  std::optional<std::string> end;

  NAPI_STATUS_THROWS(GetProperty(env, argv[1], "start", start));
  NAPI_STATUS_THROWS(GetProperty(env, argv[1], "end", end));

  auto callback = argv[2];

  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownCompactRange, resourceName));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  NAPI_STATUS_THROWS(runAsyncKeepAlive(resourceName, env, callback, argv[0], [=](auto& state) {
    const DatabaseOperationScope operationScope(databaseOperation);
    rocksdb::CompactRangeOptions options;

    auto begin = start ? std::make_unique<rocksdb::Slice>(*start) : nullptr;
    auto finish = end ? std::make_unique<rocksdb::Slice>(*end) : nullptr;

    return database->db->CompactRange(options, begin.get(), finish.get());
  }));

  return 0;
}

NAPI_METHOD(statistics_init) {
  NAPI_ARGV(1);

  bool enabled = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[0], "enabled", enabled));

  auto statistics = new std::shared_ptr<rocksdb::Statistics>(rocksdb::CreateDBStatistics());
  (*statistics)->set_stats_level(enabled ? rocksdb::StatsLevel::kExceptHistogramOrTimers
                                        : rocksdb::StatsLevel::kExceptTickers);

  napi_value result;
  NAPI_STATUS_THROWS(napi_create_external(
      env, statistics, Finalize<std::shared_ptr<rocksdb::Statistics>>, statistics, &result));
  NAPI_STATUS_THROWS(napi_type_tag_object(env, result, &kStatisticsTypeTag));

  return result;
}

NAPI_METHOD(statistics_set_stats_level) {
  NAPI_ARGV(2);

  bool isStatistics = false;
  NAPI_STATUS_THROWS(napi_check_object_type_tag(env, argv[0], &kStatisticsTypeTag, &isStatistics));
  if (!isStatistics) {
    napi_throw_type_error(env, nullptr, "invalid statistics resource");
    return NULL;
  }

  std::shared_ptr<rocksdb::Statistics>* statistics;
  NAPI_STATUS_THROWS(napi_get_value_external(env, argv[0], reinterpret_cast<void**>(&statistics)));
  if (!statistics || !*statistics) {
    napi_throw_type_error(env, nullptr, "invalid statistics resource");
    return NULL;
  }

  bool enabled = false;
  NAPI_STATUS_THROWS(napi_get_value_bool(env, argv[1], &enabled));
  (*statistics)->set_stats_level(enabled ? rocksdb::StatsLevel::kExceptHistogramOrTimers
                                        : rocksdb::StatsLevel::kExceptTickers);

  napi_value result;
  NAPI_STATUS_THROWS(napi_get_boolean(env, true, &result));
  return result;
}

NAPI_METHOD(statistics_get_statistics) {
  NAPI_ARGV(1);

  bool isStatistics = false;
  NAPI_STATUS_THROWS(napi_check_object_type_tag(env, argv[0], &kStatisticsTypeTag, &isStatistics));
  if (!isStatistics) {
    napi_throw_type_error(env, nullptr, "invalid statistics resource");
    return NULL;
  }

  std::shared_ptr<rocksdb::Statistics>* statistics;
  NAPI_STATUS_THROWS(napi_get_value_external(env, argv[0], reinterpret_cast<void**>(&statistics)));
  if (!statistics || !*statistics) {
    napi_throw_type_error(env, nullptr, "invalid statistics resource");
    return NULL;
  }

  napi_value result;
  NAPI_STATUS_THROWS(CreateStatisticsSnapshot(env, *statistics, &result));
  return result;
}

NAPI_METHOD(cache_init) {
  NAPI_ARGV(1);

  napi_valuetype type;
  NAPI_STATUS_THROWS(napi_typeof(env, argv[0], &type));

  std::shared_ptr<CacheResource> cache;
  if (type == napi_bigint) {
    if (LookupResourceHandle(env, argv[0], HandleRegistry<CacheResource>::Instance(), cache) != napi_ok) {
      napi_throw_error(env, nullptr, "Invalid or stale cache handle");
      return nullptr;
    }
  } else {
    size_t capacity = 32 * 1024 * 1024;  // 32 MiB
    NAPI_STATUS_THROWS(GetProperty(env, argv[0], "capacity", capacity));
    if (capacity == 0) {
      napi_throw_range_error(env, nullptr, "cache capacity must be greater than zero");
      return nullptr;
    }
    cache = RegisterCache(rocksdb::HyperClockCacheOptions(capacity, 0).MakeSharedCache());
  }

  napi_value result;
  NAPI_STATUS_THROWS(CreateResourceExternal(env, cache, kCacheReferenceTag, result));

  return result;
}

NAPI_METHOD(cache_get_handle) {
  NAPI_ARGV(1);

  std::shared_ptr<CacheResource> cache;
  NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kCacheReferenceTag, cache));

  napi_value result;
  NAPI_STATUS_THROWS(napi_create_bigint_uint64(env, cache->handle, &result));

  return result;
}

NAPI_METHOD(write_buffer_manager_init) {
  NAPI_ARGV(1);

  size_t bufferSize = 256 * 1024 * 1024;  // 256 MiB
  NAPI_STATUS_THROWS(GetProperty(env, argv[0], "bufferSize", bufferSize));
  if (bufferSize == 0) {
    napi_throw_range_error(env, nullptr, "write buffer size must be greater than zero");
    return nullptr;
  }

  bool allowStall = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[0], "allowStall", allowStall));

  std::shared_ptr<rocksdb::Cache> cache;
  {
    napi_value cacheValue;
    NAPI_STATUS_THROWS(napi_get_named_property(env, argv[0], "cache", &cacheValue));

    napi_valuetype cacheType;
    NAPI_STATUS_THROWS(napi_typeof(env, cacheValue, &cacheType));

    if (cacheType == napi_object || cacheType == napi_bigint) {
      std::shared_ptr<CacheResource> resource;
      if (LookupResourceHandle(env, cacheValue, HandleRegistry<CacheResource>::Instance(), resource) != napi_ok) {
        napi_throw_error(env, nullptr, "invalid cache handle");
        return NULL;
      }
      cache = resource->value;
    } else if (cacheType != napi_undefined && cacheType != napi_null) {
      napi_throw_error(env, nullptr, "invalid cache");
      return NULL;
    }
  }

  auto wbm = RegisterWriteBufferManager(
      std::make_shared<rocksdb::WriteBufferManager>(bufferSize, cache, allowStall));

  napi_value result;
  NAPI_STATUS_THROWS(CreateResourceExternal(env, wbm, kWriteBufferManagerReferenceTag, result));

  return result;
}

NAPI_METHOD(write_buffer_manager_get_handle) {
  NAPI_ARGV(1);

  std::shared_ptr<WriteBufferManagerResource> wbm;
  NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kWriteBufferManagerReferenceTag, wbm));

  napi_value result;
  NAPI_STATUS_THROWS(napi_create_bigint_uint64(env, wbm->handle, &result));

  return result;
}

NAPI_METHOD(write_buffer_manager_get_usage) {
  NAPI_ARGV(1);

  std::shared_ptr<WriteBufferManagerResource> wbm;
  NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kWriteBufferManagerReferenceTag, wbm));

  napi_value result;
  NAPI_STATUS_THROWS(napi_create_object(env, &result));

  napi_value memoryUsage;
  NAPI_STATUS_THROWS(napi_create_double(env, static_cast<double>(wbm->value->memory_usage()), &memoryUsage));
  NAPI_STATUS_THROWS(napi_set_named_property(env, result, "memoryUsage", memoryUsage));

  napi_value mutableMemoryUsage;
  NAPI_STATUS_THROWS(
      napi_create_double(env, static_cast<double>(wbm->value->mutable_memtable_memory_usage()), &mutableMemoryUsage));
  NAPI_STATUS_THROWS(napi_set_named_property(env, result, "mutableMemoryUsage", mutableMemoryUsage));

  napi_value bufferSize;
  NAPI_STATUS_THROWS(napi_create_double(env, static_cast<double>(wbm->value->buffer_size()), &bufferSize));
  NAPI_STATUS_THROWS(napi_set_named_property(env, result, "bufferSize", bufferSize));

  return result;
}

// Probes whether io_uring is actually usable in this process: RocksDB gates its
// async MultiGet / prefetch I/O on io_uring_setup succeeding at runtime and
// falls back to serial reads SILENTLY when the syscall is denied (seccomp — the
// default Docker/containerd profiles since late 2023 — or the
// kernel.io_uring_disabled sysctl) or missing (ENOSYS). io_uring_setup(0, NULL)
// never succeeds; a functional kernel rejects the arguments (EINVAL/EFAULT)
// while a blocked one fails with EPERM/EACCES/ENOSYS before looking at them.
NAPI_METHOD(io_uring_available) {
#if defined(__linux__) && defined(SYS_io_uring_setup)
  errno = 0;
  const long rc = syscall(SYS_io_uring_setup, 0, nullptr);
  const bool available = rc >= 0 || (errno != ENOSYS && errno != EPERM && errno != EACCES);
  if (rc >= 0) {
    close(static_cast<int>(rc));
  }

  napi_value result;
  NAPI_STATUS_THROWS(napi_get_boolean(env, available, &result));

  return result;
#elif defined(__linux__)
  // Built without any syscall number for io_uring_setup (pre-io_uring-era
  // headers): this binary cannot use io_uring regardless of the running
  // kernel, so report it unavailable — the Linux contract stays boolean.
  napi_value result;
  NAPI_STATUS_THROWS(napi_get_boolean(env, false, &result));

  return result;
#else
  // Not applicable on this platform.
  napi_value result;
  NAPI_STATUS_THROWS(napi_get_null(env, &result));

  return result;
#endif
}

NAPI_INIT() {
  NAPI_EXPORT_FUNCTION(db_init);
  NAPI_EXPORT_FUNCTION(db_open);
  NAPI_EXPORT_FUNCTION(db_get_identity);
  NAPI_EXPORT_FUNCTION(db_get_handle);
  NAPI_EXPORT_FUNCTION(db_get_location);
  NAPI_EXPORT_FUNCTION(db_close);
  NAPI_EXPORT_FUNCTION(db_dispose);
  NAPI_EXPORT_FUNCTION(db_get_many);
  NAPI_EXPORT_FUNCTION(db_get_many_sync);
  NAPI_EXPORT_FUNCTION(db_clear);
  NAPI_EXPORT_FUNCTION(db_get_property);
  NAPI_EXPORT_FUNCTION(db_set_stats_level);
  NAPI_EXPORT_FUNCTION(db_get_statistics);
  NAPI_EXPORT_FUNCTION(db_get_latest_sequence);
  NAPI_EXPORT_FUNCTION(db_query);
  NAPI_EXPORT_FUNCTION(db_query_sync);
  NAPI_EXPORT_FUNCTION(db_compact_range_sync);
  NAPI_EXPORT_FUNCTION(db_compact_range);
  NAPI_EXPORT_FUNCTION(db_flush_wal);

  NAPI_EXPORT_FUNCTION(statistics_init);
  NAPI_EXPORT_FUNCTION(statistics_set_stats_level);
  NAPI_EXPORT_FUNCTION(statistics_get_statistics);

  NAPI_EXPORT_FUNCTION(iterator_init_sync);
  NAPI_EXPORT_FUNCTION(iterator_refresh_sync);
  NAPI_EXPORT_FUNCTION(iterator_seek);
  NAPI_EXPORT_FUNCTION(iterator_seek_sync);
  NAPI_EXPORT_FUNCTION(iterator_close_sync);
  NAPI_EXPORT_FUNCTION(iterator_nextv);
  NAPI_EXPORT_FUNCTION(iterator_nextv_packed);
  NAPI_EXPORT_FUNCTION(iterator_nextv_sync);

  NAPI_EXPORT_FUNCTION(updates_init);
  NAPI_EXPORT_FUNCTION(updates_close);
  NAPI_EXPORT_FUNCTION(updates_next);

  NAPI_EXPORT_FUNCTION(batch_init);
  NAPI_EXPORT_FUNCTION(batch_put);
  NAPI_EXPORT_FUNCTION(batch_put_parts);
  NAPI_EXPORT_FUNCTION(batch_put_log_data);
  NAPI_EXPORT_FUNCTION(batch_del);
  NAPI_EXPORT_FUNCTION(batch_clear);
  NAPI_EXPORT_FUNCTION(batch_write);
  NAPI_EXPORT_FUNCTION(batch_write_sync);
  NAPI_EXPORT_FUNCTION(batch_merge);
  NAPI_EXPORT_FUNCTION(batch_merge_parts);
  NAPI_EXPORT_FUNCTION(batch_count);
  NAPI_EXPORT_FUNCTION(batch_iterate);

  NAPI_EXPORT_FUNCTION(cache_init);
  NAPI_EXPORT_FUNCTION(cache_get_handle);

  NAPI_EXPORT_FUNCTION(write_buffer_manager_init);
  NAPI_EXPORT_FUNCTION(write_buffer_manager_get_handle);
  NAPI_EXPORT_FUNCTION(write_buffer_manager_get_usage);

  NAPI_EXPORT_FUNCTION(io_uring_available);
}
