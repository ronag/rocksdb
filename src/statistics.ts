import binding = require('./binding')

const kStatisticsContext = Symbol('statisticsContext')

// A cumulative ticker collector that can be attached to any number of DBs.
// Collection starts disabled by default, toggling never resets counts, and
// snapshots use Numbers (counts above Number.MAX_SAFE_INTEGER lose precision).
class RocksStatistics {
  constructor(options: unknown = {}) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new TypeError("The 'options' argument must be an object")
    }

    const enabledOption = (options as { enabled?: unknown }).enabled
    const enabled = enabledOption === undefined ? false : enabledOption
    if (typeof enabled !== 'boolean') {
      throw new TypeError("The 'enabled' option must be a boolean")
    }

    this[kStatisticsContext] = binding.statistics_init({ enabled })
  }

  setStatisticsEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError("The 'enabled' argument must be a boolean")
    }

    return binding.statistics_set_stats_level(this[kStatisticsContext], enabled)
  }

  getStatistics() {
    return binding.statistics_get_statistics(this[kStatisticsContext])
  }
}

function getStatisticsContext(statistics) {
  const context = statistics[kStatisticsContext]
  if (context === undefined) {
    throw new TypeError('Invalid RocksStatistics resource')
  }

  return context
}

export { RocksStatistics, getStatisticsContext }
