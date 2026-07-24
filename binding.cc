#define NAPI_VERSION 10

#include <assert.h>
#include <napi-macros.h>
#include <node_api.h>

#include <rocksdb/cache.h>
#include <rocksdb/comparator.h>
#include <rocksdb/convenience.h>
#include <rocksdb/db.h>
#include <rocksdb/env.h>
#include <rocksdb/file_system.h>
#include <rocksdb/filter_policy.h>
#include <rocksdb/merge_operator.h>
#include <rocksdb/options.h>
#include <rocksdb/perf_context.h>
#include <rocksdb/perf_level.h>
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
#include <exception>
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
#include <utility>
#include <vector>

#if defined(ROCKS_LEVEL_TEST_FAULTS)
#include <stdexcept>
#include <cstdlib>
#endif

#include "max_rev_operator.h"
#include "util.h"

static const napi_type_tag kStatisticsTypeTag = {0x0d186ac9202c4fe5, 0xa6c8045ce0bb653d};

// RocksDB recommends sizing its background pool to the number of CPU cores.
// 256 leaves ample room for large hosts while preventing one open call from
// attempting to create an effectively unbounded process-wide thread pool.
static constexpr int kMaxBackgroundParallelism = 256;

static constexpr int DefaultBackgroundParallelism(unsigned int hardwareConcurrency) {
  return static_cast<int>(
      std::clamp(hardwareConcurrency / 2, 1u, static_cast<unsigned int>(kMaxBackgroundParallelism)));
}

static_assert(DefaultBackgroundParallelism(0) == 1);
static_assert(DefaultBackgroundParallelism(8) == 4);
static_assert(DefaultBackgroundParallelism(1024) == kMaxBackgroundParallelism);

#if defined(ROCKS_LEVEL_TEST_FAULTS)
static int ExceptionCountdownForTest(const char* name) {
  const auto* const value = std::getenv(name);
  if (value == nullptr) return 0;

  char* end = nullptr;
  const auto parsed = std::strtol(value, &end, 10);
  if (end == value || *end != '\0' || parsed <= 0 || parsed > std::numeric_limits<int>::max()) {
    return 0;
  }
  return static_cast<int>(parsed);
}

// Initialize while the addon is loaded on the JS thread rather than calling
// getenv() for the first time from a close worker while process.env may change.
static const int initialUpdatesCloseExceptionCountdownForTest =
    ExceptionCountdownForTest("ROCKS_LEVEL_TEST_UPDATES_CLOSE_EXCEPTION_COUNTDOWN");
static std::atomic<int> updatesCloseExceptionCountdownForTest{
    initialUpdatesCloseExceptionCountdownForTest};
static std::atomic<int> databaseCloseAfterTransferExceptionCountdownForTest{
    ExceptionCountdownForTest("ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_AFTER_TRANSFER_COUNTDOWN")};
static std::atomic<int> databaseCloseBeforeTransferExceptionCountdownForTest{
    ExceptionCountdownForTest("ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_BEFORE_TRANSFER_COUNTDOWN")};
static std::atomic<int> databaseCloseBeforeTransferExceptionRemainingForTest{
    ExceptionCountdownForTest("ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_BEFORE_TRANSFER_REMAINING")};
static std::atomic<int> databaseCloseColumnExceptionCountdownForTest{
    ExceptionCountdownForTest("ROCKS_LEVEL_TEST_DB_CLOSE_EXCEPTION_COLUMN_COUNTDOWN")};
static std::atomic<int> databaseOpenAfterColumnExceptionCountdownForTest{
    ExceptionCountdownForTest("ROCKS_LEVEL_TEST_DB_OPEN_EXCEPTION_AFTER_COLUMN_COUNTDOWN")};
static std::atomic<int> databaseOpenCleanupExceptionCountdownForTest{
    ExceptionCountdownForTest("ROCKS_LEVEL_TEST_DB_OPEN_CLEANUP_EXCEPTION_COUNTDOWN")};

static bool InjectUpdatesCloseExceptionForTest() {
  auto current = updatesCloseExceptionCountdownForTest.load(std::memory_order_relaxed);
  while (current > 0) {
    if (updatesCloseExceptionCountdownForTest.compare_exchange_weak(
            current, current - 1, std::memory_order_relaxed, std::memory_order_relaxed)) {
      return current == 1;
    }
  }
  return false;
}

static bool InjectDatabaseCloseColumnExceptionForTest() {
  auto current = databaseCloseColumnExceptionCountdownForTest.load(std::memory_order_relaxed);
  while (current > 0) {
    if (databaseCloseColumnExceptionCountdownForTest.compare_exchange_weak(
            current, current - 1, std::memory_order_relaxed, std::memory_order_relaxed)) {
      return current == 1;
    }
  }
  return false;
}

static bool InjectDatabaseCloseAfterTransferExceptionForTest() {
  auto current = databaseCloseAfterTransferExceptionCountdownForTest.load(std::memory_order_relaxed);
  while (current > 0) {
    if (databaseCloseAfterTransferExceptionCountdownForTest.compare_exchange_weak(
            current, current - 1, std::memory_order_relaxed, std::memory_order_relaxed)) {
      return current == 1;
    }
  }
  return false;
}

static bool InjectDatabaseCloseBeforeTransferExceptionForTest() {
  auto remaining = databaseCloseBeforeTransferExceptionRemainingForTest.load(std::memory_order_relaxed);
  while (remaining > 0) {
    if (databaseCloseBeforeTransferExceptionRemainingForTest.compare_exchange_weak(
            remaining, remaining - 1, std::memory_order_relaxed, std::memory_order_relaxed)) {
      return true;
    }
  }

  auto current = databaseCloseBeforeTransferExceptionCountdownForTest.load(std::memory_order_relaxed);
  while (current > 0) {
    if (databaseCloseBeforeTransferExceptionCountdownForTest.compare_exchange_weak(
            current, current - 1, std::memory_order_relaxed, std::memory_order_relaxed)) {
      return current == 1;
    }
  }
  return false;
}

static bool InjectDatabaseOpenAfterColumnExceptionForTest() {
  auto current = databaseOpenAfterColumnExceptionCountdownForTest.load(std::memory_order_relaxed);
  while (current > 0) {
    if (databaseOpenAfterColumnExceptionCountdownForTest.compare_exchange_weak(
            current, current - 1, std::memory_order_relaxed, std::memory_order_relaxed)) {
      return current == 1;
    }
  }
  return false;
}

static bool InjectDatabaseOpenCleanupExceptionForTest() {
  auto current = databaseOpenCleanupExceptionCountdownForTest.load(std::memory_order_relaxed);
  while (current > 0) {
    if (databaseOpenCleanupExceptionCountdownForTest.compare_exchange_weak(
            current, current - 1, std::memory_order_relaxed, std::memory_order_relaxed)) {
      return current == 1;
    }
  }
  return false;
}
#else
static constexpr bool InjectUpdatesCloseExceptionForTest() { return false; }
static constexpr bool InjectDatabaseCloseColumnExceptionForTest() { return false; }
static constexpr bool InjectDatabaseCloseAfterTransferExceptionForTest() { return false; }
static constexpr bool InjectDatabaseCloseBeforeTransferExceptionForTest() { return false; }
static constexpr bool InjectDatabaseOpenAfterColumnExceptionForTest() { return false; }
static constexpr bool InjectDatabaseOpenCleanupExceptionForTest() { return false; }
#endif

static std::mutex& GetBackgroundParallelismMutex() {
  // The default RocksDB Env and its thread pools are process-wide, so pool
  // reconfiguration must also be serialized process-wide across JS workers.
  static std::mutex mutex;
  return mutex;
}

static bool ConfigureBackgroundParallelism(napi_env env,
                                           rocksdb::Options& options,
                                           int parallelism,
                                           int flushParallelism) {
  try {
    std::lock_guard lock(GetBackgroundParallelismMutex());
    auto* sharedEnv = options.env;
    const int previousParallelism = sharedEnv->GetBackgroundThreads(rocksdb::Env::LOW);
    const int previousFlushParallelism = sharedEnv->GetBackgroundThreads(rocksdb::Env::HIGH);

    try {
      // IncreaseParallelism() also immediately resizes LOW and forces HIGH to
      // one. Set its option field directly so both validated pool targets can
      // be applied in a controlled order behind the same exception barrier.
      options.max_background_jobs = parallelism;

      // Apply increases before reductions. If native thread creation fails,
      // restoring the previous sizes only has to shrink partially-grown pools
      // and therefore cannot require another thread allocation.
      if (parallelism > previousParallelism) {
        sharedEnv->SetBackgroundThreads(parallelism, rocksdb::Env::LOW);
      }
      if (flushParallelism > previousFlushParallelism) {
        sharedEnv->SetBackgroundThreads(flushParallelism, rocksdb::Env::HIGH);
      }
      if (parallelism < previousParallelism) {
        sharedEnv->SetBackgroundThreads(parallelism, rocksdb::Env::LOW);
      }
      if (flushParallelism < previousFlushParallelism) {
        sharedEnv->SetBackgroundThreads(flushParallelism, rocksdb::Env::HIGH);
      }
    } catch (...) {
      // SetBackgroundThreads() starts std::threads synchronously and can leave
      // a pool partially enlarged when construction throws. Restore both
      // process-wide limits before surfacing the original error to JavaScript.
      try {
        sharedEnv->SetBackgroundThreads(previousParallelism, rocksdb::Env::LOW);
      } catch (...) {
      }
      try {
        sharedEnv->SetBackgroundThreads(previousFlushParallelism, rocksdb::Env::HIGH);
      } catch (...) {
      }
      throw;
    }
  } catch (const std::exception& error) {
    napi_throw_error(env, "LEVEL_RESOURCE_LIMIT", error.what());
    return false;
  } catch (...) {
    napi_throw_error(env, "LEVEL_RESOURCE_LIMIT", "Failed to configure RocksDB background threads");
    return false;
  }

  return true;
}

