/** Each file value in the step's input. types are the declared types of the step's in and each names. */
export function modelFiles(input: any, types: any, artifacts: any): Promise<any[]>;
/** For Claude Code and Codex, which open files themselves: where each file is, so the input's relative paths resolve. */
export function fileList(files: any): string;
