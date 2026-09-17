# Method reference

Implemented by `@withmethod/runtime` 0.6.0. The full Method SDK uses this runtime at a pinned Git revision. New methods use this format under the same Method product and command.

Use `format: method/3.1`. The machine-readable grammar is [method-3.schema.json](method-3.schema.json). Operator configuration uses [runtime-config.schema.json](runtime-config.schema.json). The validator also checks references, dependencies, data declarations, loop conditions, and effects; JSON Schema alone is insufficient.

## Installation and commands

Node.js 22 or later is required. From this repository:

```sh
npm ci --ignore-scripts
npm run check
npm run example
```

Install the public SDK for the user command:

```sh
npm install -g https://app.withmethod.ai/downloads/withmethod-sdk-latest.tgz
method --version
method validate example.method --config runtime.json
method run example.method --config runtime.json --inputs inputs.json
method schema method
method schema config
```

The runtime package installs no command. Contributors can run `node src/cli.js` in this checkout. The contributor harness accepts `--agent codex|claude`; the SDK also supplies account commands, automatic setup, and background workers.

`validate` checks the Method and, when supplied, the configuration grammar. `run` additionally resolves profiles, tools, capabilities, environment bindings, and bundle files. A validation pass alone does not establish executable setup or task correctness.

`run` prints status, elapsed time, model request count, and the run directory. Read `result.json` in that directory for the result. Exit codes are 0 for completion, 1 for failure, and 2 for a human-input request. A new run needs a new directory. Use `--resume` to continue the same saved run.

## Document and data

Root fields are `format`, `name`, `goal`, `inputs`, `state`, `environment`, `files`, `steps`, `result`, and optional plain-text `run_prompt` for the outside agent. `run_prompt` does not expand variables. Step `reading` fields provide display text and do not change execution. Only format, name, goal, steps, and result are required.

Inputs and state declarations have a type and optional description and default. Supply missing initial values through `--inputs` and `--state`, each pointing to a JSON object. Unknown or wrongly typed values fail before any operation. State is saved as one atomic `state.json` checkpoint in the run directory. Method 3 does not use Method 2's per-state `file` field.

Types are `text`, `number`, `boolean`, `record`, `list`, and `file`. Records require `fields`. Lists require exactly one of `items` or `fields`; the latter describes each record in the list. Nested fields may use a short type name or a full shape. All declared fields are required and extra fields fail. Defaults must meet the declared type.

References such as `inputs.target`, `state.count`, and `decision.goal` connect data. `run.started_at` contains an ISO timestamp. Named step outputs must be unique across the Method. Reserved namespaces cannot be reused as output names. Data references determine execution order; `after` adds explicit dependencies. Cycles fail validation. Independent steps currently run sequentially.

The `environment` declarations describe connections. Operator configuration supplies a non-secret string for each connection, such as a local endpoint. Bind these values through `in` where needed. Credentials belong in environment variables, not in the Method or configuration data.

## Executable steps

Step `purpose` and `limits` are optional. Default step limits are ten minutes and 32 model requests or agent turns; explicit limits override these values. Use exactly one of `do` or `ask`. The three `do` forms are:

```yaml
do:
  kind: run
  runtime: node
  entrypoint: helpers/select.mjs
  args: []
```

```yaml
do:
  kind: call
  model: planner
  prompt: Select one goal from the supplied inputs and explain the choice.
```

```yaml
do:
  kind: agent
  model: planner
  prompt: Inspect the situation with the permitted tools, then return a decision.
  tools: [observe, act]
```

`in` maps local aliases to references. `out` declares output values. The process or model returns a JSON object whose keys match `out` exactly, plus the state replacements described below. Inputs are supplied as JSON data. In `method/3.1`, model and human prompts can insert declared scalar inputs with `{{name}}` or `{{customer.name}}`. Agent check prompts use `{{inputs.name}}` and `{{outputs.answer}}`. Only text, finite numbers, and booleans can be inserted. Unknown references fail validation; missing runtime values fail before model execution. Escape literal opening braces with a backslash in a YAML block scalar. Values are inserted once without expression evaluation or recursive expansion. Command arguments, labels, tool descriptions, and run_prompt are not templates.

### Scripts

Runtime profiles name an executable, optional fixed arguments, a declared version, and optional environment-variable names. Commands use argument arrays without shell expansion. Node, Python, or another JSON-speaking executable can be registered.

A script reads one JSON object on standard input, writes one JSON output object on standard output, and sends diagnostics to standard error. It runs from a saved copy of the bundle. Scripts receive PATH, LANG, METHOD_OUTPUT_DIR, METHOD_ENVIRONMENT (the configured connection map as JSON), explicitly named environment variables, and METHOD_PROGRESS_FD when a progress pipe is attached. Missing explicit variables fail. The executor hashes the resolved runtime binary and records the operator's declared version.

The operator must set `allow_local_processes: true`. These are trusted local processes, **not an OS sandbox**. They can access resources allowed to the operating-system user. A script can call a trained model or an external API, but those internal calls are not metered or restricted by the executor's model-request counter. Use managed `call`/`agent` steps for measured model use.