enum ResourceName {
  ResourceIteratorNextv = 0,
  ResourceLeveldownOpen,
  ResourceLeveldownClose,
  ResourceLeveldownGetMany,
  ResourceLeveldownFlushWal,
  ResourceLeveldownFlush,
  ResourceLeveldownIteratorInit,
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
  virtual ~Closable() noexcept = default;
  // Called with the owning reference's resources mutex held. Implementations must only
  // release their RocksDB resources and must not call back into Database.
  virtual rocksdb::Status CloseResources() = 0;
  // Destruction cannot retain this raw pointer for a later retry. Implementations
  // perform their strongest no-throw fallback after CloseResources() throws.
  virtual void AbandonResources() noexcept = 0;
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
  void CloseForCleanup(const std::shared_ptr<DatabaseReference>& reference) noexcept;
  rocksdb::Status Attach(const std::shared_ptr<DatabaseReference>& reference, Closable* closable);
  rocksdb::Status Close(const std::shared_ptr<DatabaseReference>& reference, Closable* closable);
  void AbandonReferenceResourcesForCleanup(
      const std::shared_ptr<DatabaseReference>& reference) noexcept;
  void DetachOnDestroy(const std::shared_ptr<DatabaseReference>& reference, Closable* closable) noexcept;
  std::shared_ptr<DatabaseOperation> BeginOperation(const std::shared_ptr<DatabaseReference>& reference);
  void EndOperation(const std::shared_ptr<DatabaseReference>& reference);
  bool IsOpen(const std::shared_ptr<DatabaseReference>& reference) const;
  bool IsClosed(const std::shared_ptr<DatabaseReference>& reference) const;

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
  rocksdb::Status Close(const std::shared_ptr<DatabaseReference>& reference,
                        bool injectTestFaults);

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
  const auto cleanupOpened = [&]() noexcept {
    if (!openedDb) {
      handles.clear();
      return;
    }

    // Consume each raw handle before attempting destruction. If RocksDB or a
    // test fault throws, a second cleanup pass must never destroy it twice.
    while (!handles.empty()) {
      auto* const handle = handles.back();
      handles.pop_back();
      try {
        openedDb->DestroyColumnFamilyHandle(handle).PermitUncheckedError();
        if (InjectDatabaseOpenCleanupExceptionForTest()) {
          throw std::runtime_error("Injected database open cleanup exception");
        }
      } catch (...) {
      }
    }

    try {
      openedDb->Close().PermitUncheckedError();
    } catch (...) {
    }
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
        if (InjectDatabaseOpenAfterColumnExceptionForTest()) {
          throw std::runtime_error("Injected database open exception after column setup");
        }
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
  return Close(reference, true);
}

void Database::CloseForCleanup(
    const std::shared_ptr<DatabaseReference>& reference) noexcept {
  // Finalizers and failed-open cleanup have no later public close that can
  // retry. Defensively abandon attached resources, then run the state-machine
  // close without test fault injection. Unlike the bounded graceful attempts,
  // this is the terminal owner: it must either detach this shared lease or tear
  // down the final lease.
  AbandonReferenceResourcesForCleanup(reference);
  try {
    Close(reference, false).PermitUncheckedError();
  } catch (...) {
    // The N-API wrapper verifies the native phase and reports the invariant if
    // a platform synchronization primitive itself failed unexpectedly.
  }
}

rocksdb::Status Database::Close(const std::shared_ptr<DatabaseReference>& reference,
                                bool injectTestFaults) {
  std::unique_lock lock(stateMutex_);
  stateChanged_.wait(lock, [&] { return state_ != State::Opening && state_ != State::Closing; });
  if (reference->phase == DatabaseReference::Phase::Inactive) {
    return rocksdb::Status::OK();
  }
  if (reference->phase == DatabaseReference::Phase::Closing) {
    stateChanged_.wait(lock, [&] { return reference->phase != DatabaseReference::Phase::Closing; });
    if (reference->phase == DatabaseReference::Phase::Inactive) {
      return rocksdb::Status::OK();
    }
  }

  std::unique_ptr<rocksdb::DB> closingDb;
  std::map<int32_t, ColumnFamily> closingColumns;
  const auto finishTerminalCleanup = [&]() noexcept {
    if (!closingDb) return;

    // A failure immediately after ownership transfer skips the normal flush
    // below. Preserve the WAL before destroying handles and closing the DB;
    // cleanup cannot report a second failure while unwinding the original one.
    try {
      closingDb->FlushWAL(true).PermitUncheckedError();
    } catch (...) {
    }

    while (!closingColumns.empty()) {
      const auto column = closingColumns.begin();
      try {
        closingDb->DestroyColumnFamilyHandle(column->second.handle).PermitUncheckedError();
      } catch (...) {
      }
      closingColumns.erase(column);
    }

    try {
      closingDb->Close().PermitUncheckedError();
    } catch (...) {
    }
  };

  const auto priorPhase = reference->phase;
  reference->phase = DatabaseReference::Phase::Closing;
  try {
    lock.unlock();
    {
      std::unique_lock operationsLock(reference->operationsMutex);
      reference->operationsChanged.wait(operationsLock, [&] { return reference->activeOperations == 0; });
    }
    lock.lock();

    if (injectTestFaults && InjectDatabaseCloseBeforeTransferExceptionForTest()) {
      throw std::runtime_error("Injected database close exception before ownership transfer");
    }

    rocksdb::Status status = rocksdb::Status::OK();
    {
      std::lock_guard resourcesLock(reference->resourcesMutex);
      while (!reference->resources.empty()) {
        const auto resource = reference->resources.begin();
        auto* const closable = *resource;
        rocksdb::Status closeStatus;
        try {
          closeStatus = closable->CloseResources();
        } catch (...) {
          // The resource remains attached so a later database close or its
          // destructor can retry cleanup. CloseResources implementations are
          // idempotent; reset the flag in case the failed call set it before
          // throwing, otherwise destruction could leave a dangling raw entry.
          closable->closed = false;
          throw;
        }
        if (status.ok() && !closeStatus.ok()) {
          status = closeStatus;
        }
        closable->closed = true;
        // Erase each settled resource immediately. If a later resource throws,
        // already-closed objects can then be finalized without leaving stale
        // pointers in this reference's resource set.
        reference->resources.erase(resource);
      }
    }

    assert(openReferences_ > 0);
    if (--openReferences_ > 0) {
      reference->phase = DatabaseReference::Phase::Inactive;
      reference->generation = 0;
      stateChanged_.notify_all();
      return status;
    }

    state_ = State::Closing;
    closingDb.swap(db);
    closingColumns.swap(columns);
    statistics.reset();
    reference->phase = DatabaseReference::Phase::Inactive;
    reference->generation = 0;
    lock.unlock();

    if (injectTestFaults && InjectDatabaseCloseAfterTransferExceptionForTest()) {
      throw std::runtime_error("Injected database close exception after ownership transfer");
    }

    if (closingDb) {
      const auto flushStatus = closingDb->FlushWAL(true);
      if (status.ok() && !flushStatus.ok()) {
        status = flushStatus;
      }
      while (!closingColumns.empty()) {
        const auto column = closingColumns.begin();
        if (injectTestFaults && InjectDatabaseCloseColumnExceptionForTest()) {
          throw std::runtime_error("Injected database column destruction exception");
        }
        const auto destroyStatus = closingDb->DestroyColumnFamilyHandle(column->second.handle);
        if (status.ok() && !destroyStatus.ok()) {
          status = destroyStatus;
        }
        closingColumns.erase(column);
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
  } catch (const std::exception& error) {
    if (!lock.owns_lock()) lock.lock();
    if (reference->phase == DatabaseReference::Phase::Closing) {
      // No ownership was transferred yet, so the reference remains usable and
      // AbstractLevel may correctly return to its open state.
      reference->phase = priorPhase;
    } else if (state_ == State::Closing) {
      // Ownership has already moved into local RAII values. Their unwinding
      // completes teardown, so publish the terminal state before reporting the
      // exception to JavaScript.
      lock.unlock();
      finishTerminalCleanup();
      lock.lock();
      state_ = State::Closed;
    }
    stateChanged_.notify_all();
    return rocksdb::Status::Aborted(error.what());
  } catch (...) {
    if (!lock.owns_lock()) lock.lock();
    if (reference->phase == DatabaseReference::Phase::Closing) {
      reference->phase = priorPhase;
    } else if (state_ == State::Closing) {
      lock.unlock();
      finishTerminalCleanup();
      lock.lock();
      state_ = State::Closed;
    }
    stateChanged_.notify_all();
    return rocksdb::Status::Aborted("Unknown exception while closing database");
  }
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
  const auto resource = reference->resources.find(closable);
  if (resource == reference->resources.end()) {
    return rocksdb::Status::OK();
  }

  rocksdb::Status status;
  try {
    status = closable->CloseResources();
  } catch (...) {
    // Keep the raw pointer registered and make destruction retry cleanup. A
    // resource that set its flag before throwing must not silently detach from
    // the database while still holding RocksDB-owned state.
    closable->closed = false;
    throw;
  }
  closable->closed = true;
  reference->resources.erase(resource);
  return status;
}

void Database::AbandonReferenceResourcesForCleanup(
    const std::shared_ptr<DatabaseReference>& reference) noexcept {
  try {
    std::lock_guard lock(reference->resourcesMutex);
    while (!reference->resources.empty()) {
      const auto resource = reference->resources.begin();
      auto* const closable = *resource;

      // Cleanup hooks cannot retain a raw pointer for a public retry. Erase it
      // before running the no-throw fallback so later finalization is a no-op.
      reference->resources.erase(resource);
      closable->AbandonResources();
      closable->closed = true;
    }
  } catch (...) {
    // Environment teardown and N-API finalizers cannot propagate exceptions.
  }
}

void Database::DetachOnDestroy(const std::shared_ptr<DatabaseReference>& reference,
                               Closable* closable) noexcept {
  try {
    std::lock_guard lock(reference->resourcesMutex);
    const auto resource = reference->resources.find(closable);
    if (resource == reference->resources.end()) return;

    // Erase first: once the most-derived destructor returns this raw pointer
    // can never be retried safely, even if native cleanup throws again.
    reference->resources.erase(resource);

    try {
      const auto status = closable->CloseResources();
      if (!status.ok()) {
        closable->AbandonResources();
      }
    } catch (...) {
      closable->AbandonResources();
    }
    closable->closed = true;
  } catch (...) {
    // Destructors and N-API finalizers must never allow C++ exceptions to cross
    // their noexcept / C ABI boundary. A mutex failure is not recoverable here.
  }
}

bool Database::IsOpen(const std::shared_ptr<DatabaseReference>& reference) const {
  std::lock_guard lock(stateMutex_);
  return state_ == State::Open && reference->phase == DatabaseReference::Phase::Open &&
         reference->generation == generation_;
}

bool Database::IsClosed(const std::shared_ptr<DatabaseReference>& reference) const {
  std::lock_guard lock(stateMutex_);
  return reference->phase == DatabaseReference::Phase::Inactive;
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
      "iterator.nextv",          "leveldown.open",         "leveldown.close",
      "leveldown.get_many",      "leveldown.flush_wal",    "leveldown.flush",
      "leveldown.iterator_init", "leveldown.iterator_seek", "leveldown.batch_write",
      "leveldown.updates_since", "leveldown.compact_range", "leveldown.clear"};
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

enum class BatchAppendInputType : uint8_t {
  Any,
  Buffer,
  String,
};

static napi_status GetOwnedBatchAppendBuffer(napi_env env, napi_value from, std::string& to) {
  char* data = nullptr;
  size_t length = 0;
  NAPI_STATUS_RETURN(napi_get_buffer_info(env, from, reinterpret_cast<void**>(&data), &length));
  if (length == 0) {
    to.clear();
  } else {
    to.assign(data, length);
  }
  return napi_ok;
}

static napi_status GetOwnedBatchAppendUtf8(napi_env env, napi_value from, std::string& to) {
  size_t length = 0;
  NAPI_STATUS_RETURN(napi_get_value_string_utf8(env, from, nullptr, 0, &length));
  to.resize(length + 1);
  size_t written = 0;
  NAPI_STATUS_RETURN(napi_get_value_string_utf8(env, from, to.data(), to.size(), &written));
  to.resize(written);
  return napi_ok;
}

static napi_status GetOwnedBatchAppendSlice(napi_env env, napi_value from, std::string& to) {

  int64_t offset = 0;
  {
    napi_value property;
    NAPI_STATUS_RETURN(napi_get_named_property(env, from, "byteOffset", &property));
    NAPI_STATUS_RETURN(GetIntegerValue(env, property, offset));
  }

  int64_t length = 0;
  {
    napi_value property;
    NAPI_STATUS_RETURN(napi_get_named_property(env, from, "byteLength", &property));
    NAPI_STATUS_RETURN(GetIntegerValue(env, property, length));
  }

  napi_value backing;
  NAPI_STATUS_RETURN(napi_get_named_property(env, from, "buffer", &backing));
  char* data = nullptr;
  size_t backingLength = 0;
  NAPI_STATUS_RETURN(
      napi_get_buffer_info(env, backing, reinterpret_cast<void**>(&data), &backingLength));

  if (offset < 0 || length < 0 || static_cast<uint64_t>(offset) > backingLength ||
      static_cast<uint64_t>(length) > backingLength - static_cast<uint64_t>(offset)) {
    return napi_invalid_arg;
  }

  if (length == 0) {
    to.clear();
  } else {
    to.assign(data + offset, static_cast<size_t>(length));
  }
  return napi_ok;
}

template <BatchAppendInputType InputType>
static napi_status GetOwnedBatchAppendValue(napi_env env, napi_value from, std::string& to) {
  if constexpr (InputType == BatchAppendInputType::Buffer) {
    return GetOwnedBatchAppendBuffer(env, from, to);
  }
  if constexpr (InputType == BatchAppendInputType::String) {
    return GetOwnedBatchAppendUtf8(env, from, to);
  }

  bool isBuffer = false;
  NAPI_STATUS_RETURN(napi_is_buffer(env, from, &isBuffer));
  if (isBuffer) return GetOwnedBatchAppendBuffer(env, from, to);

  const auto stringStatus = GetOwnedBatchAppendUtf8(env, from, to);
  if (stringStatus == napi_ok) return napi_ok;
  if (stringStatus != napi_string_expected) return stringStatus;

  napi_valuetype type;
  NAPI_STATUS_RETURN(napi_typeof(env, from, &type));
  if (type != napi_object) return napi_invalid_arg;
  return GetOwnedBatchAppendSlice(env, from, to);
}

struct BatchAppendEntry {
  std::string key;
  std::optional<std::string> value;
};

class BatchSavePoint final {
 public:
  explicit BatchSavePoint(rocksdb::WriteBatch& batch) : batch_(batch), count_(batch.Count()) {
    batch_.SetSavePoint();
  }

  BatchSavePoint(const BatchSavePoint&) = delete;
  BatchSavePoint& operator=(const BatchSavePoint&) = delete;

  ~BatchSavePoint() noexcept {
    if (!active_) return;

    const auto status = batch_.RollbackToSavePoint();
    assert(status.ok());
    assert(batch_.Count() == count_);
  }

  rocksdb::Status Rollback() {
    const auto status = batch_.RollbackToSavePoint();
    if (status.ok()) {
      active_ = false;
      assert(batch_.Count() == count_);
    }
    return status;
  }

  rocksdb::Status Commit() {
    const auto status = batch_.PopSavePoint();
    if (status.ok()) active_ = false;
    return status;
  }

 private:
  rocksdb::WriteBatch& batch_;
  const uint32_t count_;
  bool active_ = true;
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
  std::optional<uint32_t> column = std::nullopt;
};

#if defined(ROCKS_LEVEL_TEST_FAULTS)
static std::atomic<bool> gFailBatchIteratorAfterFirstRow{false};
static std::atomic<bool> gFailBatchAppendManyAfterFirstOperation{false};
#endif

struct BatchIterator : public rocksdb::WriteBatch::Handler {
  BatchIterator(const Database* database,
                const bool keys,
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
        valueEncoding_(valueEncoding) {
    // A database can be imported by wrappers in different N-API environments.
    // Snapshot plain names while this wrapper owns an open operation, then let
    // JavaScript resolve each name through its own db.columns object.
    for (const auto& [id, column] : database->columns) {
      columnNames_.emplace(static_cast<uint32_t>(id), column.descriptor.name);
    }
  }

  napi_status Iterate(napi_env env, const rocksdb::WriteBatch& batch, napi_value* result) {
    // Updates reuses one BatchIterator across WAL batches. Never let a failed
    // RocksDB iteration or N-API conversion retain rows for the next call.
    cache_.clear();
    struct CacheClearGuard final {
      std::vector<BatchEntry>& cache;
      ~CacheClearGuard() noexcept { cache.clear(); }
    } cacheClear{cache_};

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

      napi_value column = nullVal;
      if (cache_[n].column) {
        const auto found = columnNames_.find(*cache_[n].column);
        if (found != columnNames_.end()) {
          NAPI_STATUS_RETURN(
              napi_create_string_utf8(env, found->second.data(), found->second.size(), &column));
        }
      }
      NAPI_STATUS_RETURN(napi_set_element(env, *result, n * 4 + 3, column));

#if defined(ROCKS_LEVEL_TEST_FAULTS)
      if (n == 0 && gFailBatchIteratorAfterFirstRow.exchange(false, std::memory_order_relaxed)) {
        napi_throw_error(env, "LEVEL_TEST_FAULT", "Injected batch iteration conversion failure");
        return napi_pending_exception;
      }
#endif
    }

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

    entry.column = column_family_id;

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

    entry.column = column_family_id;

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

    entry.column = column_family_id;

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
    entry.column = column_family_id;
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
  std::map<uint32_t, std::string> columnNames_;
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
      : database_(database),
        reference_(std::move(reference)),
        column_(column),
        readOptions_(std::move(readOptions)),
        reverse_(reverse),
        limit_(limit) {
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
      readOptions_.iterate_upper_bound = &*upper_bound_;
    }

    if (lower_bound_) {
      readOptions_.iterate_lower_bound = &*lower_bound_;
    }

    if (!readOptions_.tailing) {
      snapshot_ = database_->db->GetSnapshot();
      readOptions_.snapshot = snapshot_;
    }

    try {
      const auto status = database_->Attach(reference_, this);
      if (!status.ok()) {
        throw std::runtime_error(status.ToString());
      }
    } catch (...) {
      ReleaseSnapshot();
      throw;
    }
  }

  ~BaseIterator() noexcept override {
    if (!closed.load()) {
      database_->DetachOnDestroy(reference_, this);
    }
  }

  virtual void Seek(const rocksdb::Slice& target) {
    assert(iterator_);
    // Positioning is the supported recovery path after a terminal iterator
    // error. Record any new error below when the caller checks Status().
    terminalStatus_ = rocksdb::Status::OK();

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
    readOptions_.iterate_lower_bound = nullptr;
    readOptions_.iterate_upper_bound = nullptr;
    lower_bound_.reset();
    upper_bound_.reset();
    ReleaseSnapshot();
    return rocksdb::Status::OK();
  }

  void AbandonResources() noexcept override {
    closed = true;
    // No operation can retain a shared_ptr once this destructor starts. Clear
    // every RocksDB-owned pointer independently so one failed cleanup step does
    // not prevent the remaining best-effort releases.
    try {
      iterator_.reset();
    } catch (...) {
    }
    readOptions_.iterate_lower_bound = nullptr;
    readOptions_.iterate_upper_bound = nullptr;
    try {
      lower_bound_.reset();
    } catch (...) {
    }
    try {
      upper_bound_.reset();
    } catch (...) {
    }
    try {
      ReleaseSnapshot();
    } catch (...) {
    }
  }

  virtual rocksdb::Status Initialize(const std::optional<std::string>& initialTarget = std::nullopt) {
    if (closed.load()) {
      return rocksdb::Status::InvalidArgument("Iterator is not open");
    }
    if (iterator_) return PreflightStatus();

    try {
      iterator_.reset(database_->db->NewIterator(readOptions_, column_));
    } catch (...) {
      ReleaseSnapshot();
      throw;
    }
    // RocksDB copies ReadOptions into the iterator and retains its snapshot
    // pointer for optional auto-refresh. Keep the snapshot alive until the
    // iterator is destroyed or Refresh(nullptr) clears that internal pointer.
    terminalStatus_ = rocksdb::Status::OK();
    if (initialTarget) {
      Seek(*initialTarget);
    } else {
      ResetPosition();
    }
    return Status();
  }

  rocksdb::Status InitializeSafe(const std::optional<std::string>& initialTarget = std::nullopt) {
    std::lock_guard operationLock(operationMutex_);
    if (closed.load()) {
      return rocksdb::Status::InvalidArgument("Iterator is not open");
    }
    return Initialize(initialTarget);
  }

  rocksdb::Status InitializeAndCloseOnErrorSafe(
      const std::optional<std::string>& initialTarget = std::nullopt) {
    rocksdb::Status status;
    try {
      status = InitializeSafe(initialTarget);
    } catch (...) {
      const auto cleanupStatus = Close();
      if (!cleanupStatus.ok()) {
        throw std::runtime_error("Iterator initialization threw and cleanup failed: " +
                                 cleanupStatus.ToString());
      }
      throw;
    }

    if (status.ok()) return status;

    // Initialization runs on a worker thread, so destroy and detach failed
    // native state here as well. In particular, releasing a snapshot or a
    // partially-created RocksDB iterator must not fall back to the JS thread.
    const auto cleanupStatus = Close();
    if (!cleanupStatus.ok()) {
      return rocksdb::Status::CopyAppendMessage(
          status, "; iterator cleanup failed: ", cleanupStatus.ToString());
    }
    return status;
  }

  rocksdb::Status RefreshSafe() {
    std::lock_guard operationLock(operationMutex_);
    // Refresh is a recovery operation: an existing iterator must be allowed
    // to clear a cached terminal status rather than replaying it here.
    if (!iterator_) ROCKS_STATUS_RETURN(Initialize());
    return Refresh();
  }

  rocksdb::Status SeekSafe(const rocksdb::Slice& target, const uint32_t discardedCount) {
    std::lock_guard operationLock(operationMutex_);
    if (!iterator_) return Initialize(target.ToString());
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
    if (!iterator_->Valid()) return false;

    // RocksDB enforces an inclusive lower bound and exclusive upper bound.
    // Only the opposite inclusivity at the terminal edge needs a manual check.
    if (reverse_) {
      if (!lower_bound_ || lower_inclusive_) return true;
      const auto key = iterator_->key();
      const auto* comparator = column_->GetComparator();
      const auto compared = comparator->Compare(key, *lower_bound_);
      return compared > 0;
    }

    if (!upper_bound_ || !upper_inclusive_) return true;
    const auto key = iterator_->key();
    const auto* comparator = column_->GetComparator();
    const auto compared = comparator->Compare(key, *upper_bound_);
    return compared <= 0;
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

  rocksdb::Status Status() {
    assert(iterator_);
    const auto status = iterator_->status();
    if (!status.ok()) terminalStatus_ = status;
    return status;
  }

  bool IsInitialized() const { return iterator_ != nullptr; }

  bool IsInitializedSafe() {
    // This probe is used only after an async worker has completed, to
    // distinguish a failed initializer (which closes native state) from a
    // later read/conversion failure (which remains recoverable by seek). It
    // takes no RocksDB action and cannot perform I/O.
    std::lock_guard operationLock(operationMutex_);
    return IsInitialized();
  }

  rocksdb::Status PreflightStatus() const {
    // A failed movement makes Valid() false and is checked through Status().
    // Replay that terminal failure before a retry can call Next()/Prev() on
    // RocksDB's invalid iterator. Keeping the status locally avoids a virtual
    // RocksDB call on every healthy batch.
    return terminalStatus_;
  }

  virtual rocksdb::Status Refresh() {
    assert(iterator_);
    // Refresh restarts iteration, so the user `limit` budget must restart too;
    // otherwise an iterator that already yielded `limit` rows returns nothing
    // after a refresh even though every other piece of state was reset.
    count_ = 0;
    // Passing nullptr explicitly retargets the live iterator to the latest DB
    // state and clears its internal snapshot.
    terminalStatus_ = iterator_->Refresh(nullptr);
    ROCKS_STATUS_RETURN(terminalStatus_);
    ReleaseSnapshot();
    // Refresh invalidates the iterator, so restore its comparator-aware start.
    ResetPosition();
    return Status();
  }

  Database* database_;
  std::shared_ptr<DatabaseReference> reference_;
  rocksdb::ColumnFamilyHandle* column_;
  rocksdb::ReadOptions readOptions_;
  std::mutex operationMutex_;

 private:
  void ReleaseSnapshot() {
    const auto* snapshot = std::exchange(snapshot_, nullptr);
    readOptions_.snapshot = nullptr;
    if (snapshot) {
      database_->db->ReleaseSnapshot(snapshot);
    }
  }

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
    terminalStatus_ = rocksdb::Status::OK();
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
  const rocksdb::Snapshot* snapshot_ = nullptr;
  rocksdb::Status terminalStatus_;
  bool lower_inclusive_ = true;
  bool upper_inclusive_ = false;
  std::unique_ptr<rocksdb::Iterator> iterator_;
  const bool reverse_;
  const int limit_;
};

enum class PackedMode {
  Unpacked,
  Packed,
  Auto,
};

enum class IteratorStopReason {
  None,
  Count,
  Bytes,
  Eof,
  Timeout,
};

static napi_status SetIteratorStopReason(napi_env env,
                                         napi_value result,
                                         const IteratorStopReason reason) {
  if (reason == IteratorStopReason::None) return napi_ok;

  napi_value value;
  NAPI_STATUS_RETURN(napi_create_uint32(env, static_cast<uint32_t>(reason), &value));
  return napi_set_named_property(env, result, "reason", value);
}

static bool SupportsPackedReads(const Encoding encoding) {
  return encoding == Encoding::Buffer || encoding == Encoding::String;
}

static constexpr size_t kAutoPackedValueBytes = 8 * 1024;
// Iterator timeouts are best effort. Sampling avoids a clock read for every
// rejected candidate during heavily filtered scans.
static constexpr size_t kDeadlineCheckInterval = 64;

struct IteratorOptions {
  bool unsafe = false;
  bool reverse = false;
  bool keys = true;
  bool values = true;
  int32_t limit = -1;
  int64_t highWaterMarkBytes = std::numeric_limits<int32_t>::max();
  std::optional<std::string> lt;
  std::optional<std::string> lte;
  std::optional<std::string> gt;
  std::optional<std::string> gte;
  std::optional<std::string> keyFilter;
  std::optional<std::string> valueFilter;
  rocksdb::ColumnFamilyHandle* column = nullptr;
  Encoding keyEncoding = Encoding::Buffer;
  Encoding valueEncoding = Encoding::Buffer;
  rocksdb::ReadOptions readOptions;
};

struct IteratorNextvOptions {
  uint32_t timeout = 0;
  size_t highWaterMarkBytes = std::numeric_limits<int32_t>::max();
  size_t highWaterMarkCount = std::numeric_limits<int64_t>::max();
};

static napi_status GetIteratorNextvOptions(napi_env env,
                                           napi_value options,
                                           IteratorNextvOptions& result) {
  NAPI_STATUS_RETURN(GetProperty(env, options, "timeout", result.timeout));

  int64_t highWaterMarkBytes = static_cast<int64_t>(result.highWaterMarkBytes);
  NAPI_STATUS_RETURN(GetProperty(env, options, "highWaterMarkBytes", highWaterMarkBytes));
  if (highWaterMarkBytes < 0) {
    NAPI_STATUS_RETURN(
        napi_throw_range_error(env, nullptr, "highWaterMarkBytes must be non-negative"));
    return napi_pending_exception;
  }
  result.highWaterMarkBytes = static_cast<size_t>(highWaterMarkBytes);

  int64_t highWaterMarkCount = static_cast<int64_t>(result.highWaterMarkCount);
  NAPI_STATUS_RETURN(GetProperty(env, options, "highWaterMarkCount", highWaterMarkCount));
  if (highWaterMarkCount < 0) {
    NAPI_STATUS_RETURN(
        napi_throw_range_error(env, nullptr, "highWaterMarkCount must be non-negative"));
    return napi_pending_exception;
  }
  result.highWaterMarkCount = static_cast<size_t>(highWaterMarkCount);

  return napi_ok;
}

static napi_status GetIteratorOptions(napi_env env,
                                      napi_value options,
                                      Database* database,
                                      IteratorOptions& result) {
  NAPI_STATUS_RETURN(GetProperty(env, options, "unsafe", result.unsafe));
  NAPI_STATUS_RETURN(GetProperty(env, options, "reverse", result.reverse));
  NAPI_STATUS_RETURN(GetProperty(env, options, "keys", result.keys));
  NAPI_STATUS_RETURN(GetProperty(env, options, "values", result.values));
  NAPI_STATUS_RETURN(GetProperty(env, options, "limit", result.limit));
  NAPI_STATUS_RETURN(GetProperty(env, options, "highWaterMarkBytes", result.highWaterMarkBytes));
  if (result.highWaterMarkBytes < 0) {
    NAPI_STATUS_RETURN(napi_throw_range_error(env, nullptr, "highWaterMarkBytes must be non-negative"));
    return napi_pending_exception;
  }

  NAPI_STATUS_RETURN(GetProperty(env, options, "lt", result.lt));
  NAPI_STATUS_RETURN(GetProperty(env, options, "lte", result.lte));
  NAPI_STATUS_RETURN(GetProperty(env, options, "gt", result.gt));
  NAPI_STATUS_RETURN(GetProperty(env, options, "gte", result.gte));
  NAPI_STATUS_RETURN(GetProperty(env, options, "keyFilter", result.keyFilter));
  NAPI_STATUS_RETURN(GetProperty(env, options, "valueFilter", result.valueFilter));

  result.column = database->db->DefaultColumnFamily();
  NAPI_STATUS_RETURN(GetColumnProperty(env, options, database, result.column));
  NAPI_STATUS_RETURN(GetProperty(env, options, "keyEncoding", result.keyEncoding));
  NAPI_STATUS_RETURN(GetProperty(env, options, "valueEncoding", result.valueEncoding));

  result.readOptions.background_purge_on_iterator_cleanup = true;
  NAPI_STATUS_RETURN(GetProperty(env, options, "backgroundPurgeOnIteratorCleanup",
                                 result.readOptions.background_purge_on_iterator_cleanup));
  result.readOptions.tailing = false;
  NAPI_STATUS_RETURN(GetProperty(env, options, "tailing", result.readOptions.tailing));
  result.readOptions.fill_cache = false;
  NAPI_STATUS_RETURN(GetProperty(env, options, "fillCache", result.readOptions.fill_cache));

  // Local NVMe/SSD gains nothing from RocksDB async I/O (io_uring): it only adds
  // CPU + ring overhead (async-io wins need high-latency/remote storage). Default
  // OFF; callers opt in per-request via `asyncIO`.
  result.readOptions.async_io = false;
  NAPI_STATUS_RETURN(GetProperty(env, options, "asyncIO", result.readOptions.async_io));
  result.readOptions.adaptive_readahead = true;
  NAPI_STATUS_RETURN(GetProperty(env, options, "adaptiveReadahead", result.readOptions.adaptive_readahead));
  result.readOptions.readahead_size = 0;
  NAPI_STATUS_RETURN(GetProperty(env, options, "readaheadSize", result.readOptions.readahead_size));
  result.readOptions.auto_readahead_size = true;
  NAPI_STATUS_RETURN(GetProperty(env, options, "autoReadaheadSize", result.readOptions.auto_readahead_size));
  result.readOptions.ignore_range_deletions = false;
  NAPI_STATUS_RETURN(GetProperty(env, options, "ignoreRangeDeletions",
                                 result.readOptions.ignore_range_deletions));

  return napi_ok;
}

static napi_status ConvertPackedFieldOffsets(napi_env env,
                                             const std::vector<uint32_t>& offsets,
                                             napi_value* result) {
  void* data = nullptr;
  napi_value buffer;
  NAPI_STATUS_RETURN(napi_create_arraybuffer(env, offsets.size() * sizeof(uint32_t), &data, &buffer));
  std::copy(offsets.begin(), offsets.end(), static_cast<uint32_t*>(data));
  NAPI_STATUS_RETURN(napi_create_typedarray(env, napi_uint32_array, offsets.size(), buffer, 0, result));
  return napi_ok;
}

class Iterator final : public BaseIterator, public std::enable_shared_from_this<Iterator> {
  Reference databaseContext_;
  const bool keys_;
  const bool values_;
  const size_t highWaterMarkBytes_;
  bool first_ = true;
  const Encoding keyEncoding_;
  const Encoding valueEncoding_;
  std::optional<std::string> keyFilterPattern_;
  std::optional<std::string> valueFilterPattern_;
  std::optional<re2::RE2> keyFilter_;
  std::optional<re2::RE2> valueFilter_;
  const bool unsafe_;
  bool terminal_ = false;

  bool ShouldAutoPackCurrent() const {
    if (values_) return CurrentValue().size() <= kAutoPackedValueBytes;
    if (keys_) return CurrentKey().size() <= kAutoPackedValueBytes;
    return true;
  }

  bool ValidatePackedEncodings(napi_env env, const PackedMode mode) const {
    if (mode == PackedMode::Unpacked ||
        ((!keys_ || SupportsPackedReads(keyEncoding_)) &&
         (!values_ || SupportsPackedReads(valueEncoding_)))) {
      return true;
    }

    napi_throw_type_error(env, nullptr, "Packed iterator only supports buffer or utf8 key and value encodings");
    return false;
  }

 public:
  Iterator(Database* database,
           std::shared_ptr<DatabaseReference> reference,
           IteratorOptions options)
      : BaseIterator(database, std::move(reference), options.column, options.reverse, options.lt, options.lte,
                     options.gt, options.gte, options.limit, options.readOptions),
        keys_(options.keys),
        values_(options.values),
        highWaterMarkBytes_(static_cast<size_t>(options.highWaterMarkBytes)),
        keyEncoding_(options.keyEncoding),
        valueEncoding_(options.valueEncoding),
        keyFilterPattern_(std::move(options.keyFilter)),
        valueFilterPattern_(std::move(options.valueFilter)),
        unsafe_(options.unsafe) {}

  rocksdb::Status Initialize(const std::optional<std::string>& initialTarget = std::nullopt) override {
    if (keyFilterPattern_) {
      keyFilter_.emplace(*keyFilterPattern_);
      if (!keyFilter_->ok()) {
        return rocksdb::Status::InvalidArgument("Invalid key filter regex");
      }
      keyFilterPattern_.reset();
    }

    if (valueFilterPattern_) {
      valueFilter_.emplace(*valueFilterPattern_);
      if (!valueFilter_->ok()) {
        return rocksdb::Status::InvalidArgument("Invalid value filter regex");
      }
      valueFilterPattern_.reset();
    }

    return BaseIterator::Initialize(initialTarget);
  }

  void Seek(const rocksdb::Slice& target) override {
    first_ = true;
    terminal_ = false;
    return BaseIterator::Seek(target);
  }

  rocksdb::Status Refresh() override {
    first_ = true;
    terminal_ = false;
    return BaseIterator::Refresh();
  }

  void SetDatabaseContext(Reference databaseContext) {
    databaseContext_ = std::move(databaseContext);
  }

  static std::shared_ptr<Iterator> create(Database* database,
                                          std::shared_ptr<DatabaseReference> reference,
                                          IteratorOptions options) {
    return std::make_shared<Iterator>(database, std::move(reference), std::move(options));
  }

  static std::shared_ptr<Iterator> create(napi_env env, napi_value db, napi_value options) {
    Database* database;
    std::shared_ptr<DatabaseReference> reference;
    NAPI_STATUS_THROWS(GetDatabase(env, db, database, &reference));
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));
    Reference databaseContext;
    NAPI_STATUS_THROWS(Reference::Create(env, db, databaseContext));

    IteratorOptions iteratorOptions;
    NAPI_STATUS_THROWS(GetIteratorOptions(env, options, database, iteratorOptions));

    auto iterator = create(database, std::move(reference), std::move(iteratorOptions));
    iterator->SetDatabaseContext(std::move(databaseContext));
    return iterator;
  }

  IteratorNextvOptions DefaultNextvOptions() const {
    IteratorNextvOptions options;
    options.highWaterMarkBytes = highWaterMarkBytes_;
    return options;
  }

  napi_value nextv(napi_env env,
                   uint32_t count,
                   const IteratorNextvOptions options,
                   napi_value callback,
                   const PackedMode mode = PackedMode::Unpacked,
                   const bool initialize = false,
                   std::optional<std::string> initialTarget = std::nullopt) {
    if (!ValidatePackedEncodings(env, mode)) return nullptr;

    struct State {
      std::vector<rocksdb::PinnableSlice> keys;
      std::vector<rocksdb::PinnableSlice> values;
      rocksdb::PinnableSlice packedData;
      std::vector<uint32_t> keyOffsets;
      std::vector<uint32_t> valueOffsets;
      size_t count = 0;
      size_t bytes = 0;
      bool finished = false;
      bool limited = false;
      bool packed = false;
      bool modeDecided = false;
      size_t processed = 0;
      IteratorStopReason reason = IteratorStopReason::None;
    };

    napi_value resourceName;
    NAPI_STATUS_THROWS(GetResourceName(env, ResourceIteratorNextv, resourceName));

    const auto self = shared_from_this();
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database_, reference_, databaseOperation));

    NAPI_STATUS_THROWS(runAsync<State>(
        resourceName, env, callback,
        [self, this, count, options, databaseOperation, mode, initialize,
         initialTarget = std::move(initialTarget)](auto& state) {
          const DatabaseOperationScope operationScope(databaseOperation);

          // Public next() can fuse lazy initialization and its first refill in
          // one worker. Preserve iterator_init's failure contract: a failed
          // initializer must detach and release its snapshot on this worker,
          // rather than leaving cleanup to the JS thread.
          if (initialize) {
            ROCKS_STATUS_RETURN(InitializeAndCloseOnErrorSafe(initialTarget));
          }

          std::lock_guard operationLock(operationMutex_);
          if (closed.load()) {
            return rocksdb::Status::InvalidArgument("Iterator is not open");
          }
          if (!IsInitialized()) {
            ROCKS_STATUS_RETURN(Initialize());
          } else {
            ROCKS_STATUS_RETURN(PreflightStatus());
          }

          // Query uses UINT32_MAX as its "all rows" sentinel. Reserving that
          // value would attempt a huge allocation before reading anything.
          const auto initialCapacity = std::min<size_t>(count, 4096);
          state.packed = mode == PackedMode::Packed;
          state.modeDecided = mode != PackedMode::Auto;
          if (state.packed) {
            if (keys_) state.keyOffsets.reserve(initialCapacity * 2);
            if (values_) state.valueOffsets.reserve(initialCapacity * 2);
            state.packedData.GetSelf()->reserve(
                std::min<size_t>(options.highWaterMarkBytes, initialCapacity * 128));
          } else if (state.modeDecided) {
            state.keys.reserve(initialCapacity);
            state.values.reserve(initialCapacity);
          }

          const auto deadline =
              options.timeout ? database_->db->GetEnv()->NowMicros() +
                                    static_cast<uint64_t>(options.timeout) * 1000
                              : 0;
          size_t scannedSinceDeadlineCheck = kDeadlineCheckInterval;

          while (true) {
            if (state.count >= count) {
              state.limited = true;
              break;
            }
            if (state.bytes > 0 && state.bytes > options.highWaterMarkBytes) {
              state.limited = true;
              state.reason = IteratorStopReason::Bytes;
              break;
            }
            if (state.processed > 0 && state.processed >= options.highWaterMarkCount) {
              state.limited = true;
              state.reason = IteratorStopReason::Count;
              break;
            }

            if (deadline > 0 && scannedSinceDeadlineCheck >= kDeadlineCheckInterval) {
              if (database_->db->GetEnv()->NowMicros() > deadline) {
                // Timed out: neither finished nor limited; the caller may retry.
                state.reason = IteratorStopReason::Timeout;
                break;
              }
              scannedSinceDeadlineCheck = 0;
            }

            // Natural or range exhaustion leaves the native iterator invalid.
            // Remember it so repeated raw reads do not call Next()/Prev() on an
            // invalid RocksDB iterator or repeat the range checks.
            if (terminal_) {
              state.finished = true;
              state.reason = IteratorStopReason::Eof;
              break;
            }

            if (!first_) {
              Next();
            } else {
              first_ = false;
            }

            if (!Valid()) {
              ROCKS_STATUS_RETURN(Status());
              // Iterator naturally exhausted.
              terminal_ = true;
              state.finished = true;
              state.reason = IteratorStopReason::Eof;
              break;
            }
            state.processed++;
            if (deadline > 0) scannedSinceDeadlineCheck++;

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
              terminal_ = true;
              state.finished = true;
              state.limited = true;
              state.reason = IteratorStopReason::Eof;
              break;
            }

            if (!state.modeDecided) {
              state.packed = ShouldAutoPackCurrent();
              state.modeDecided = true;
              if (state.packed) {
                if (keys_) state.keyOffsets.reserve(initialCapacity * 2);
                if (values_) state.valueOffsets.reserve(initialCapacity * 2);
                state.packedData.GetSelf()->reserve(
                    std::min<size_t>(options.highWaterMarkBytes, initialCapacity * 128));
              } else {
                state.keys.reserve(initialCapacity);
                state.values.reserve(initialCapacity);
              }
            }

            if (state.packed) {
              const auto append = [&](const rocksdb::Slice& value, std::vector<uint32_t>& offsets) {
                auto* data = state.packedData.GetSelf();
                if (value.size() > std::numeric_limits<uint32_t>::max() - data->size()) {
                  return rocksdb::Status::InvalidArgument("Packed iterator result exceeds 4 GiB");
                }
                offsets.push_back(static_cast<uint32_t>(data->size()));
                offsets.push_back(static_cast<uint32_t>(value.size()));
                data->append(value.data(), value.size());
                state.bytes += value.size();
                return rocksdb::Status::OK();
              };

              if (keys_) {
                ROCKS_STATUS_RETURN(append(CurrentKey(), state.keyOffsets));
              }
              if (values_) {
                ROCKS_STATUS_RETURN(append(CurrentValue(), state.valueOffsets));
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
        [self, this](auto& state, napi_env env, napi_value* result) {
          napi_value finished;
          NAPI_STATUS_RETURN(napi_get_boolean(env, state.finished, &finished));

          napi_value limited;
          NAPI_STATUS_RETURN(napi_get_boolean(env, state.limited, &limited));

          if (state.packed) {
            state.packedData.PinSelf();

            napi_value buffer;
            // The packed data owns its storage independently of RocksDB. For a
            // non-trivial batch, transfer that storage to the Buffer finalizer
            // instead of copying the whole arena a second time.
            NAPI_STATUS_RETURN(Convert(env, std::move(state.packedData), Encoding::Buffer, buffer, true));

            napi_value count;
            NAPI_STATUS_RETURN(napi_create_uint32(env, static_cast<uint32_t>(state.count), &count));

            napi_value keys;
            if (keys_) {
              NAPI_STATUS_RETURN(ConvertPackedFieldOffsets(env, state.keyOffsets, &keys));
            } else {
              NAPI_STATUS_RETURN(napi_get_undefined(env, &keys));
            }

            napi_value values;
            if (values_) {
              NAPI_STATUS_RETURN(ConvertPackedFieldOffsets(env, state.valueOffsets, &values));
            } else {
              NAPI_STATUS_RETURN(napi_get_undefined(env, &values));
            }

            NAPI_STATUS_RETURN(napi_create_object(env, result));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "buffer", buffer));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "count", count));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "keys", keys));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "values", values));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "finished", finished));
            NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "limited", limited));
            NAPI_STATUS_RETURN(SetIteratorStopReason(env, *result, state.reason));

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
          NAPI_STATUS_RETURN(SetIteratorStopReason(env, *result, state.reason));

          return napi_ok;
        }));

    return 0;
  }

  napi_value nextv(napi_env env,
                   uint32_t count,
                   const IteratorNextvOptions options,
                   const PackedMode mode = PackedMode::Unpacked) {
    if (!ValidatePackedEncodings(env, mode)) return nullptr;

    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database_, reference_, databaseOperation));
    std::lock_guard operationLock(operationMutex_);
    if (closed.load()) {
      napi_throw_error(env, "LEVEL_ITERATOR_NOT_OPEN", "Iterator is not open");
      return nullptr;
    }
    if (!IsInitialized()) {
      ROCKS_STATUS_THROWS_NAPI(Initialize());
    } else {
      ROCKS_STATUS_THROWS_NAPI(PreflightStatus());
    }

    napi_value finished;
    NAPI_STATUS_THROWS(napi_get_boolean(env, false, &finished));

    napi_value limited;
    NAPI_STATUS_THROWS(napi_get_boolean(env, false, &limited));

    napi_value rows = nullptr;
    rocksdb::PinnableSlice packedData;
    std::vector<uint32_t> keyOffsets;
    std::vector<uint32_t> valueOffsets;
    bool packed = mode == PackedMode::Packed;
    bool modeDecided = mode != PackedMode::Auto;
    if (packed) {
      const auto initialCapacity = std::min<size_t>(count, 4096);
      if (keys_) keyOffsets.reserve(initialCapacity * 2);
      if (values_) valueOffsets.reserve(initialCapacity * 2);
      packedData.GetSelf()->reserve(
          std::min<size_t>(options.highWaterMarkBytes, initialCapacity * 128));
    } else if (modeDecided) {
      NAPI_STATUS_THROWS(napi_create_array(env, &rows));
    }

    const auto deadline =
        options.timeout
            ? database_->db->GetEnv()->NowMicros() + static_cast<uint64_t>(options.timeout) * 1000
            : 0;
    size_t scannedSinceDeadlineCheck = kDeadlineCheckInterval;

    size_t rowCount = 0;
    size_t bytes = 0;
    size_t processed = 0;
    IteratorStopReason reason = IteratorStopReason::None;
    while (true) {
      if (rowCount >= count) {
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &limited));
        break;
      }
      if (bytes > 0 && bytes > options.highWaterMarkBytes) {
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &limited));
        reason = IteratorStopReason::Bytes;
        break;
      }
      if (processed > 0 && processed >= options.highWaterMarkCount) {
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &limited));
        reason = IteratorStopReason::Count;
        break;
      }

      if (deadline > 0 && scannedSinceDeadlineCheck >= kDeadlineCheckInterval) {
        if (database_->db->GetEnv()->NowMicros() > deadline) {
          // Timed out: neither finished nor limited; the caller may retry.
          reason = IteratorStopReason::Timeout;
          break;
        }
        scannedSinceDeadlineCheck = 0;
      }

      // Natural or range exhaustion leaves the native iterator invalid.
      // Remember it so repeated raw reads do not call Next()/Prev() on an
      // invalid RocksDB iterator or repeat the range checks.
      if (terminal_) {
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &finished));
        reason = IteratorStopReason::Eof;
        break;
      }

      if (!first_) {
        Next();
      } else {
        first_ = false;
      }

      if (!Valid()) {
        ROCKS_STATUS_THROWS_NAPI(Status());
        // Iterator naturally exhausted.
        terminal_ = true;
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &finished));
        reason = IteratorStopReason::Eof;
        break;
      }
      processed++;
      if (deadline > 0) scannedSinceDeadlineCheck++;

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
        terminal_ = true;
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &finished));
        NAPI_STATUS_THROWS(napi_get_boolean(env, true, &limited));
        reason = IteratorStopReason::Eof;
        break;
      }

      if (!modeDecided) {
        packed = ShouldAutoPackCurrent();
        modeDecided = true;
        if (packed) {
          const auto initialCapacity = std::min<size_t>(count, 4096);
          if (keys_) keyOffsets.reserve(initialCapacity * 2);
          if (values_) valueOffsets.reserve(initialCapacity * 2);
          packedData.GetSelf()->reserve(
              std::min<size_t>(options.highWaterMarkBytes, initialCapacity * 128));
        } else {
          NAPI_STATUS_THROWS(napi_create_array(env, &rows));
        }
      }

      if (packed) {
        const auto append = [&](const rocksdb::Slice& value, std::vector<uint32_t>& offsets) {
          auto* data = packedData.GetSelf();
          if (value.size() > std::numeric_limits<uint32_t>::max() - data->size()) {
            return rocksdb::Status::InvalidArgument("Packed iterator result exceeds 4 GiB");
          }
          offsets.push_back(static_cast<uint32_t>(data->size()));
          offsets.push_back(static_cast<uint32_t>(value.size()));
          data->append(value.data(), value.size());
          bytes += value.size();
          return rocksdb::Status::OK();
        };

        if (keys_) {
          ROCKS_STATUS_THROWS_NAPI(append(CurrentKey(), keyOffsets));
        }
        if (values_) {
          ROCKS_STATUS_THROWS_NAPI(append(CurrentValue(), valueOffsets));
        }
      } else {
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

        NAPI_STATUS_THROWS(napi_set_element(env, rows, rowCount * 2, key));
        NAPI_STATUS_THROWS(napi_set_element(env, rows, rowCount * 2 + 1, val));
      }

      rowCount += 1;
    }

    napi_value ret;
    NAPI_STATUS_THROWS(napi_create_object(env, &ret));
    if (packed) {
      packedData.PinSelf();

      napi_value buffer;
      NAPI_STATUS_THROWS(Convert(env, std::move(packedData), Encoding::Buffer, buffer, true));

      napi_value countValue;
      NAPI_STATUS_THROWS(napi_create_uint32(env, static_cast<uint32_t>(rowCount), &countValue));

      napi_value keysValue;
      if (keys_) {
        NAPI_STATUS_THROWS(ConvertPackedFieldOffsets(env, keyOffsets, &keysValue));
      } else {
        NAPI_STATUS_THROWS(napi_get_undefined(env, &keysValue));
      }

      napi_value valuesValue;
      if (values_) {
        NAPI_STATUS_THROWS(ConvertPackedFieldOffsets(env, valueOffsets, &valuesValue));
      } else {
        NAPI_STATUS_THROWS(napi_get_undefined(env, &valuesValue));
      }

      NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "buffer", buffer));
      NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "count", countValue));
      NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "keys", keysValue));
      NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "values", valuesValue));
    } else {
      if (rows == nullptr) {
        NAPI_STATUS_THROWS(napi_create_array(env, &rows));
      }
      NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "rows", rows));
    }
    NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "finished", finished));
    NAPI_STATUS_THROWS(napi_set_named_property(env, ret, "limited", limited));

    NAPI_STATUS_THROWS(SetIteratorStopReason(env, ret, reason));
    return ret;
  }
};

