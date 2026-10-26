/** Claude Code's stream-json output as a transcript. */
export function claudeTranscript(prompt: any, output: any): any;
/**
 * The files that a shell command reads, as a guess: the file operands of cat, head, tail, nl, less, more, sed -n and
 * wc in each part of the command. A pipe's input or a quoted pattern is not a file.
 */
export function shellReads(command: any): any[];
/**
 * Codex's JSON event stream as a transcript. result: what Codex saved as its result, when it saved one, in the
 * attempt's file resultFile.
 */
export function codexTranscript(prompt: any, output: any, result: any, resultFile?: string): any;
/**
 * A model step's conversation as a transcript. turns: each provider reply as the adapter read it ({text, calls}), the
 * tool outputs that answered its calls, and the run event sequence of the reply.
 */
export function modelTranscript(prompt: any, turns: any): any;
/** Write an attempt's transcript.jsonl. clean: the redaction of a text that the attempt's other records get. */
export function writeTranscript(directory: any, entries: any, clean?: (value: any) => any): Promise<void>;
