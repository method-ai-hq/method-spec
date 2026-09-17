# Published Method 2 baseline

Status: existing format distributed in Method SDK 0.3.0. See [provenance](PROVENANCE.md).

A document uses `format: method/2`, a name, a goal, a map of steps, and a result reference. The SDK also accepts the legacy identifier `workflow/2`. Optional root fields declare inputs, environment connections, and saved state.

Data uses six types: text, number, boolean, record, list, and file. Fields and items describe nested shapes. Named references connect inputs, outputs, and state.

A step has either `do`, containing agent instructions, or `ask`, requesting human input. Step fields also include:

- `in` and `out`: named input bindings and typed output declarations.
- `check`: agent instructions or an exact equals, count, present, or file check.
- `each`: repeat the step for each collection item.
- `when`: a boolean condition.
- `after`: an explicit ordering dependency.
- `changes`: declared state or environment changes.

The existing runtime launches fresh Codex processes for agent actions and agent checks. Exact checks run directly. A check is optional; its absence is not proof of success. Type validation and task verification are separate.

The published baseline therefore contains more than two prompts. Its central agent execution pattern is a worker prompt followed, when requested, by a separate checker prompt. Typed data, state, iteration, dependencies, and exact checks are prior work.

The [JSON Schema](../../spec/method-2.schema.json) gives the exported grammar. The [source schema](../../vendor/method-sdk-0.3.0/schema.ts) preserves the published source. Runtime semantics and additional semantic validation are not fully encoded in JSON Schema.

The public SDK provides the full guide through `method authoring all` and the grammar through `method schema`. The next-version proposal does not alter this baseline or imply support in SDK 0.3.0.