/**
 * Hook for when the environment exits. This hook will be called after
 * already-scheduled napi_async_work items have finished, which gives us
 * the guarantee that no db operations will be in-flight at this time.
 */
static void CloseDatabaseReferenceNoThrow(
    const std::shared_ptr<DatabaseReference>& reference) noexcept {
  // A normal close deliberately keeps a reference open when resource cleanup
  // throws so JavaScript can observe the error and retry. Finalizers and env
  // cleanup hooks have no future caller, so abandon attached resources only on
  // this cleanup-only path and make bounded attempts to reach a terminal state.
  // The bound also contains unrelated persistent native faults.
  for (int attempt = 0; attempt < 3; ++attempt) {
    try {
      reference->database->Close(reference).PermitUncheckedError();
    } catch (...) {
    }

    try {
      if (reference->database->IsClosed(reference)) return;
    } catch (...) {
    }

    reference->database->AbandonReferenceResourcesForCleanup(reference);
  }

  // The current lease has no later public close retry owner. Finish with a
  // dedicated terminal transition that bypasses test faults and decrements
  // this lease exactly once, while preserving peers and allowing this context
  // to acquire a fresh lease on a later open.
  reference->database->CloseForCleanup(reference);
}

static void env_cleanup_hook(void* data) noexcept {
  auto holder = reinterpret_cast<std::shared_ptr<DatabaseReference>*>(data);

  // Do everything that db_close() does but synchronously. We're expecting that GC
  // did not (yet) collect the database because that would be a user mistake (not
  // closing their db) made during the lifetime of the environment. That's different
  // from an environment being torn down (like the main process or a worker thread)
  // where it's our responsibility to clean up. Note also, the following code must
  // be a safe noop if called before db_open() or after db_close().
  if (holder && *holder) {
    CloseDatabaseReferenceNoThrow(*holder);
  }
}