On timeout or process exit, the runner kills the process group on POSIX systems. The first release is tested on macOS and Linux. Windows process-tree termination and runtime compatibility are not claimed.

### Models and agents

Explicit model profiles take priority. Missing profiles use an explicit `--agent`, the configured default, the identified calling coding agent, or the sole installed supported agent. If both Codex and Claude are available without a choice, execution requests input. Both use their normal sign-in. The selected profiles remain fixed on resume. Codex starts a fresh process with approval and sandbox prompts disabled; it is trusted local execution. A supplied configuration must allow local processes. Without a config file, the CLI enables that default local path.

The temporary Method MCP bridge exposes only the step's declared Method tools. Codex also retains its built-in and installed tools. Empty `tools` does not mean that Codex has no tools. Both `call` and `agent` use a Codex process with a structured final output on this backend. Internal Codex model requests and tools are not governed by Method's direct API request/turn counters.

Method enforces the Codex process deadline, prompt/output size, and Method bridge tool-call cap. It saves prompts, output schema, JSON events, stderr, and reported usage. It does not edit persistent Codex settings or enforce a monetary budget.

#### Direct API backend

The optional direct provider is the [OpenAI Responses API](https://developers.openai.com/api/docs/guides/function-calling). Model profiles specify `backend: openai-responses`, the exact model identifier, `api_key_env`, a required `max_output_tokens`, and optional `reasoning_effort`. No model is silently substituted. Use a model supporting strict structured outputs; incompatible settings return a recorded provider error.

`call` sends one request with a strict JSON output schema and no tools. The runner validates the response locally. It does not issue repair calls or transport retries.

`agent` uses a fresh conversation and an explicit function-tool loop. The allowed tools are operator-configured scripts with typed inputs and outputs. The runner validates tool arguments, invokes the allowed script, validates its result, and sends the result back to the model. Reasoning items are retained between requests. Unknown tools, malformed arguments, refusal, or incomplete responses stop the operation.

Each agent tool has `effects: []` for an observation/pure operation, or a list of environment names it can change. Action tools with effects require corresponding step `changes`. Checker agents can only use tools with empty effects. This enforces which registered functions the model can call; the truth of a tool's effect declaration depends on its trusted implementation. The direct API backend does not add an arbitrary shell; the Codex backend has the separate access described above.

Computer-use support can be supplied through registered tools or the existing Codex setup. The runtime does not bundle a browser driver or a separate computer-use backend.

## State updates and checks

Declare state changes with `changes: [state.count]`. The output must then include a `state` object with complete replacement values for exactly those state names, alongside its ordinary outputs. This example returns one output and updates one state value:

```json
{"current": 3, "state": {"count": 3}}
```

The runner records candidate outputs, validates them, runs the requested check, and then replaces the state checkpoint. A failed or unknown check prevents that state commit. Already completed external actions remain possible; withholding a local state update does not undo them.

Exact checks retain their named-reference forms:

```yaml
check:
  equals: {actual: current, expected: target}
```

Other forms are `count: {value: items, min: 1, max: 10}`, `present: output_name`, and `file: artifact`. Count requires a list. Present checks that a referenced value exists and is non-null; it does not test truthiness or nonempty text.

Checks can also use `kind: run` or `kind: agent`. They receive:

```json
{"inputs": {}, "outputs": {}, "state_before": {}, "state_after": {}, "evidence": []}
```

They return exactly:

```json
{"status": "pass", "reason": "Explain the observed result.", "evidence": []}
```

Status is `pass`, `fail`, or `unknown`. Evidence entries are string references, not automatic proofs. The incoming evidence list is empty in this release; observations can be bound as data or obtained through a trusted read tool. Script checks run as trusted local code and are not isolated from the action's filesystem.

Output types are always checked. An omitted task check is recorded as `unchecked`, not `pass`. An external `changes: [environment.game]` declaration requires an explicit check in this release. A check of an action's completion does not establish that it was strategically useful.

## Loops and stopping

- `when` references a boolean. False skips the entire step. Skipped outputs do not exist; a consumer fails if it requests one.
- `each: {item: inputs.items}` runs sequentially, once per item. One collection alias is supported. Each output becomes a list in the original item order. An empty collection produces empty output lists.
- `repeat: {max_iterations: 5}` performs exactly five accepted invocations.
- `repeat: {max_iterations: 5, until: done}` checks a boolean step output after each accepted invocation. It stops when true. Reaching the limit without true fails the step. The last accepted state remains in the checkpoint.

Repeated inputs bound to state are refreshed each iteration. Other upstream values are fixed. Repeat returns the final accepted outputs; each returns collected lists. They cannot be combined. Multi-step loop bodies and parallel shared-state execution are not included.

`ask` creates a `needs_input` record and exits. Resume with `--human FILE` containing the actual human answer as shown below. The runtime does not generate a human answer.

## Limits and accounting

Operator configuration can override the finite default run limits: one hour, 100 model requests, 100 step invocations, 200 tool calls, and 16 MiB each for input and output. A missing configuration uses the local Codex agent as model `default`. Custom scripts, tools, and models still require their configuration. Model requests and tool calls may be zero. A Method cannot increase those caps.

A model-using step can override `max_model_requests`; an agent-using step can also override `max_agent_turns`. Configuration `step_defaults` can change the defaults. Action and check share these limits and `timeout_ms` for each invocation. For the direct API backend, one agent turn is one model response. Repeated invocations share the run caps. For a direct API agent, the runner does not dispatch a tool when no follow-up model request or agent turn remains.

Direct API provider calls have no automatic retries. Codex manages its own internal requests; script-internal provider calls are also outside this accounting. Usage from completed provider responses is recorded; unavailable usage remains unknown. `cost_usd` is null because this release does not calculate prices or enforce a monetary budget. Request counts and output-token limits are resource caps, not a dollar guarantee. The operator must decide the spending allowance before live runs.

Run `elapsed_ms` starts after document/configuration validation, initial-value checks, and runtime resolution. It includes bundle capture, execution, checks, and recording. Measure CLI wall-clock time separately when comparing full startup overhead. Game time and pause settings belong to the game adapter; this runner does not control or pause simulation.

## Files, traces, and recovery

`files` explicitly lists additional helper/dependency files. Direct script and tool entrypoints are included automatically. Files are copied into the run's bundle and hashed. Relative paths cannot escape the source directory, including through symlinks. Large model weights should be external with their version/hash supplied through an explicit input or locked helper dependency; there is no managed model registry.

The runner verifies bundle hashes before each script execution. It records the Method and configuration hashes, runtime binary hashes, inputs, candidate outputs, state changes, checks, model requests/responses, tool dispatches/results, errors, and timestamps. User-supplied model aliases resolve to the recorded settings. Hosted model weights can still change behind a provider identifier.

File outputs use `{path, sha256}`. Write them beneath `METHOD_OUTPUT_DIR`; paths are resolved relative to that artifacts directory. The runner checks their hashes. Imported input files are operator-supplied dependencies and are not automatically copied; list required policy files in `files`.

Generic run records are private local artifacts by default (directory mode 0700, files 0600). Known configured environment-secret values are redacted from traces and result files when at least four characters long. This is a convenience, not a comprehensive secret detector. State checkpoints contain actual state values; keep state and inputs free of credentials. Do not publish raw run directories without review.

Failures do not trigger automatic retries. Resume with the original method and configuration:

```sh
method run task.method --config runtime.json --run-dir runs/example --resume
# After inspecting an unfinished action and its external effects:
method run task.method --config runtime.json --run-dir runs/example --resume --retry STEP:ITERATION
```

`checkpoint.json` saves accepted iterations, typed state, inputs, runtime identity, active dispatch, and cumulative usage. Accepted work is reused, including each/repeat outputs. Method, configuration, runtime executable, and bundle hashes must match. Accepted file outputs are verified again. Run time excludes time while stopped; consumed execution time and request budgets do not reset. Completed runs return their saved result.

An unfinished invocation requires explicit retry. A stopped `ask` accepts `--human JSON` with `{steps: {"STEP:ITERATION": {outputs: {...}}}}`; checks still run. The runner does not guess whether an uncertain external action completed. Inspect the target first.

A process lock prevents concurrent resume. An abruptly killed process can leave `.lock`; confirm the process is dead before removing it. An active lock must stay in place. Inspect `events.jsonl`, `summary.json`, and `checkpoint.json` before recovery.

For new evidence or changed inputs, use a new run. `--state prior-run/state.json` imports state but starts the method from the beginning. An application ledger of evidence hashes can select only changed work. This is separate from resuming a stopped run.


## Validation evidence

The test suite executes real local scripts and the complete model/tool orchestration against deterministic response fixtures. The HTTP request format, error handling, output validation, and accounting are tested with a mocked HTTP transport. No live billed model call or game performance result is claimed by those tests.

## Parsing and API contract

The SDK and runtime use the same parser and document validator. Parsing permits bounded YAML aliases (maximum expansion count 20), rejects duplicate keys and documents over 2 MB, and preserves text whitespace. File values require exactly `path` and a lowercase 64-character `sha256`. Invalid documents throw `MethodValidationError` with `invalid_method` or `unsupported_format`.

The JavaScript API exports `RuntimeConfig`, `RunOptions`, and the status-based `RunResult` union. `runMethod(file, config, options)` returns completed, failed, or needs_input records. It does not perform the product CLI's account sync or automatic environment preparation.

The executor records its package version as `executor_version` in the checkpoint, manifest, and run start/resume events. Resume requires that exact executor version before setup or execution. A checkpoint without this field requires its original SDK/runtime installation. These checks are separate from script executable hashes. Completed results can still be uploaded without execution.

## Browser connections

An agent can select `browser: environment.NAME`, where NAME is a browser
environment. The host supplies that connection's standard browser controls.
Omitted `tools` means no custom tools. Interactive controls require the
connection in `changes` and a declared check. Browser sessions and credentials
are supplied by the host, outside the Method.
