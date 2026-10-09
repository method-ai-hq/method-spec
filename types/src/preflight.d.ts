/** Check local dependencies without executing a script or model. Shared by validate and run. */
export function preflight(method: any, config: any, sourceRoot: any, options?: {}): Promise<{
    scripts: any[];
    runtimeInfo: {};
    files: any[];
    missingSetup: any[];
}>;
