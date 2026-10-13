/** A rate limit (429) or a server error (5xx) is transient: the same request can succeed a moment later. */
export const transientStatus = status => status === 429 || (Number.isInteger(status) && status >= 500 && status < 600);

/**
 * The transient class of an error, or null: rate_limit (HTTP 429), server_error (HTTP 5xx), unavailable (the service
 * said so), or timeout. Retry notices name this class.
 * @param {any} error
 * @returns {'rate_limit' | 'server_error' | 'unavailable' | 'timeout' | null}
 */
export function transientClass(error) {
  if (error?.status === 429) return 'rate_limit';
  if (transientStatus(error?.status)) return 'server_error';
  if (error?.code === 'classification_unavailable') return 'unavailable';
  if (error?.code === 'classification_timeout' || error?.name === 'TimeoutError') return 'timeout';
  return null;
}

// A service that is briefly unavailable gets three attempts in all, with a growing wait. A rejected request is not retried.
export const attempts = 3;

/**
 * Run one provider request, and run it again after a transient failure. Model calls and classification share this policy.
 * `transient` says which errors to retry; `canRetry` says whether the run still allows another request.
 * `beforeRetry(error, attempt)` runs after the wait and before the next attempt; `attempt` is the number of that next
 * attempt (2 or 3 of `attempts`).
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ transient: (error: any) => boolean, signal?: AbortSignal, canRetry?: () => boolean, beforeRetry?: (error: any, attempt: number) => unknown }} options
 * @returns {Promise<T>}
 */
export async function withRetries(operation, { transient, signal, canRetry = () => true, beforeRetry = () => {} }) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= attempts || signal?.aborted || !transient(error) || !canRetry()) {
        // A transient error that is still there after the retries is a failure of the outside service.
        if (transient(error) && !signal?.aborted) Object.assign(error, { owner: 'outside_service', attempts: attempt });
        throw error;
      }
      // The wait ends early when the run is cancelled or reaches its deadline; beforeRetry then reports it.
      await new Promise(resolve => {
        const timer = setTimeout(done, 1000 * attempt * (1 + Math.random() / 4));
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
      });
      await beforeRetry(error, attempt + 1);
    }
  }
}
