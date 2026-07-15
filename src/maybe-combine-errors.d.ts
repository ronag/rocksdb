declare module 'maybe-combine-errors' {
  function combineErrors (errors: readonly unknown[]): Error | undefined
  export = combineErrors
}