static void FinalizeDatabase(napi_env env, void* data, void* hint) noexcept {
  auto holder = reinterpret_cast<std::shared_ptr<DatabaseReference>*>(data);
  if (holder) {
    napi_remove_env_cleanup_hook(env, env_cleanup_hook, holder);
    if (*holder) {
      CloseDatabaseReferenceNoThrow(*holder);
    }
    delete holder;
  }
}

static napi_value ThrowUnhandledNativeMethodException(napi_env env,
                                                       const char* message) noexcept {
  // Conversion helpers can already have raised a more precise JavaScript
  // exception before native stack unwinding begins. Preserve that exception
  // instead of replacing it with the generic C++ boundary error.
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    return nullptr;
  }

  napi_throw_error(env, "LEVEL_NATIVE_EXCEPTION", message);
  return nullptr;
}

// napi-macros exports callbacks directly. Put one noexcept boundary around
// every exported method so allocation failures and unexpected RocksDB or STL
// exceptions can never unwind through Node's C callback ABI. C++ exception
// tables make the healthy path branch-free on the supported toolchains.
#undef NAPI_METHOD
#define NAPI_METHOD(name)                                                            \
  static napi_value name##_impl(napi_env env, napi_callback_info info);              \
  static napi_value name(napi_env env, napi_callback_info info) noexcept {            \
    try {                                                                             \
      return name##_impl(env, info);                                                   \
    } catch (const std::exception& exception) {                                        \
      return ThrowUnhandledNativeMethodException(env, exception.what());               \
    } catch (...) {                                                                    \
      return ThrowUnhandledNativeMethodException(env,                                  \
                                                 "Unknown exception in native method"); \
    }                                                                                  \
  }                                                                                    \
  static napi_value name##_impl(napi_env env, napi_callback_info info)

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
    CloseDatabaseReferenceNoThrow(reference);
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

