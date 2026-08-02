/**
 * Runtime generation is opt-in because unbounded fallback routes can turn
 * crawler traffic into Vercel Function invocations and ISR writes.
 */
export function isRuntimeIsrEnabled() {
  return process.env.NEXT_PUBLIC_ENABLE_RUNTIME_ISR === 'true'
}

export function getRuntimeFallback() {
  return isRuntimeIsrEnabled() ? 'blocking' : false
}
