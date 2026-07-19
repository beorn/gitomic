export class Conflict extends Error {
  override readonly name = "Conflict"
}

export class RetriesExhausted extends Error {
  override readonly name = "RetriesExhausted"

  constructor(
    readonly retries: number,
    options?: ErrorOptions,
  ) {
    super(`transaction did not land after ${retries} CAS attempts; retry later or reduce writer contention`, options)
  }
}