NAPI_METHOD(db_is_closed) {
  NAPI_ARGV(1);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference, false));

  napi_value result;
  NAPI_STATUS_THROWS(napi_get_boolean(env, database->IsClosed(reference), &result));
  return result;
}

#if defined(ROCKS_LEVEL_TEST_FAULTS)
NAPI_METHOD(test_faults_enabled) {
  napi_value result;
  NAPI_STATUS_THROWS(napi_get_boolean(env, true, &result));
  return result;
}
#endif

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
    return iterator->nextv(
        env, std::numeric_limits<uint32_t>::max(), iterator->DefaultNextvOptions());
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
    return iterator->nextv(
        env, std::numeric_limits<uint32_t>::max(), iterator->DefaultNextvOptions(), argv[2]);
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

    int parallelism = DefaultBackgroundParallelism(std::thread::hardware_concurrency());
    NAPI_STATUS_THROWS(GetProperty(env, options, "parallelism", parallelism));
    if (parallelism < 1 || parallelism > kMaxBackgroundParallelism) {
      napi_throw_range_error(env, nullptr, "parallelism must be an integer between 1 and 256");
      return nullptr;
    }

    // IncreaseParallelism sizes the (process-wide) Env LOW pool to `parallelism`
    // but pins the HIGH pool — where every flush of every DB sharing the default
    // Env runs — at a single thread, so flushes across DBs serialize behind one
    // thread. Both pools are process-wide: the last validated open attempt's
    // value wins.
    int flushParallelism = std::max(1, parallelism / 4);
    NAPI_STATUS_THROWS(GetProperty(env, options, "flushParallelism", flushParallelism));
    if (flushParallelism < 1 || flushParallelism > kMaxBackgroundParallelism) {
      napi_throw_range_error(env, nullptr, "flushParallelism must be an integer between 1 and 256");
      return nullptr;
    }

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

    NAPI_STATUS_THROWS(GetProperty(env, options, "atomicFlush", dbOptions.atomic_flush));

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

      napi_valuetype columnsType;
      NAPI_STATUS_THROWS(napi_typeof(env, columns, &columnsType));

      // Optional properties commonly survive object spreads with an undefined
      // value. Treat that exactly like an omitted column map.
      if (columnsType != napi_undefined) {
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

    // Do not mutate RocksDB's process-wide Env until all JavaScript options and
    // column descriptors have passed synchronous validation.
    if (!ConfigureBackgroundParallelism(env, dbOptions, parallelism, flushParallelism)) {
      return nullptr;
    }

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

// Synchronous last resort used only while JavaScript is unwinding a failed
// _open(). Native admission precedes completion conversion, so the reference
// may be Reserved, Open or already Inactive. Reuse the finalizer-grade cleanup
// path for all three phases, then truthfully verify that ownership was released.
NAPI_METHOD(db_cleanup_failed_open) {
  NAPI_ARGV(1);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference, false));

  CloseDatabaseReferenceNoThrow(reference);
  if (!database->IsClosed(reference)) {
    napi_throw_error(env, "LEVEL_DATABASE_NOT_CLOSED", "Failed-open database reference remains active");
    return nullptr;
  }

  return nullptr;
}

enum class PackedGetManyStatus : uint8_t {
  Value = 0,
  NotFound = 1,
  Incomplete = 2,
};

enum class GetManyUnsafe : uint32_t {
  Input = 1,
  Output = 2,
};

static constexpr uint32_t kGetManyUnsafeMask = static_cast<uint32_t>(GetManyUnsafe::Input) |
                                                static_cast<uint32_t>(GetManyUnsafe::Output);

static bool HasGetManyUnsafe(const uint32_t unsafe, const GetManyUnsafe flag) {
  return (unsafe & static_cast<uint32_t>(flag)) != 0;
}

static napi_status GetGetManyUnsafe(napi_env env, napi_value options, uint32_t& result) {
  result = 0;

  napi_valuetype optionsType;
  NAPI_STATUS_RETURN(napi_typeof(env, options, &optionsType));
  if (optionsType == napi_undefined || optionsType == napi_null) return napi_ok;
  if (optionsType != napi_object) return napi_invalid_arg;

  napi_value value;
  NAPI_STATUS_RETURN(napi_get_named_property(env, options, "unsafe", &value));

  napi_valuetype valueType;
  NAPI_STATUS_RETURN(napi_typeof(env, value, &valueType));
  if (valueType == napi_undefined || valueType == napi_null) return napi_ok;
  if (valueType == napi_boolean) {
    bool legacy;
    NAPI_STATUS_RETURN(GetValue(env, value, legacy));
    result = legacy ? static_cast<uint32_t>(GetManyUnsafe::Output) : 0;
    return napi_ok;
  }

  NAPI_STATUS_RETURN(GetValue(env, value, result));
  if ((result & ~kGetManyUnsafeMask) != 0) {
    NAPI_STATUS_RETURN(
        napi_throw_range_error(env, nullptr, "getMany unsafe must contain only INPUT (1) and OUTPUT (2)"));
    return napi_pending_exception;
  }
  return napi_ok;
}

struct PackedGetManyResult {
  rocksdb::PinnableSlice data;
  std::vector<int32_t> offsets;
  std::vector<uint8_t> statuses;
};

static bool ShouldAutoPackGetMany(const std::vector<rocksdb::Status>& statuses,
                                  const std::vector<rocksdb::PinnableSlice>& values) {
  size_t count = 0;
  size_t bytes = 0;
  for (size_t n = 0; n < statuses.size(); n++) {
    if (statuses[n].ok()) {
      if (values[n].size() > std::numeric_limits<size_t>::max() - bytes) return false;
      count += 1;
      bytes += values[n].size();
    }
  }
  return count > 0 && count <= std::numeric_limits<size_t>::max() / kAutoPackedValueBytes &&
         bytes <= count * kAutoPackedValueBytes;
}

static rocksdb::Status PackGetManyResult(const std::vector<rocksdb::Status>& statuses,
                                         const std::vector<rocksdb::PinnableSlice>& values,
                                         PackedGetManyResult& result) {
  result.offsets.reserve(statuses.size() * 2);
  result.statuses.reserve(statuses.size());

  auto* data = result.data.GetSelf();
  for (size_t n = 0; n < statuses.size(); n++) {
    const auto& status = statuses[n];
    if (status.IsNotFound()) {
      result.statuses.push_back(static_cast<uint8_t>(PackedGetManyStatus::NotFound));
      result.offsets.push_back(-1);
      result.offsets.push_back(0);
    } else if (status.IsAborted() || status.IsTimedOut()) {
      result.statuses.push_back(static_cast<uint8_t>(PackedGetManyStatus::Incomplete));
      result.offsets.push_back(-1);
      result.offsets.push_back(-1);
    } else {
      ROCKS_STATUS_RETURN(status);
      constexpr auto maxPackedSize = static_cast<size_t>(std::numeric_limits<int32_t>::max());
      if (data->size() > maxPackedSize || values[n].size() > maxPackedSize - data->size()) {
        return rocksdb::Status::InvalidArgument("Packed getMany result exceeds 2 GiB");
      }
      result.offsets.push_back(static_cast<int32_t>(data->size()));
      result.offsets.push_back(static_cast<int32_t>(values[n].size()));
      data->append(values[n].data(), values[n].size());
      result.statuses.push_back(static_cast<uint8_t>(PackedGetManyStatus::Value));
    }
  }

  return rocksdb::Status::OK();
}

static napi_status ConvertPackedGetManyResult(napi_env env,
                                              PackedGetManyResult& state,
                                              napi_value* result,
                                              const bool unsafe) {
  state.data.PinSelf();

  napi_value buffer;
  NAPI_STATUS_RETURN(Convert(env, std::move(state.data), Encoding::Buffer, buffer, unsafe));

  void* offsetsData = nullptr;
  napi_value offsetsBuffer;
  NAPI_STATUS_RETURN(
      napi_create_arraybuffer(env, state.offsets.size() * sizeof(int32_t), &offsetsData, &offsetsBuffer));
  std::copy(state.offsets.begin(), state.offsets.end(), static_cast<int32_t*>(offsetsData));

  napi_value offsets;
  NAPI_STATUS_RETURN(
      napi_create_typedarray(env, napi_int32_array, state.offsets.size(), offsetsBuffer, 0, &offsets));

  void* statusesData = nullptr;
  napi_value statusesBuffer;
  NAPI_STATUS_RETURN(
      napi_create_arraybuffer(env, state.statuses.size() * sizeof(uint8_t), &statusesData, &statusesBuffer));
  std::copy(state.statuses.begin(), state.statuses.end(), static_cast<uint8_t*>(statusesData));

  napi_value statuses;
  NAPI_STATUS_RETURN(
      napi_create_typedarray(env, napi_uint8_array, state.statuses.size(), statusesBuffer, 0, &statuses));

  napi_value count;
  NAPI_STATUS_RETURN(napi_create_uint32(env, static_cast<uint32_t>(state.statuses.size()), &count));

  NAPI_STATUS_RETURN(napi_create_object(env, result));
  NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "buffer", buffer));
  NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "offsets", offsets));
  NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "statuses", statuses));
  NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "count", count));

  return napi_ok;
}

struct PackedGetManyInput {
  const char* data = nullptr;
  size_t dataLength = 0;
  const uint32_t* offsets = nullptr;
  size_t offsetsLength = 0;

  size_t size() const { return offsetsLength / 2; }
};

static napi_status PackedGetManyInputError(napi_env env, const char* message) {
  NAPI_STATUS_RETURN(napi_throw_type_error(env, nullptr, message));
  return napi_pending_exception;
}

static napi_status GetPackedGetManyInput(napi_env env,
                                         napi_value input,
                                         PackedGetManyInput& result,
                                         napi_value* backing = nullptr) {
  napi_valuetype inputType;
  NAPI_STATUS_RETURN(napi_typeof(env, input, &inputType));
  if (inputType != napi_object) {
    return PackedGetManyInputError(env, "Packed getMany input must be an object");
  }

  {
    napi_value value;
    NAPI_STATUS_RETURN(napi_get_named_property(env, input, "offsets", &value));
    bool isTypedArray = false;
    NAPI_STATUS_RETURN(napi_is_typedarray(env, value, &isTypedArray));
    if (!isTypedArray) {
      return PackedGetManyInputError(env, "Packed getMany input offsets must be a Uint32Array");
    }
    napi_typedarray_type type;
    void* data = nullptr;
    napi_value arrayBuffer;
    size_t byteOffset = 0;
    NAPI_STATUS_RETURN(
        napi_get_typedarray_info(env, value, &type, &result.offsetsLength, &data, &arrayBuffer, &byteOffset));
    if (type != napi_uint32_array) {
      return PackedGetManyInputError(env, "Packed getMany input offsets must be a Uint32Array");
    }
    result.offsets = static_cast<const uint32_t*>(data);
  }

  {
    napi_value value;
    NAPI_STATUS_RETURN(napi_get_named_property(env, input, "buffer", &value));
    bool isBuffer = false;
    NAPI_STATUS_RETURN(napi_is_buffer(env, value, &isBuffer));
    if (!isBuffer) {
      return PackedGetManyInputError(env, "Packed getMany input buffer must be a Buffer");
    }
    void* data = nullptr;
    NAPI_STATUS_RETURN(napi_get_buffer_info(env, value, &data, &result.dataLength));
    result.data = static_cast<const char*>(data);
    if (backing) *backing = value;
  }

  if (result.offsetsLength % 2 != 0) {
    return PackedGetManyInputError(env, "Packed getMany input offsets must contain offset-length pairs");
  }

  for (size_t index = 0; index < result.offsetsLength; index += 2) {
    const auto offset = static_cast<size_t>(result.offsets[index]);
    const auto length = static_cast<size_t>(result.offsets[index + 1]);
    if (offset > result.dataLength || length > result.dataLength - offset) {
      return PackedGetManyInputError(env, "Packed getMany input offsets are outside its buffer");
    }
  }

  return napi_ok;
}

struct OwnedGetManyKey {
  napi_value value = nullptr;
  size_t offset = 0;
  size_t length = 0;
};

class AsyncGetManyStringSlabPool {
 public:
  std::string Acquire(const size_t minimumCapacity) {
    std::lock_guard lock(mutex_);
    if (slabs_.empty()) return {};

    // Prefer the smallest slab that already fits. If none does, grow the
    // largest retained slab and leave smaller ones for smaller requests.
    auto slab = slabs_.end();
    for (auto candidate = slabs_.begin(); candidate != slabs_.end(); ++candidate) {
      if (candidate->capacity() >= minimumCapacity &&
          (slab == slabs_.end() || candidate->capacity() < slab->capacity())) {
        slab = candidate;
      }
    }
    if (slab == slabs_.end()) {
      slab = std::max_element(
          slabs_.begin(), slabs_.end(), [](const auto& left, const auto& right) {
            return left.capacity() < right.capacity();
          });
    }
    retainedCapacity_ -= slab->capacity();
    auto result = std::move(*slab);
    slabs_.erase(slab);
    return result;
  }

  void Release(std::string&& slab) noexcept {
    try {
      slab.clear();
      const auto capacity = slab.capacity();
      if (capacity == 0 || capacity > kMaxRetainedCapacity) return;

      std::lock_guard lock(mutex_);
      if (slabs_.size() >= kMaxRetainedSlabs ||
          capacity > kMaxRetainedCapacity - retainedCapacity_) {
        return;
      }
      slabs_.push_back(std::move(slab));
      retainedCapacity_ += capacity;
    } catch (...) {
      // Pooling is opportunistic. Allocation or teardown failures must not
      // turn a successfully completed read into a process-level exception.
    }
  }

 private:
  static constexpr size_t kMaxRetainedSlabs = 32;
  static constexpr size_t kMaxRetainedCapacity = 8 * 1024 * 1024;

