/** A rate limit (429) or a server error (5xx) is transient: the same request can succeed a moment later. */
export const transientStatus = status => status === 429 || (Number.isInteger(status) && status >= 500 && status < 600);

// A service that is briefly unavailable gets three attempts in all, with a growing wait. A rejected request is not retried.
export const attempts = 3;

/**
 * Run one provider request, and run it again after a transient failure. Model calls and classification share this policy.
 * `transient` says which errors to retry; `canRetry` says whether the run still allows another request.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ transient: (error: any) => boolean, signal?: AbortSignal, canRetry?: () => boolean, beforeRetry?: () => void }} options
 * @returns {Promise<T>}
 */
export async function withRetries(operation, { transient, signal, canRetry = () => true, beforeRetry = () => {} }) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= attempts || signal?.aborted || !transient(error) || !canRetry()) throw error;
      // The wait ends early when the run is cancelled or reaches its deadline; beforeRetry then reports it.
      await new Promise(resolve => {
        const timer = setTimeout(done, 1000 * attempt * (1 + Math.random() / 4));
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
      });
      beforeRetry();
    }
  }
}
