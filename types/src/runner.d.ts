/**
 * @param {string} file
 * @param {import('./api-types.js').RuntimeConfig} config
 * @param {import('./api-types.js').RunOptions} [options]
 * @returns {Promise<import('./api-types.js').RunResult>}
 */
export function runMethod(file: string, config: import("./api-types.js").RuntimeConfig, options?: import("./api-types.js").RunOptions): Promise<import("./api-types.js").RunResult>;
/** One sentence that says what to do next for a failure code. */
export function fixFor(error: any): any;