  std::mutex mutex_;
  std::vector<std::string> slabs_;
  size_t retainedCapacity_ = 0;
};

static AsyncGetManyStringSlabPool asyncGetManyStringSlabPool;

class AsyncGetManyStringSlabLease {
 public:
  AsyncGetManyStringSlabLease() = default;

  ~AsyncGetManyStringSlabLease() { Release(); }

  AsyncGetManyStringSlabLease(AsyncGetManyStringSlabLease&& other) noexcept
      : data_(std::move(other.data_)), active_(std::exchange(other.active_, false)) {}

  AsyncGetManyStringSlabLease& operator=(AsyncGetManyStringSlabLease&& other) noexcept {
    if (this != &other) {
      Release();
      data_ = std::move(other.data_);
      active_ = std::exchange(other.active_, false);
    }
    return *this;
  }

  AsyncGetManyStringSlabLease(const AsyncGetManyStringSlabLease&) = delete;
  AsyncGetManyStringSlabLease& operator=(const AsyncGetManyStringSlabLease&) = delete;

  std::string& Acquire(const size_t minimumCapacity) {
    if (!active_) {
      data_ = asyncGetManyStringSlabPool.Acquire(minimumCapacity);
      active_ = true;
    }
    return data_;
  }

  const std::string& data() const { return data_; }

 private:
  void Release() noexcept {
    if (!active_) return;
    active_ = false;
    asyncGetManyStringSlabPool.Release(std::move(data_));
  }

  std::string data_;
  bool active_ = false;
};

struct OwnedGetManyKeys {
  std::vector<std::string> array;
  std::string packedData;
  std::vector<OwnedGetManyKey> packedKeys;
  std::string* reusablePackedData = nullptr;
  AsyncGetManyStringSlabLease asyncPackedData;
  bool poolAsyncPackedData = false;
  bool packed = false;

  size_t size() const { return packed ? packedKeys.size() : array.size(); }

  std::string& data(const size_t minimumCapacity = 0) {
    if (reusablePackedData) return *reusablePackedData;
    if (poolAsyncPackedData) return asyncPackedData.Acquire(minimumCapacity);
    return packedData;
  }

  const std::string& data() const {
    if (reusablePackedData) return *reusablePackedData;
    if (poolAsyncPackedData) return asyncPackedData.data();
    return packedData;
  }

  std::vector<rocksdb::Slice> slices() const {
    std::vector<rocksdb::Slice> result;
    result.reserve(size());
    if (packed) {
      const auto* const base = data().data();
      for (const auto& key : packedKeys) {
        result.emplace_back(base + key.offset, key.length);
      }
    } else {
      for (const auto& key : array) result.emplace_back(key);
    }
    return result;
  }
};

static napi_status AddStringGetManyKey(napi_env env, napi_value key, OwnedGetManyKeys& result) {
  size_t length = 0;
  NAPI_STATUS_RETURN(napi_get_value_string_utf8(env, key, nullptr, 0, &length));

  const auto offset = result.packedKeys.empty()
                          ? 0
                          : result.packedKeys.back().offset + result.packedKeys.back().length;
  // Keep one byte for the trailing NUL that N-API writes while converting the
  // final key. Terminators between keys are overwritten by the next key.
  if (offset >= result.packedData.max_size() ||
      length > result.packedData.max_size() - offset - 1) {
    NAPI_STATUS_RETURN(
        napi_throw_range_error(env, nullptr, "String getMany keys exceed addressable memory"));
    return napi_pending_exception;
  }

  result.packedKeys.push_back({key, offset, length});
  return napi_ok;
}

static napi_status PackStringGetManyKeys(napi_env env, OwnedGetManyKeys& result) {
  const auto keyBytes = result.packedKeys.empty()
                            ? 0
                            : result.packedKeys.back().offset + result.packedKeys.back().length;
  auto& data = result.data(keyBytes + 1);
  data.resize(keyBytes + 1);

  for (auto& key : result.packedKeys) {
    size_t written = 0;
    NAPI_STATUS_RETURN(napi_get_value_string_utf8(env,
                                                  key.value,
                                                  data.data() + key.offset,
                                                  key.length + 1,
                                                  &written));
    key.value = nullptr;
  }

  data.resize(keyBytes);
  result.packed = true;
  return napi_ok;
}

static napi_status GetOwnedPackedGetManyKeys(napi_env env,
                                             napi_value input,
                                             OwnedGetManyKeys& result) {
  PackedGetManyInput packed;
  NAPI_STATUS_RETURN(GetPackedGetManyInput(env, input, packed));
  result.packed = true;
  result.packedKeys.reserve(packed.size());

  size_t keyBytes = 0;
  for (size_t index = 0; index < packed.size(); ++index) {
    const auto length = static_cast<size_t>(packed.offsets[index * 2 + 1]);
    if (length > std::numeric_limits<uint32_t>::max() - keyBytes) {
      return PackedGetManyInputError(env, "Packed getMany keys exceed 4 GiB");
    }
    keyBytes += length;
  }
  auto& packedData = result.data(keyBytes);
  packedData.reserve(keyBytes);

  const auto* data = packed.data == nullptr ? "" : packed.data;
  for (size_t index = 0; index < packed.size(); ++index) {
    const auto layoutIndex = index * 2;
    const auto offset = packed.offsets[layoutIndex];
    const auto length = packed.offsets[layoutIndex + 1];
    const auto targetOffset = packedData.size();
    packedData.append(data + offset, length);
    result.packedKeys.push_back({nullptr, targetOffset, length});
  }

  return napi_ok;
}

struct GetManyInputKeys {
  OwnedGetManyKeys owned;
  std::vector<rocksdb::Slice> borrowed;
  std::vector<bool> isBorrowed;
  std::shared_ptr<Reference> reference;

  size_t size() const { return isBorrowed.empty() ? owned.size() : isBorrowed.size(); }

  std::vector<rocksdb::Slice> slices() const {
    if (isBorrowed.empty()) return owned.slices();

    std::vector<rocksdb::Slice> result;
    result.reserve(isBorrowed.size());
    for (size_t index = 0; index < isBorrowed.size(); ++index) {
      result.emplace_back(isBorrowed[index] ? borrowed[index] : rocksdb::Slice(owned.array[index]));
    }
    return result;
  }
};

struct ReusableSyncGetManyStringSlab {
  std::string data;
  bool inUse = false;
};

// Retain UTF-8 key capacity between top-level synchronous calls. Keep one slab
// per thread because separate Worker isolates may issue synchronous reads
// concurrently. Reentrant calls use their own slab so option or key getters
// cannot overwrite an outer call's admitted keys.
static thread_local ReusableSyncGetManyStringSlab reusableSyncGetManyStringSlab;

class ReusableSyncGetManyStringSlabLease {
 public:
  explicit ReusableSyncGetManyStringSlabLease(ReusableSyncGetManyStringSlab& slab)
      : slab_(slab.inUse ? nullptr : &slab) {
    if (slab_) slab_->inUse = true;
  }

  ~ReusableSyncGetManyStringSlabLease() {
    if (slab_) slab_->inUse = false;
  }

  ReusableSyncGetManyStringSlabLease(const ReusableSyncGetManyStringSlabLease&) = delete;
  ReusableSyncGetManyStringSlabLease& operator=(const ReusableSyncGetManyStringSlabLease&) = delete;

  std::string* data() const { return slab_ ? &slab_->data : nullptr; }

 private:
  ReusableSyncGetManyStringSlab* slab_;
};

static napi_status GetArrayGetManyInputKeys(napi_env env,
                                            napi_value input,
                                            const bool borrow,
                                            const bool retainBorrowed,
                                            GetManyInputKeys& result) {
  uint32_t count = 0;
  NAPI_STATUS_RETURN(napi_get_array_length(env, input, &count));

  result.owned.packedKeys.reserve(count);

  napi_value backings = nullptr;
  bool mixed = false;
  for (uint32_t index = 0; index < count; ++index) {
    napi_value key;
    NAPI_STATUS_RETURN(napi_get_element(env, input, index, &key));

    napi_valuetype type;
    NAPI_STATUS_RETURN(napi_typeof(env, key, &type));
    if (!mixed && type == napi_string) {
      NAPI_STATUS_RETURN(AddStringGetManyKey(env, key, result.owned));
      continue;
    }

    if (!mixed) {
      mixed = true;
      result.owned.array.resize(count);
      if (borrow) {
        result.borrowed.resize(count);
        result.isBorrowed.resize(count, false);
      }
      for (size_t previous = 0; previous < result.owned.packedKeys.size(); ++previous) {
        NAPI_STATUS_RETURN(
            GetValue(env, result.owned.packedKeys[previous].value, result.owned.array[previous]));
      }
      result.owned.packedKeys.clear();
    }

    if (!borrow || type == napi_string) {
      NAPI_STATUS_RETURN(GetValue(env, key, result.owned.array[index]));
      continue;
    }

    napi_value backing;
    NAPI_STATUS_RETURN(
        GetString(env, key, result.borrowed[index], retainBorrowed ? &backing : nullptr));
    if (retainBorrowed) {
      if (!backings) {
        NAPI_STATUS_RETURN(napi_create_array_with_length(env, count, &backings));
      }
      NAPI_STATUS_RETURN(napi_set_element(env, backings, index, backing));
    }
    result.isBorrowed[index] = true;
  }

  if (!mixed) return PackStringGetManyKeys(env, result.owned);

  if (retainBorrowed && backings) {
    result.reference = std::make_shared<Reference>();
    NAPI_STATUS_RETURN(Reference::Create(env, backings, *result.reference));
  }
  return napi_ok;
}

static napi_status GetGetManyInputKeys(napi_env env,
                                       napi_value input,
                                       const bool borrow,
                                       const bool retainBorrowed,
                                       GetManyInputKeys& result) {
  bool isArray = false;
  NAPI_STATUS_RETURN(napi_is_array(env, input, &isArray));
  if (isArray) return GetArrayGetManyInputKeys(env, input, borrow, retainBorrowed, result);

  if (!borrow) return GetOwnedPackedGetManyKeys(env, input, result.owned);

  napi_value backing = nullptr;
  PackedGetManyInput packed;
  NAPI_STATUS_RETURN(
      GetPackedGetManyInput(env, input, packed, retainBorrowed ? &backing : nullptr));
  result.borrowed.resize(packed.size());
  result.isBorrowed.resize(packed.size(), true);
  const auto* data = packed.data == nullptr ? "" : packed.data;
  for (size_t index = 0; index < packed.size(); ++index) {
    const auto layoutIndex = index * 2;
    result.borrowed[index] =
        rocksdb::Slice(data + packed.offsets[layoutIndex], packed.offsets[layoutIndex + 1]);
  }

  if (retainBorrowed && backing) {
    result.reference = std::make_shared<Reference>();
    NAPI_STATUS_RETURN(Reference::Create(env, backing, *result.reference));
  }
  return napi_ok;
}

static napi_value db_get_many_sync_impl(napi_env env, napi_callback_info info, const PackedMode mode) {
  NAPI_ARGV(3);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  rocksdb::ColumnFamilyHandle* column = database->db->DefaultColumnFamily();
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[2], database, column));

  Encoding valueEncoding = Encoding::Buffer;
  if (mode != PackedMode::Packed) {
    NAPI_STATUS_THROWS(GetProperty(env, argv[2], "valueEncoding", valueEncoding));
  }

  uint32_t timeout = 0;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "timeout", timeout));

  uint32_t unsafe = 0;
  NAPI_STATUS_THROWS(GetGetManyUnsafe(env, argv[2], unsafe));

  const auto unsafeOutput = HasGetManyUnsafe(unsafe, GetManyUnsafe::Output);
  ReusableSyncGetManyStringSlabLease slabLease(reusableSyncGetManyStringSlab);
  GetManyInputKeys inputKeys;
  inputKeys.owned.reusablePackedData = slabLease.data();
  // JavaScript cannot run after synchronous admission, so byte-backed keys can
  // always be borrowed for the duration of MultiGet. Immutable strings still
  // become native-owned copies during conversion.
  NAPI_STATUS_THROWS(GetGetManyInputKeys(env, argv[1], true, false, inputKeys));
  const auto keys = inputKeys.slices();
  const auto count = static_cast<uint32_t>(keys.size());
  std::vector<rocksdb::Status> statuses;
  statuses.resize(count);
  std::vector<rocksdb::PinnableSlice> values;
  values.resize(count);

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

  const auto packed = mode == PackedMode::Packed ||
                      (mode == PackedMode::Auto && ShouldAutoPackGetMany(statuses, values));
  if (packed) {
    PackedGetManyResult packedResult;
    ROCKS_STATUS_THROWS_NAPI(PackGetManyResult(statuses, values, packedResult));

    napi_value result;
    NAPI_STATUS_THROWS(ConvertPackedGetManyResult(env, packedResult, &result, unsafeOutput));
    return result;
  }

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
      // Safe output copies every value. OUTPUT may transfer internally-owned
      // slices; Convert still copies cache-pinned values that cannot outlive
      // their RocksDB owner.
      NAPI_STATUS_THROWS(Convert(env, std::move(values[n]), valueEncoding, row, unsafeOutput));
    }
    NAPI_STATUS_THROWS(napi_set_element(env, rows, n, row));
  }

  return rows;
}

NAPI_METHOD(db_get_many_sync) {
  return db_get_many_sync_impl(env, info, PackedMode::Unpacked);
}

NAPI_METHOD(db_get_many_packed_sync) {
  return db_get_many_sync_impl(env, info, PackedMode::Packed);
}

NAPI_METHOD(db_get_many_auto_sync) {
  return db_get_many_sync_impl(env, info, PackedMode::Auto);
}

static napi_value db_get_many_impl(napi_env env, napi_callback_info info, const PackedMode mode) {
  NAPI_ARGV(4);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  rocksdb::ColumnFamilyHandle* column = database->db->DefaultColumnFamily();
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[2], database, column));

  Encoding valueEncoding = Encoding::Buffer;
  if (mode != PackedMode::Packed) {
    NAPI_STATUS_THROWS(GetProperty(env, argv[2], "valueEncoding", valueEncoding));
  }

  uint32_t timeout = 0;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "timeout", timeout));

  uint32_t unsafe = 0;
  NAPI_STATUS_THROWS(GetGetManyUnsafe(env, argv[2], unsafe));
  const auto unsafeInput = HasGetManyUnsafe(unsafe, GetManyUnsafe::Input);
  const auto unsafeOutput = HasGetManyUnsafe(unsafe, GetManyUnsafe::Output);

  auto callback = argv[3];

  // Safe async work snapshots keys on the JS thread. INPUT permits borrowing
  // exact Buffer/SliceLike backings instead; retain those backings until the
  // worker completes even if the caller replaces or releases its containers.
  GetManyInputKeys inputKeys;
  // The move-only lease follows inputKeys into runAsyncKeepAlive's execute
  // functor and returns its capacity when Complete destroys the worker.
  inputKeys.owned.poolAsyncPackedData = true;
  NAPI_STATUS_THROWS(GetGetManyInputKeys(env, argv[1], unsafeInput, true, inputKeys));
  const auto count = static_cast<uint32_t>(inputKeys.size());

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
    PackedGetManyResult packedResult;
    bool packed = false;
  };

  NAPI_STATUS_THROWS(runAsyncKeepAlive<State>(
      resourceName, env, callback, argv[0],
      [=, inputKeys = std::move(inputKeys), readOptions = std::move(readOptions)](auto& state) {
        // MultiGet can return slices pinned to RocksDB cache memory. Retain the
        // operation through JS conversion (the async worker owns this functor
        // until Complete) so safe conversion performs only its one required
        // copy and raw db_close cannot tear down the cache first.
        (void)databaseOperation;

        const auto keys = inputKeys.slices();

        state.statuses.resize(count);
        state.values.resize(count);

        database->db->MultiGet(readOptions, column, count, keys.data(), state.values.data(), state.statuses.data());

        state.packed = mode == PackedMode::Packed ||
                       (mode == PackedMode::Auto && ShouldAutoPackGetMany(state.statuses, state.values));
        return state.packed ? PackGetManyResult(state.statuses, state.values, state.packedResult)
                            : rocksdb::Status::OK();
      },
      [=](auto& state, napi_env env, napi_value* result) {
        if (state.packed) {
          return ConvertPackedGetManyResult(env, state.packedResult, result, unsafeOutput);
        }

        NAPI_STATUS_RETURN(napi_create_array_with_length(env, count, result));

        for (uint32_t n = 0; n < count; n++) {
          napi_value row;
          if (state.statuses[n].IsNotFound()) {
            NAPI_STATUS_RETURN(napi_get_undefined(env, &row));
          } else if (state.statuses[n].IsAborted() || state.statuses[n].IsTimedOut()) {
            NAPI_STATUS_RETURN(napi_get_null(env, &row));
          } else {
            ROCKS_STATUS_RETURN_NAPI(state.statuses[n]);
            NAPI_STATUS_RETURN(Convert(env, std::move(state.values[n]), valueEncoding, row, unsafeOutput));
          }
          NAPI_STATUS_RETURN(napi_set_element(env, *result, n, row));
        }

        return napi_ok;
      }));

  return 0;
}

