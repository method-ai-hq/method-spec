export function readDocument(file: any): Promise<any>;
export function relativeFile(path: any): any;
export function containedFile(root: any, file: any): Promise<string>;
export function snapshotBundle(root: any, paths: any, destination: any): Promise<{}>;
export function writeJSON(file: any, data: any): Promise<void>;
export function executable(command: any): Promise<string>;
export function readLines(stream: any, receive: any, maxBytes?: number): Promise<void>;
/** @param {{command: string, args: string[], cwd: string, input: any, env: NodeJS.ProcessEnv, signal: AbortSignal, maxBytes: number, rawInput?: boolean, onStdoutLine?: (line: string) => Promise<unknown>, onProgress?: (value: any) => Promise<unknown>}} options */
export function executeProcess({ command, args, cwd, input, env, signal, maxBytes, rawInput, onStdoutLine, onProgress }: {
    command: string;
    args: string[];
    cwd: string;
    input: any;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    maxBytes: number;
    rawInput?: boolean;
    onStdoutLine?: (line: string) => Promise<unknown>;
    onProgress?: (value: any) => Promise<unknown>;
}): Promise<any>;
export function hash(value: any): string;
