import { z } from "zod";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(JsonSchema), z.record(JsonSchema)]));
export const NameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80).refine(name => !["constructor", "prototype", "__proto__"].includes(name), "Reserved name.");
export const ReferenceSchema = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*|\.[0-9]+)*$/);
const Text = z.string().trim().min(1).max(16000);
export const TypeSchema = z.enum(["text", "number", "boolean", "record", "list", "file"]);
export type ValueType = z.infer<typeof TypeSchema>;
export type Shape = ValueType | { type: ValueType; description?: string | undefined; fields?: Record<string, Shape> | undefined; items?: Shape | undefined; format?: string | undefined };
export const ShapeSchema: z.ZodType<Shape> = z.lazy(() => z.union([TypeSchema, z.strictObject({ type: TypeSchema, description: Text.optional(), fields: z.record(NameSchema, ShapeSchema).optional(), items: ShapeSchema.optional(), format: Text.optional() })]));
export const DataSchema = z.strictObject({ type: TypeSchema, description: Text, fields: z.record(NameSchema, ShapeSchema).optional(), items: ShapeSchema.optional(), format: Text.optional() });
export const InputSchema = DataSchema.extend({ default: JsonSchema.optional() });
export const StateSchema = InputSchema.extend({ file: z.string().min(1).max(500) });
export const EnvironmentSchema = z.strictObject({ type: z.enum(["browser", "service", "desktop", "files", "tool"]), description: Text });
export const CheckSchema = z.union([
  Text,
  z.strictObject({ equals: z.strictObject({ actual: ReferenceSchema, expected: ReferenceSchema }) }),
  z.strictObject({ count: z.strictObject({ value: ReferenceSchema, min: z.number().int().nonnegative().optional(), max: z.number().int().nonnegative().optional() }) }),
  z.strictObject({ present: ReferenceSchema }),
  z.strictObject({ file: ReferenceSchema }),
]);
export const StepSchema = z.strictObject({
  name: Text.optional(), in: z.record(NameSchema, ReferenceSchema).optional(), do: Text.optional(), ask: Text.optional(),
  out: z.record(NameSchema, DataSchema).optional(), check: CheckSchema.optional(),
  each: z.record(NameSchema, ReferenceSchema).optional(), when: ReferenceSchema.optional(),
  after: z.union([NameSchema, z.array(NameSchema)]).optional(), changes: z.array(ReferenceSchema).optional(),
});
export const WorkflowSchema = z.strictObject({
  format: z.enum(["method/2", "workflow/2"]), name: Text, goal: Text,
  inputs: z.record(NameSchema, InputSchema).optional(), environment: z.record(NameSchema, EnvironmentSchema).optional(),
  state: z.record(NameSchema, StateSchema).optional(), steps: z.record(NameSchema, StepSchema),
  result: z.union([ReferenceSchema, z.record(NameSchema, ReferenceSchema)]),
});
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Check = z.infer<typeof CheckSchema>;
export type DataDefinition = z.infer<typeof DataSchema>;
export const FileArtifactSchema = z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) });

/** JSON Pointer remains a private editing/JSON utility, never a workflow binding. */
export function pointer(value: Json | undefined, path: string): Json | undefined {
  if (path === "") return value;
  if (!/^(?:\/(?:[^~]|~[01])*)*$/.test(path)) throw Error("Invalid JSON Pointer.");
  let current = value;
  for (const segment of path.slice(1).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
    current = (current as Record<string, Json>)[key];
  }
  return current;
}
