export interface WaitForOptions {
  /** Total time to keep polling before giving up. Default 10_000. */
  timeoutMs?: number
  /** Delay between polls. Default 250. */
  intervalMs?: number
}

/**
 * Poll `predicate` until it resolves to a truthy value, returning that value.
 * Throws a clear timeout error (including how long it waited) if `predicate`
 * never returns truthy within `timeoutMs`.
 */
export async function waitFor<T>(
  predicate: () => Promise<T | null | false | undefined>,
  opts: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const intervalMs = opts.intervalMs ?? 250
  const start = Date.now()

  for (;;) {
    const result = await predicate()
    if (result) return result

    const elapsed = Date.now() - start
    if (elapsed >= timeoutMs) {
      throw new Error(
        `waitFor: condition not met after waiting ${elapsed}ms (timeout ${timeoutMs}ms)`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
