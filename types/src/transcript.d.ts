/**
 * Claude Code's stream-json output as a transcript. started: when the prompt was sent; times: when each JSON event was
 * read (for events without a timestamp of their own). A subagent's entries name the Agent or Task call that made them.
 */
export function claudeTranscript(prompt: any, output: any, { started, times }?: {}): any;
/**
 * The files that a shell command reads, as a guess: the file operands of cat, head, tail, nl, less, more, sed -n and
 * wc in each part of the command. A pipe's input or a quoted pattern is not a file.
 */
export function shellReads(command: any): any[];
/**
 * Codex's JSON event stream as a transcript. result: what Codex saved as its result, when it saved one, in the
 * attempt's file resultFile. started and times as for claudeTranscript (Codex gives its events no time).
 */
export function codexTranscript(prompt: any, output: any, result: any, resultFile?: string, { started, times }?: {}): any;
/**
 * A model step's conversation as a transcript. turns: each provider reply as the adapter read it ({text, calls}), the
 * tool outputs that answered its calls, the run event sequence of the reply and when it was read (at). started: when
 * the prompt was sent.
 */
export function modelTranscript(prompt: any, turns: any, started: any): any;
/** Write an attempt's transcript.jsonl. clean: the redaction of a text that the attempt's other records get. */
export function writeTranscript(directory: any, entries: any, clean?: (value: any) => any): Promise<void>;
