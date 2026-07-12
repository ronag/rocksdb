export async function cleanupAfterBenchmark (failed, tasks) {
  const errors = []

  for (const task of tasks) {
    try {
      await task()
    } catch (err) {
      errors.push(err)
    }
  }

  if (errors.length === 0) return

  const cleanupError = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, 'Benchmark cleanup failed')

  if (failed) {
    console.error('Benchmark cleanup also failed:', cleanupError)
  } else {
    throw cleanupError
  }
}
