export function object(properties: any, required?: string[]): {
    type: string;
    properties: any;
    required: string[];
    additionalProperties: boolean;
};
export namespace methodSchema {
    namespace $defs {
        namespace shape {
            let anyOf: ({
                enum: string[];
            } | {
                type: string;
                properties: any;
                required: string[];
                additionalProperties: boolean;
            })[];
        }
        namespace data {
            export let type: string;
            export { properties };
            export { required };
            export let additionalProperties: boolean;
        }
        namespace input { }
        namespace execution {
            let oneOf: {
                type: string;
                properties: any;
                required: string[];
                additionalProperties: boolean;
            }[];
        }
        namespace check {
            let oneOf_1: {
                type: string;
                properties: any;
                required: string[];
                additionalProperties: boolean;
            }[];
            export { oneOf_1 as oneOf };
        }
        namespace step {
            let oneOf_2: {
                required: string[];
                not: {
                    required: string[];
                };
            }[];
            export { oneOf_2 as oneOf };
            export namespace not {
                let required: string[];
            }
        }
    }
    let $schema: string;
    let $id: string;
}
export namespace configSchema {
    let $schema_1: string;
    export { $schema_1 as $schema };
}
export namespace checkResultSchema { }