NAPI_METHOD(db_get_many) {
  return db_get_many_impl(env, info, PackedMode::Unpacked);
}

NAPI_METHOD(db_get_many_packed) {
  return db_get_many_impl(env, info, PackedMode::Packed);
}

NAPI_METHOD(db_get_many_auto) {
  return db_get_many_impl(env, info, PackedMode::Auto);
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

  bool disableWAL = false;
  NAPI_STATUS_THROWS(GetProperty(env, options, "disableWAL", disableWAL));

  const auto callback = argv[2];
  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownClear, resourceName));

  NAPI_STATUS_THROWS(runAsyncKeepAlive(
      resourceName, env, callback, argv[0],
      [database, databaseOperation, column, reverse, limit, lt = std::move(lt), lte = std::move(lte),
       gt = std::move(gt), gte = std::move(gte), sync, lowPriority, disableWAL](auto& state) {
        const DatabaseOperationScope operationScope(databaseOperation);
        if (limit == 0) {
          return rocksdb::Status::OK();
        }

        rocksdb::WriteOptions writeOptions;
        writeOptions.sync = sync;
        writeOptions.low_pri = lowPriority;
        writeOptions.disableWAL = disableWAL;
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

// Batch form of db_get_property: read several rocksdb properties from ONE
// column family in a single native call, returning an object keyed by property
// name. Callers that sample many properties per tick (e.g. per-column-family
// stats snapshots) otherwise pay one JS<->native transition per property; the
// column handle is also resolved once here instead of per call.
NAPI_METHOD(db_get_properties) {
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

  bool isArray = false;
  NAPI_STATUS_THROWS(napi_is_array(env, argv[1], &isArray));
  if (!isArray) {
    napi_throw_type_error(env, NULL, "The first argument 'properties' must be an array");
    return NULL;
  }

  uint32_t length = 0;
  NAPI_STATUS_THROWS(napi_get_array_length(env, argv[1], &length));

  // Resolve the column once for the whole batch.
  rocksdb::ColumnFamilyHandle* column = database->db->DefaultColumnFamily();
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[2], database, column));

  napi_value result;
  NAPI_STATUS_THROWS(napi_create_object(env, &result));

  std::string value;
  for (uint32_t n = 0; n < length; ++n) {
    napi_value name;
    NAPI_STATUS_THROWS(napi_get_element(env, argv[1], n, &name));

    napi_valuetype type;
    NAPI_STATUS_THROWS(napi_typeof(env, name, &type));
    if (type != napi_string) {
      napi_throw_type_error(env, NULL, "The 'properties' array must contain only strings");
      return NULL;
    }

    rocksdb::PinnableSlice property;
    NAPI_STATUS_THROWS(GetValue(env, name, property));

    // Match db_get_property: a missing property yields an empty string rather
    // than throwing, so callers can Number()-coerce uniformly.
    value.clear();
    database->db->GetProperty(column, property, &value);

    napi_value element;
    NAPI_STATUS_THROWS(napi_create_string_utf8(env, value.data(), value.size(), &element));
    // Define an own data property so a property named "__proto__" does not
    // invoke Object.prototype's setter and disappear from the result.
    napi_property_descriptor descriptor = {
        nullptr, name, nullptr, nullptr, nullptr, element, napi_default_jsproperty, nullptr};
    NAPI_STATUS_THROWS(napi_define_properties(env, result, 1, &descriptor));
  }

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

NAPI_METHOD(db_flush) {
  NAPI_ARGV(2);

  Database* database;
  std::shared_ptr<DatabaseReference> reference;
  NAPI_STATUS_THROWS(GetDatabase(env, argv[0], database, &reference));
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, reference, databaseOperation));

  std::vector<rocksdb::ColumnFamilyHandle*> columns;
  if (database->columns.empty()) {
    columns.push_back(database->db->DefaultColumnFamily());
  } else {
    columns.reserve(database->columns.size());
    for (const auto& entry : database->columns) {
      columns.push_back(entry.second.handle);
    }
  }

  const auto callback = argv[1];
  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownFlush, resourceName));

  NAPI_STATUS_THROWS(runAsyncKeepAlive(
      resourceName, env, callback, argv[0],
      [database, databaseOperation, columns = std::move(columns)](auto& state) {
        const DatabaseOperationScope operationScope(databaseOperation);
        return database->db->Flush(rocksdb::FlushOptions(), columns);
      }));

  return 0;
}

NAPI_METHOD(iterator_init) {
  NAPI_ARGV(3);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    std::optional<std::string> initialTarget;
    napi_valuetype targetType;
    NAPI_STATUS_THROWS(napi_typeof(env, argv[1], &targetType));
    if (targetType != napi_undefined && targetType != napi_null) {
      NAPI_STATUS_THROWS(GetValue(env, argv[1], initialTarget));
    }

    napi_value resourceName;
    NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownIteratorInit, resourceName));
    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(
        BeginDatabaseOperation(env, iterator->database_, iterator->reference_, databaseOperation));

    NAPI_STATUS_THROWS(runAsyncKeepAlive(
        resourceName, env, argv[2], argv[0],
        [iterator, databaseOperation, initialTarget = std::move(initialTarget)](auto& state) {
          const DatabaseOperationScope operationScope(databaseOperation);
          return iterator->InitializeAndCloseOnErrorSafe(initialTarget);
        }));
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }

  return nullptr;
}

NAPI_METHOD(iterator_init_nextv) {
  NAPI_ARGV(5);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    std::optional<std::string> initialTarget;
    napi_valuetype targetType;
    NAPI_STATUS_THROWS(napi_typeof(env, argv[1], &targetType));
    if (targetType != napi_undefined && targetType != napi_null) {
      NAPI_STATUS_THROWS(GetValue(env, argv[1], initialTarget));
    }

    uint32_t count = 1024;
    NAPI_STATUS_THROWS(GetValue(env, argv[2], count));

    auto options = iterator->DefaultNextvOptions();
    NAPI_STATUS_THROWS(GetIteratorNextvOptions(env, argv[3], options));

    return iterator->nextv(env, count, options, argv[4], PackedMode::Unpacked, true,
                           std::move(initialTarget));
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(iterator_is_initialized) {
  NAPI_ARGV(1);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    napi_value result;
    NAPI_STATUS_THROWS(napi_get_boolean(env, iterator->IsInitializedSafe(), &result));
    return result;
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(iterator_init_sync) {
  NAPI_ARGV(2);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    std::optional<std::string> initialTarget;
    napi_valuetype targetType;
    NAPI_STATUS_THROWS(napi_typeof(env, argv[1], &targetType));
    if (targetType != napi_undefined && targetType != napi_null) {
      NAPI_STATUS_THROWS(GetValue(env, argv[1], initialTarget));
    }

    std::shared_ptr<DatabaseOperation> databaseOperation;
    NAPI_STATUS_THROWS(
        BeginDatabaseOperation(env, iterator->database_, iterator->reference_, databaseOperation));
    ROCKS_STATUS_THROWS_NAPI(iterator->InitializeSafe(initialTarget));
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }

  return nullptr;
}

NAPI_METHOD(iterator_create) {
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

    auto options = iterator->DefaultNextvOptions();
    NAPI_STATUS_THROWS(GetIteratorNextvOptions(env, argv[2], options));

    return iterator->nextv(env, count, options, argv[3]);
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

    auto options = iterator->DefaultNextvOptions();
    NAPI_STATUS_THROWS(GetIteratorNextvOptions(env, argv[2], options));

    return iterator->nextv(env, count, options, argv[3], PackedMode::Packed);
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(iterator_nextv_auto) {
  NAPI_ARGV(4);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    uint32_t count = 1024;
    NAPI_STATUS_THROWS(GetValue(env, argv[1], count));

    auto options = iterator->DefaultNextvOptions();
    NAPI_STATUS_THROWS(GetIteratorNextvOptions(env, argv[2], options));

    return iterator->nextv(env, count, options, argv[3], PackedMode::Auto);
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

    auto options = iterator->DefaultNextvOptions();
    NAPI_STATUS_THROWS(GetIteratorNextvOptions(env, argv[2], options));

    return iterator->nextv(env, count, options);
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(iterator_nextv_packed_sync) {
  NAPI_ARGV(3);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    uint32_t count = 1024;
    NAPI_STATUS_THROWS(GetValue(env, argv[1], count));

    auto options = iterator->DefaultNextvOptions();
    NAPI_STATUS_THROWS(GetIteratorNextvOptions(env, argv[2], options));

    return iterator->nextv(env, count, options, PackedMode::Packed);
  } catch (const std::exception& e) {
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}

NAPI_METHOD(iterator_nextv_auto_sync) {
  NAPI_ARGV(3);

  try {
    std::shared_ptr<Iterator> iterator;
    NAPI_STATUS_THROWS(GetResourceExternal(env, argv[0], kIteratorReferenceTag, iterator));

    uint32_t count = 1024;
    NAPI_STATUS_THROWS(GetValue(env, argv[1], count));

    auto options = iterator->DefaultNextvOptions();
    NAPI_STATUS_THROWS(GetIteratorNextvOptions(env, argv[2], options));

    return iterator->nextv(env, count, options, PackedMode::Auto);
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

template <BatchAppendInputType InputType>
static napi_value BatchAppendMany(napi_env env, napi_callback_info info) {
  NAPI_ARGV(3);

  std::shared_ptr<NativeBatch> batch;
  NAPI_STATUS_THROWS(GetBatch(env, argv[0], batch));
  Database* database = batch->reference->database.get();
  std::shared_ptr<DatabaseOperation> databaseOperation;
  NAPI_STATUS_THROWS(BeginDatabaseOperation(env, database, batch->reference, databaseOperation));
  NAPI_STATUS_THROWS(ValidateBatch(env, batch, batch->reference));

  bool isArray = false;
  NAPI_STATUS_THROWS(napi_is_array(env, argv[1], &isArray));
  if (!isArray) {
    napi_throw_type_error(env, nullptr, "Batch entries must be an array");
    return nullptr;
  }

  uint32_t length = 0;
  NAPI_STATUS_THROWS(napi_get_array_length(env, argv[1], &length));
  if ((length & 1U) != 0) {
    napi_throw_range_error(env, nullptr, "Batch entries must contain alternating key/value pairs");
    return nullptr;
  }

  std::vector<BatchAppendEntry> entries;
  entries.resize(length / 2);
  for (uint32_t index = 0; index < length; index += 2) {
    auto& entry = entries[index / 2];

    napi_value keyValue;
    NAPI_STATUS_THROWS(napi_get_element(env, argv[1], index, &keyValue));

    NAPI_STATUS_THROWS(GetOwnedBatchAppendValue<InputType>(env, keyValue, entry.key));

    napi_value valueValue;
    NAPI_STATUS_THROWS(napi_get_element(env, argv[1], index + 1, &valueValue));
    napi_valuetype valueType;
    NAPI_STATUS_THROWS(napi_typeof(env, valueValue, &valueType));
    if (valueType != napi_null) {
      entry.value.emplace();
      NAPI_STATUS_THROWS(GetOwnedBatchAppendValue<InputType>(env, valueValue, *entry.value));
    }
  }

  rocksdb::ColumnFamilyHandle* column = nullptr;
  NAPI_STATUS_THROWS(GetColumnProperty(env, argv[2], database, column, false));

  std::lock_guard lock(batch->mutex);
  const auto count = batch->batch.Count();
  if (entries.size() > std::numeric_limits<uint32_t>::max() - count) {
    napi_throw_range_error(env, "LEVEL_BATCH_TOO_LARGE", "Batch operation count exceeds the RocksDB limit");
    return nullptr;
  }

  BatchSavePoint savePoint(batch->batch);
  for (size_t index = 0; index < entries.size(); ++index) {
    const auto& entry = entries[index];
    const rocksdb::Slice key(entry.key);
    rocksdb::Status status;
    if (entry.value) {
      const rocksdb::Slice value(*entry.value);
      status = column ? batch->batch.Put(column, key, value) : batch->batch.Put(key, value);
    } else {
      status = column ? batch->batch.Delete(column, key) : batch->batch.Delete(key);
    }
    if (!status.ok()) {
      const auto rollbackStatus = savePoint.Rollback();
      ROCKS_STATUS_THROWS_NAPI(rollbackStatus.ok() ? status : rollbackStatus);
    }

#if defined(ROCKS_LEVEL_TEST_FAULTS)
    if (index == 0 && gFailBatchAppendManyAfterFirstOperation.exchange(false, std::memory_order_relaxed)) {
      throw std::runtime_error("Injected batch append-many failure");
    }
#endif
  }

  ROCKS_STATUS_THROWS_NAPI(savePoint.Commit());
  return nullptr;
}

NAPI_METHOD(batch_append_many) {
  return BatchAppendMany<BatchAppendInputType::Any>(env, info);
}

NAPI_METHOD(batch_append_many_buffer) {
  return BatchAppendMany<BatchAppendInputType::Buffer>(env, info);
}

NAPI_METHOD(batch_append_many_string) {
  return BatchAppendMany<BatchAppendInputType::String>(env, info);
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

  bool disableWAL = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "disableWAL", disableWAL));

  auto callback = argv[3];

  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownBatchWrite, resourceName));

  NAPI_STATUS_THROWS(runAsyncKeepAlive(resourceName, env, callback, argv[0], [=](auto& state) {
    const DatabaseOperationScope operationScope(databaseOperation);
    std::lock_guard lock(batch->mutex);
    rocksdb::WriteOptions writeOptions;
    writeOptions.sync = sync;
    writeOptions.low_pri = lowPriority;
    writeOptions.disableWAL = disableWAL;
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

  bool disableWAL = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "disableWAL", disableWAL));

  rocksdb::WriteOptions writeOptions;
  writeOptions.sync = sync;
  writeOptions.low_pri = lowPriority;
  writeOptions.disableWAL = disableWAL;
  std::lock_guard lock(batch->mutex);
  ROCKS_STATUS_THROWS_NAPI(database->db->Write(writeOptions, &batch->batch));

  return 0;
}

class ScopedPerfContext {
 public:
  ScopedPerfContext()
      : context_(rocksdb::get_perf_context()),
        previousLevel_(rocksdb::GetPerfLevel()),
        previousContext_(*context_) {
    context_->Reset();
    rocksdb::SetPerfLevel(rocksdb::PerfLevel::kEnableTimeExceptForMutex);
  }

  ~ScopedPerfContext() {
    rocksdb::SetPerfLevel(previousLevel_);
    *context_ = previousContext_;
  }

  rocksdb::PerfContext Snapshot() const { return *context_; }

 private:
  rocksdb::PerfContext* context_;
  rocksdb::PerfLevel previousLevel_;
  rocksdb::PerfContext previousContext_;
};

static napi_status SetWritePerfContextValue(napi_env env, napi_value result, const char* name, uint64_t value) {
  napi_value converted;
  NAPI_STATUS_RETURN(napi_create_double(env, static_cast<double>(value), &converted));
  return napi_set_named_property(env, result, name, converted);
}

static napi_status ConvertWritePerfContext(napi_env env, const rocksdb::PerfContext& context, napi_value* result) {
  NAPI_STATUS_RETURN(napi_create_object(env, result));
  NAPI_STATUS_RETURN(SetWritePerfContextValue(env, *result, "writeWalNanos", context.write_wal_time));
  NAPI_STATUS_RETURN(SetWritePerfContextValue(env, *result, "writeMemtableNanos", context.write_memtable_time));
  NAPI_STATUS_RETURN(SetWritePerfContextValue(env, *result, "writeDelayNanos", context.write_delay_time));
  NAPI_STATUS_RETURN(SetWritePerfContextValue(env, *result, "writeSchedulingFlushesCompactionsNanos",
                                               context.write_scheduling_flushes_compactions_time));
  NAPI_STATUS_RETURN(SetWritePerfContextValue(env, *result, "writePreAndPostProcessNanos",
                                               context.write_pre_and_post_process_time));
  return SetWritePerfContextValue(env, *result, "writeThreadWaitNanos", context.write_thread_wait_nanos);
}

NAPI_METHOD(batch_write_sync_profile) {
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

  bool disableWAL = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "disableWAL", disableWAL));

  rocksdb::WriteOptions writeOptions;
  writeOptions.sync = sync;
  writeOptions.low_pri = lowPriority;
  writeOptions.disableWAL = disableWAL;

  rocksdb::Status status;
  rocksdb::PerfContext context;
  {
    std::lock_guard lock(batch->mutex);
    ScopedPerfContext scope;
    status = database->db->Write(writeOptions, &batch->batch);
    context = scope.Snapshot();
  }
  ROCKS_STATUS_THROWS_NAPI(status);

  napi_value result;
  NAPI_STATUS_THROWS(ConvertWritePerfContext(env, context, &result));
  return result;
}

