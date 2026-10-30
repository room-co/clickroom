export type DogfoodSeedMode = 'fixed' | 'generate'

/**
 * The `fixed` mode writes a write key whose plaintext is committed to the repo, so it must
 * never run against a production database. Fails closed when `NODE_ENV=production`.
 */
export function assertFixedModeAllowed(
  mode: DogfoodSeedMode,
  env: Record<string, string | undefined> = process.env,
): void {
  if (mode === 'fixed' && env.NODE_ENV === 'production') {
    throw new Error(
      "Refusing to seed the dogfood org in 'fixed' mode with NODE_ENV=production: the fixed write key is public. Run with DOGFOOD_MODE=generate instead.",
    )
  }
}
