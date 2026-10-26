export function boundedJSON(response: any, maxBytes: any): Promise<any>;
/** One model step attempt. Its conversation is kept as transcript.jsonl in its own folder under the run's artifacts. */
export function executeModel(execution: any, input: any, schema: any, context: any): Promise<any>;
export const directBackends: string[];