NAPI_METHOD(batch_write_profile) {
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

  bool disableWAL = false;
  NAPI_STATUS_THROWS(GetProperty(env, argv[2], "disableWAL", disableWAL));

  const auto callback = argv[3];
  napi_value resourceName;
  NAPI_STATUS_THROWS(GetResourceName(env, ResourceLeveldownBatchWrite, resourceName));

  NAPI_STATUS_THROWS(runAsyncKeepAlive<rocksdb::PerfContext>(
      resourceName, env, callback, argv[0],
      [database, databaseOperation, batch, sync, lowPriority, disableWAL](auto& context) {
        const DatabaseOperationScope operationScope(databaseOperation);
        rocksdb::WriteOptions writeOptions;
        writeOptions.sync = sync;
        writeOptions.low_pri = lowPriority;
        writeOptions.disableWAL = disableWAL;

        rocksdb::Status status;
        {
          std::lock_guard lock(batch->mutex);
          ScopedPerfContext scope;
          status = database->db->Write(writeOptions, &batch->batch);
          context = scope.Snapshot();
        }
        return status;
      },
      [](auto& context, napi_env env, napi_value* result) {
        return ConvertWritePerfContext(env, context, result);
      }));

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

  BatchIterator iterator(database, keys, values, data, column, keyEncoding, valueEncoding);

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
      : BatchIterator(database, keys, values, data, column, keyEncoding, valueEncoding),
        database_(database),
        reference_(std::move(reference)),
        databaseContext_(std::move(databaseContext)),
        start_(since) {
    const auto status = database_->Attach(reference_, this);
    if (!status.ok()) {
      throw std::runtime_error(status.ToString());
    }
  }

  ~Updates() noexcept override {
    if (!closed.load()) {
      database_->DetachOnDestroy(reference_, this);
    }
  }

  rocksdb::Status Close() { return database_->Close(reference_, this); }

  rocksdb::Status CloseResources() override {
    if (InjectUpdatesCloseExceptionForTest()) {
      throw std::runtime_error("Injected updates resource close exception");
    }
    std::lock_guard operationLock(operationMutex_);
    closed = true;
    iterator_.reset();
    return rocksdb::Status::OK();
  }

  void AbandonResources() noexcept override {
    closed = true;
    try {
      iterator_.reset();
    } catch (...) {
    }
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
          napi_value nextSequence;

          NAPI_STATUS_RETURN(updates->Iterate(env, *state.batchResult.writeBatchPtr, &rows));
          NAPI_STATUS_RETURN(napi_create_int64(env, state.batchResult.sequence, &sequence));
          NAPI_STATUS_RETURN(napi_create_int64(
              env, state.batchResult.sequence + state.batchResult.writeBatchPtr->Count(),
              &nextSequence));

          NAPI_STATUS_RETURN(napi_create_object(env, result));
          NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "rows", rows));
          NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "seq", sequence));
          NAPI_STATUS_RETURN(napi_set_named_property(env, *result, "nextSeq", nextSequence));
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

  auto statistics = rocksdb::CreateDBStatistics();
  statistics->set_stats_level(enabled ? rocksdb::StatsLevel::kExceptHistogramOrTimers
                                      : rocksdb::StatsLevel::kExceptTickers);

  napi_value result;
  // CreateResourceExternal holds the shared_ptr in a unique_ptr until N-API
  // accepts the finalizer, then transfers ownership to the external before
  // type tagging. This covers both failure points without leaking or risking a
  // double delete if the already-created external becomes unreachable.
  NAPI_STATUS_THROWS(CreateResourceExternal(env, statistics, kStatisticsTypeTag, result));

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

static constexpr int64_t kAsyncIoSupported = int64_t{1} << rocksdb::FSSupportedOps::kAsyncIO;

#if defined(ROCKS_LEVEL_TEST_FAULTS)
static int64_t OverrideIoUringSupportedOpsForTest(int64_t supportedOps) {
  const auto* const value = std::getenv("ROCKS_LEVEL_TEST_IO_URING_SUPPORTED_OPS");
  if (value == nullptr) return supportedOps;

  // Exercise the real public method with both outcomes without depending on
  // the host kernel. This branch and environment variable do not exist in
  // production builds.
  if (value[0] == '0' && value[1] == '\0') return 0;
  if (value[0] == '1' && value[1] == '\0') return kAsyncIoSupported;
  return supportedOps;
}
#endif

// Query the same FileSystem capability that RocksDB uses to decide whether to
// issue async reads. It incorporates the compiled path, the application opt-in
// hook and RocksDB's runtime probe with the exact queue depth and flags.
NAPI_METHOD(io_uring_available) {
#if defined(__linux__)
  int64_t supportedOps = 0;
  rocksdb::FileSystem::Default()->SupportedOps(supportedOps);

#if defined(ROCKS_LEVEL_TEST_FAULTS)
  supportedOps = OverrideIoUringSupportedOpsForTest(supportedOps);
#endif

  napi_value result;
  NAPI_STATUS_THROWS(napi_get_boolean(env, (supportedOps & kAsyncIoSupported) != 0, &result));

  return result;
#else
  // Not applicable on this platform.
  napi_value result;
  NAPI_STATUS_THROWS(napi_get_null(env, &result));

  return result;
#endif
}

#if defined(ROCKS_LEVEL_TEST_FAULTS)
// These hooks exist only in an explicit ROCKS_LEVEL_TEST_FAULTS build. They
// exercise the exported-method boundary and the real libuv completion callback
// without adding a test branch or atomic load to production paths.
NAPI_METHOD(test_method_exception) {
  NAPI_ARGV(2);

  std::string fault;
  NAPI_STATUS_THROWS(GetValue(env, argv[0], fault));

  if (fault == "std") {
    throw std::runtime_error("Injected native method exception");
  }
  if (fault == "unknown") {
    throw 42;
  }
  if (fault == "pending") {
    napi_value global;
    NAPI_STATUS_THROWS(napi_get_global(env, &global));
    // Deliberately leave the callback's exception pending, then unwind through
    // C++ to prove the outer boundary does not replace a more precise JS error.
    napi_call_function(env, global, argv[1], 0, nullptr, nullptr);
    throw std::runtime_error("Must not replace the pending JavaScript exception");
  }

  napi_throw_type_error(env, nullptr, "Unknown native method test fault");
  return nullptr;
}

NAPI_METHOD(test_complete_exception) {
  NAPI_ARGV(2);

  std::string fault;
  NAPI_STATUS_THROWS(GetValue(env, argv[0], fault));

  napi_value resourceName;
  NAPI_STATUS_THROWS(
      napi_create_string_utf8(env, "rocks-level.test_complete_exception", NAPI_AUTO_LENGTH, &resourceName));

  try {
    auto executeFault = fault;
    NAPI_STATUS_THROWS(runAsync<std::nullptr_t>(
        resourceName, env, argv[1],
        [fault = std::move(executeFault)](auto&) {
          if (fault == "execute-std") {
            throw std::runtime_error("Injected native execution exception");
          }
          if (fault == "execute-unknown") {
            throw 42;
          }
          return rocksdb::Status::OK();
        },
        [fault = std::move(fault)](auto&, napi_env env, napi_value* result) -> napi_status {
          if (fault == "std") {
            throw std::runtime_error("Injected native completion exception");
          }
          if (fault == "unknown") {
            throw 42;
          }
          if (fault == "status") {
            NAPI_STATUS_RETURN(napi_create_string_utf8(env, "partial", NAPI_AUTO_LENGTH, result));
            return napi_invalid_arg;
          }
          return napi_create_string_utf8(env, "ok", NAPI_AUTO_LENGTH, result);
        }));
  } catch (const std::exception& exception) {
    napi_throw_error(env, "LEVEL_NATIVE_EXCEPTION", exception.what());
    return nullptr;
  } catch (...) {
    napi_throw_error(env, "LEVEL_NATIVE_EXCEPTION", "Unknown native exception while scheduling test work");
    return nullptr;
  }

  return nullptr;
}

NAPI_METHOD(test_fail_batch_iterator_once) {
  gFailBatchIteratorAfterFirstRow.store(true, std::memory_order_relaxed);
  return nullptr;
}

NAPI_METHOD(test_fail_batch_append_many_once) {
  gFailBatchAppendManyAfterFirstOperation.store(true, std::memory_order_relaxed);
  return nullptr;
}
#endif

NAPI_INIT() {
  NAPI_EXPORT_FUNCTION(db_init);
  NAPI_EXPORT_FUNCTION(db_open);
  NAPI_EXPORT_FUNCTION(db_get_identity);
  NAPI_EXPORT_FUNCTION(db_get_handle);
  NAPI_EXPORT_FUNCTION(db_get_location);
  NAPI_EXPORT_FUNCTION(db_is_closed);
#if defined(ROCKS_LEVEL_TEST_FAULTS)
  NAPI_EXPORT_FUNCTION(test_faults_enabled);
#endif
  NAPI_EXPORT_FUNCTION(db_close);
  NAPI_EXPORT_FUNCTION(db_dispose);
  NAPI_EXPORT_FUNCTION(db_cleanup_failed_open);
  NAPI_EXPORT_FUNCTION(db_get_many);
  NAPI_EXPORT_FUNCTION(db_get_many_packed);
  NAPI_EXPORT_FUNCTION(db_get_many_auto);
  NAPI_EXPORT_FUNCTION(db_get_many_sync);
  NAPI_EXPORT_FUNCTION(db_get_many_packed_sync);
  NAPI_EXPORT_FUNCTION(db_get_many_auto_sync);
  NAPI_EXPORT_FUNCTION(db_clear);
  NAPI_EXPORT_FUNCTION(db_get_property);
  NAPI_EXPORT_FUNCTION(db_get_properties);
  NAPI_EXPORT_FUNCTION(db_set_stats_level);
  NAPI_EXPORT_FUNCTION(db_get_statistics);
  NAPI_EXPORT_FUNCTION(db_get_latest_sequence);
  NAPI_EXPORT_FUNCTION(db_query);
  NAPI_EXPORT_FUNCTION(db_query_sync);
  NAPI_EXPORT_FUNCTION(db_compact_range_sync);
  NAPI_EXPORT_FUNCTION(db_compact_range);
  NAPI_EXPORT_FUNCTION(db_flush_wal);
  NAPI_EXPORT_FUNCTION(db_flush);

  NAPI_EXPORT_FUNCTION(statistics_init);
  NAPI_EXPORT_FUNCTION(statistics_set_stats_level);
  NAPI_EXPORT_FUNCTION(statistics_get_statistics);

  NAPI_EXPORT_FUNCTION(iterator_init);
  NAPI_EXPORT_FUNCTION(iterator_init_nextv);
  NAPI_EXPORT_FUNCTION(iterator_is_initialized);
  NAPI_EXPORT_FUNCTION(iterator_create);
  NAPI_EXPORT_FUNCTION(iterator_init_sync);
  NAPI_EXPORT_FUNCTION(iterator_refresh_sync);
  NAPI_EXPORT_FUNCTION(iterator_seek);
  NAPI_EXPORT_FUNCTION(iterator_seek_sync);
  NAPI_EXPORT_FUNCTION(iterator_close_sync);
  NAPI_EXPORT_FUNCTION(iterator_nextv);
  NAPI_EXPORT_FUNCTION(iterator_nextv_packed);
  NAPI_EXPORT_FUNCTION(iterator_nextv_auto);
  NAPI_EXPORT_FUNCTION(iterator_nextv_sync);
  NAPI_EXPORT_FUNCTION(iterator_nextv_packed_sync);
  NAPI_EXPORT_FUNCTION(iterator_nextv_auto_sync);

  NAPI_EXPORT_FUNCTION(updates_init);
  NAPI_EXPORT_FUNCTION(updates_close);
  NAPI_EXPORT_FUNCTION(updates_next);

  NAPI_EXPORT_FUNCTION(batch_init);
  NAPI_EXPORT_FUNCTION(batch_put);
  NAPI_EXPORT_FUNCTION(batch_put_parts);
  NAPI_EXPORT_FUNCTION(batch_put_log_data);
  NAPI_EXPORT_FUNCTION(batch_del);
  NAPI_EXPORT_FUNCTION(batch_append_many);
  NAPI_EXPORT_FUNCTION(batch_append_many_buffer);
  NAPI_EXPORT_FUNCTION(batch_append_many_string);
  NAPI_EXPORT_FUNCTION(batch_clear);
  NAPI_EXPORT_FUNCTION(batch_write);
  NAPI_EXPORT_FUNCTION(batch_write_sync);
  NAPI_EXPORT_FUNCTION(batch_write_sync_profile);
  NAPI_EXPORT_FUNCTION(batch_write_profile);
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

#if defined(ROCKS_LEVEL_TEST_FAULTS)
  NAPI_EXPORT_FUNCTION(test_method_exception);
  NAPI_EXPORT_FUNCTION(test_complete_exception);
  NAPI_EXPORT_FUNCTION(test_fail_batch_iterator_once);
  NAPI_EXPORT_FUNCTION(test_fail_batch_append_many_once);
#endif
}
