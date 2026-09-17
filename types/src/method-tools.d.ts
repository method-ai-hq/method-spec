export function startMethodTools(execution: any, context: any): Promise<{
    url: string;
    token: `${string}-${string}-${string}-${string}-${string}`;
    close(): Promise<void>;
}>;
