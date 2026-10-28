# Method reference

Implemented by `@withmethod/runtime` 0.16.7. The full Method SDK uses this runtime at a released version. New methods use this format under the same Method product and command.

Use `format: method/3.4` for new documents. Existing `method/3.1`, `method/3.2`, and `method/3.3` documents load and run unchanged. All formats share one set of rules, with two exceptions that keep saved documents running: before `method/3.3`, an external change needs no effect; before `method/3.4`, a plain model name can name a configured profile (or a saved package's `runtime.json` model). Method 3.3 adds effect contracts: an external change is confirmed by an observer, not by the action's receipt. Method 3.4 adds the Method ID, the Method's own `models`, `limits`, and `tools`, model IDs on steps, and accepted warnings (see [Method 3.4](#method-34)). The machine-readable grammar is [method-3.schema.json](method-3.schema.json). Operator configuration uses [runtime-config.schema.json](runtime-config.schema.json). The validator also checks references, dependencies, data declarations, loop conditions, and effects; JSON Schema alone is insufficient.

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
method validate example.method
method run example.method --inputs inputs.json
method schema method
method schema config
method observe RUN_DIR
method test example.method
```

The runtime package installs no command. Contributors can run `node src/cli.js` in this checkout. The contributor harness runs scripts with `node` and `python3` from PATH, and reads no configuration file; the SDK also supplies account commands, automatic setup, and background workers.

`validate` checks the Method and prints its [issues](#issues). No command reads a configuration file: the SDK builds the runtime configuration (`RuntimeConfig`) and passes it to `runMethod`. `run` additionally resolves profiles, tools, capabilities, environment bindings, and bundle files. A validation pass alone does not establish executable setup or task correctness.

`run` prints status, elapsed time, model request count, and the run directory. Read `result.json` in that directory for the result. Exit codes are 0 for completion, 1 for failure, 2 for a human-input request, and 3 for an unconfirmed run: every step finished, but an observer could not confirm an external change by its horizon. A new run needs a new directory. Use `--resume` to continue the same saved run.

## Method 3.4

```yaml
format: method/3.4
id: wf_3cfa2d6d2c00552ce5a4ab723a8248fe   # written once by the CLI; not part of the content digest
models:                                    # what model names mean
  writer: openai/gpt-6-luna
  fields_writer: {model: deepseek/deepseek-v4.1-flash, max_output_tokens: 4000, reasoning_effort: low}
  reviewer: {agent: codex, reasoning_effort: high}   # a local agent on the computer that runs the Method
steps:
  write:
    do: {kind: call, model: writer, prompt: ...}             # a name from models
  intro:
    do: {kind: call, model: openai/gpt-6-luna, prompt: ...}  # or a model ID
  fields:
    do: {kind: call, prompt: ...}                            # or nothing: the account default
    accept: {prompt_multiple_tasks: "The user wants one combined field list."}
limits: {timeout_ms: 600000, max_model_requests: 20, step: {timeout_ms: 120000}}   # run limits; step: per-step defaults
tools:                                     # tools that agent steps list by name
  calculate: {description: ..., in: {...}, out: {...}, run: {kind: run, runtime: python, entrypoint: calc.py}}
```

- `id` is the account Method's ID: `wf_` and 32 lowercase hex digits. The CLI writes it at the first signed-in save. The content digest leaves it out (`documentForDigest`), so a copy keeps its versions and an `id` written during a run does not stop its resume.
- `models` maps a name to a model ID, or to `{model, max_output_tokens?, reasoning_effort?}` (reasoning effort: minimal, low, medium, high), each a hosted model (backend `method`), or to `{agent: codex | claude, model?, reasoning_effort?}`: a step that names it runs as a local-agent model step (backend `codex` or `claude`, with that agent's own model name and reasoning effort) wherever the Method runs. That agent must be installed and the configuration must allow local processes.
- A `call` or `agent` step's `model` (also an agent check's) is a `models` name, a model ID (`provider/model`, pattern `^[a-z0-9-]+/[A-Za-z0-9._:-]+$`), or absent (the account default). `default` keeps meaning the account default. In `method/3.4`, any other plain name must be one of `models` (`unknown_model`). In earlier formats, a plain name names a caller-configured profile.
- `accept: {CODE: reason}` on a step accepts that warning or note on that step. The issue stays in the list with `accepted` set to the reason. Errors cannot be accepted.
- `limits` sets run limits (`timeout_ms`, `max_model_requests`, `max_invocations`, `max_tool_calls`, `max_output_bytes`, `max_request_bytes`, `max_concurrency`); `limits.step` sets the defaults for steps without their own limits (`timeout_ms`, `max_agent_turns`, `max_model_requests`; it replaces configuration `step_defaults`). Document limits come before configuration limits.
- `tools` defines the tools that agent steps name in `tools:`, with the same form as configuration `tools`. A document tool comes before a configuration tool with the same name. Script tools are part of the saved package.

## Issues

`methodIssues(document, options)` returns a list of issues. Each has `code`, `level` (`error`, `warning`, or `note`), optional `step`, `field`, `file`, and `line`, a one-sentence `message`, a one-sentence `fix`, optional `evidence`, optional `path` and `patch` (see [Untrusted text](#untrusted-text)), and `accepted` (the reason, when the step accepts that code). A format error (the first one) is the only issue for a document that does not validate; it keeps the validation code. For a valid document the runtime adds these deterministic checks:

| Code | Level | When |
|---|---|---|
| `secret_value` | error | The document or a file in `options.files` contains a value from `options.secretValues` (exact match, values of 8 or more characters). The value never appears in the issue. |
| `missing_secret` | warning (error with `phase: 'run'`) | A declared secret is not in `options.availableSecrets`. |
| `untrusted_reaches_action` | warning | Text from an untrusted source can reach an acting step without a question to you. See [Untrusted text](#untrusted-text). |
| `unused_output` | warning | No step, check, effect, result, or run label uses an output. |
| `accept_unused` | note | A step accepts a code that no longer fires on it. |

`options.issues` adds issues from other checks (for example the SDK's model checks); accepts apply to them too. `options.notChecked` lists codes that were not computed this time, so their accepts give no `accept_unused` note. `options.tools` supplies operator tools for the untrusted text check. An accept of a code that no longer exists, such as `untrusted_content_can_act` (replaced in 0.14.0 by `untrusted_reaches_action`), gives the `accept_unused` note. Issues are sorted errors first, then warnings, then notes.

### Untrusted text

The runtime follows text from untrusted sources through the steps. It uses only the declarations in the Method and in `options.tools`: no lists of names and no model calls.

- **Sources.** An `agent` step with a `browser`. A step that binds a `service` connection in `in` or `each` and does not list it in `changes`. An agent with a tool that has no effects and whose `connection` is a `service` environment. Run inputs are not sources: the format has no mark for inputs that come from outside.
- **Acting steps.** A step whose `changes` name a connection that is not `files` (a step with `effects` always has one), or an agent with a tool whose declaration has effects. Document `tools` come before `options.tools`.
- **How text travels.** A step's outputs that can hold text get the label of every value that the step reads (`in`, `each`, `when`, an effect's `in`, and state that a labelled step changed), and the label of its own source. An `ask` step and a `classify` step give no label (a person or a fixed list of options made the value). A `number` or `boolean` value holds no text, and a record or list holds text only when one of its fields or items does. A reference to a number field of a labelled record has no label.
- **Finding.** An acting step that reads a labelled value gives `untrusted_reaches_action` on that step. `field` is the place where it reads the value. `path` lists the values from the source to the step as `step.output` references, for example `["discover.findings", "draft.message"]`. When one step reads the content and acts, `path` is the connection, for example `["environment.web"]`, and the fix is to split the step. An acting step whose `when` is an output of an `ask` step is clear for the values that the `ask` step also reads in `in` or `each`, because the person saw them.
- **Patch.** When the acting step has no `when` and does not read the content itself, the issue has `patch: {safety: "behavioral", edits}`. The edits insert an `ask` step before the acting step that reads the same values and returns one boolean, and set the acting step's `when` to that boolean. `behavioral` means that the Method then runs differently: it stops to ask you.

`methodProofs(document, options)` returns what these checks prove, as `[{code, statement}]`. It gives `{code: "no_untrusted_action", statement: "Text from web pages cannot reach a step that sends or changes things without a question to you."}` when the Method has a source, an acting step, and no `untrusted_reaches_action` (accepted or not). Otherwise, and for an invalid Method, it gives an empty list. A proof covers declarations only: a script that reads the web or sends mail without a declaration is not seen.

**Edits.** `applyEdits(document, edits)` applies a list of edits to a parsed document and returns a new document. It does not change its input. A bad edit throws an error with code `invalid_edit`.

| Edit | Effect |
|---|---|
| `{op: "set", path: [KEY, ...], value}` | Set the value at `path`. Missing records on the way are made. |
| `{op: "remove", path: [KEY, ...]}` | Remove the value at `path`. |
| `{op: "insert_step", before, id, step}` | Add step `id` to `steps`, just before step `before`. |

A path is a list of keys from the document root, for example `["steps", "send", "when"]`.

## Document and data

Root fields are `format`, `id`, `models`, `name`, `goal`, `inputs`, `state`, `environment`, `files`, `steps`, `result`, and optional plain-text `run_prompt` for the outside agent. `run_prompt` does not expand variables. Step `reading` fields provide display text and do not change execution. Only format, name, goal, steps, and result are required.

Inputs and state declarations have a type and optional description and default. Supply missing initial values through `--inputs` and `--state`, each pointing to a JSON object. Unknown or wrongly typed values fail before any operation. State is saved as one atomic `state.json` checkpoint in the run directory. Method 3 does not use Method 2's per-state `file` field.

Types are `text`, `number`, `boolean`, `record`, `list`, and `file`. Records require `fields`. Lists require exactly one of `items` or `fields`; the latter describes each record in the list. Nested fields may use a short type name or a full shape. All declared fields are required and extra fields fail. Defaults must meet the declared type.

References such as `inputs.target`, `state.count`, and `decision.goal` connect data. `run.started_at` contains an ISO timestamp. Named step outputs must be unique across the Method. Reserved namespaces cannot be reused as output names. Data references determine execution order; `after` adds explicit dependencies. Cycles fail validation. Independent steps currently run sequentially.

The `environment` declarations describe connections. Operator configuration supplies a non-secret string for each connection, such as a local endpoint. Bind these values through `in` where needed. Credentials belong in environment variables, not in the Method or configuration data.

## Executable steps

Step names, purposes, output descriptions, and `reading` text are optional, and all limit overrides are optional. Default step limits are ten minutes and 32 model requests or agent turns; explicit limits override these values. Use exactly one of `do` or `ask`. The `do` forms are:

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

```yaml
do:
  kind: session
  agent: claude            # or codex
  model: opus              # optional, with reasoning_effort
  prompt: Read brief.md and write memo.md. {{task}}
  tools: [read, write]     # read, write, edit, search, shell, web
  room: folder             # optional: a text value that the step receives, the path of a folder
out: session
```

A `session` is a plain agent: one headless Claude Code or Codex session, as a person would run it, with no Method prompt, output form or Method tools. It gets only its rendered prompt, not the step inputs as JSON, no "do only this step" text, and no learned rules; a failed check does not run it again. It runs in a clean room: a fresh `HOME` whose agent config folder (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`) holds only the user's sign-in (a Claude Code token from the environment or the macOS Keychain, or a link to the credentials file; a link to Codex's `auth.json`), a short `TMPDIR`, and only `PATH`, the language and the user's name from the caller's environment. So it sees none of the user's instructions (`CLAUDE.md`, `AGENTS.md`), memory, settings, skills, plugins, hooks or MCP servers. It works in the room's own copy of its `room` folder (an empty folder without one). When it ends, each file that it added or changed goes back into the `room` folder, so later steps read what it handed in there, and the room is removed, also when its folders are read-only. A reused session puts its recorded files into the `room` folder the same way. `tools` names what it may do. Claude Code runs in restricted mode with exactly those tools (`read`: Read, `write`: Write, `edit`: Edit, `search`: Glob and Grep, `shell`: Bash, `web`: WebSearch and WebFetch), its file tools only in its working folder, and no slash commands or skills. Codex ignores the user's config and rules, has no plugins, apps or skill search, and runs in a sandbox rooted at its folder: read-only unless `write` or `edit` is named, with web search only for `web`. Codex reads and writes files through its shell, so a Codex session must name `shell`. The step's `limits.timeout_ms` bounds the session. `out` is one name, a record of `final_text` (the agent's last message), `files_written` (a copy of each file that the session added or changed in its room, under `session/attempt-*/room/`) and `transcript` (its `transcript.jsonl`). A session cannot change state, and changes no folder but its `room`.

`in` maps local aliases to references. `out` declares output values. The process or model returns a JSON object whose keys match `out` exactly, plus the state replacements described below. Inputs are supplied as JSON data. Model and human prompts can insert declared scalar inputs with `{{name}}` or `{{customer.name}}`. Agent check prompts use `{{inputs.name}}` and `{{outputs.answer}}`. Only text, finite numbers, and booleans can be inserted. Unknown references fail validation; missing runtime values fail before model execution. Escape literal opening braces with a backslash in a YAML block scalar. Values are inserted once without expression evaluation or recursive expansion. Command arguments, labels, tool descriptions, and run_prompt are not templates.

### Classification

Classification:

```yaml
name: Classify message
in:
  message: inputs.message
do:
  kind: classify
  question: Which team should handle this message?
  options:
    billing: Invoices and payments
    other: Anything else
out: message_category
```

A classify step has exactly one answer form:

| Form | `do` | Output value |
| --- | --- | --- |
| choice | `{kind: classify, question, options: {ID: description}}` (2–255 options) | `{choice: ID, probabilities: {ID: p}}` |
| yes/no | `{kind: classify, question, answer: yes_no}` | `{answer: boolean, probability: p}`, where p is the probability of yes |
| score | `{kind: classify, question, levels: [NAME, ...]}` (2–10 ordered names, lowest first) | `{level: NAME, score: number, probabilities: {NAME: p}}`, where score is the expected level index (0 = first level) |

Provide a nonempty step name and question, nonempty option descriptions, and at least one bound input through `in` or `each`. Questions and option descriptions are literal text. Inputs must be JSON data; declared files, including nested files, require an earlier extraction step. Classification cannot declare changes. Conditions, loops, checks, and limits use the normal step lifecycle.

Only classification uses an output name shorthand. `effectiveOutputs(step)` derives the record in the table. Other steps retain their output maps. Downstream steps can reference `message_category.choice` and `message_category.probabilities.billing`.

Probabilities are finite in [0,1]. A choice or score answer has exactly one probability per option or level, and they sum to one within 1e-6. The choice or level is within 1e-6 of the maximum, so ties are valid. A yes/no answer is true when the probability of yes is at least 0.5. A score is the probability-weighted level index. Provider confidence is null or finite in [0,1] and is trace metadata, separate from the probabilities. Business rules, counting, math, and date comparisons belong in a script.

Embedded callers supply `config.classification: {provider: 'typesafe', model: '<pinned version>'}` and a `ClassificationProvider` through run options. The provider receives `{request_id, model, question, inputs}` plus the step's `options`, `answer`, or `levels`. The SDK resolves this identity once through the Method account and saves it in the resolved configuration. Resume uses that identity. Classification-only runs do not prepare an agent. Missing provider setup returns `needs_input`.

To use your own OpenRouter key, add `api_key_env` to that configuration, for example `{provider: 'typesafe', model: 'jev-1.13.0', api_key_env: 'OPENROUTER_API_KEY'}`. The runtime then calls Typesafe's Jev at `https://openrouter.ai/api/v1/systemone` directly with that key. OpenRouter names the pinned release without its patch number (`jev-1.13`) and answers with a dated name such as `typesafe/jev-1.13-20260917`; the runtime accepts that answer as the pinned version. It does not use a supplied provider or the Method account, and the key is redacted from run records. A missing variable fails preflight.

Each attempt reserves one model request. A service that is briefly unavailable (HTTP 429 or 5xx, or an unavailable or timed-out service) is tried three times in all, with a growing wait; model calls use the same policy. Each retry records a `notice` event that names the class (rate limit, server error, unavailable, timeout) and the attempt, for example "attempt 2 of 3". A request that still fails after the last attempt fails the run with owner `outside_service`. Requests and responses are bounded to 64 KiB or the smaller configured byte limit. The invocation deadline and cancellation apply. Responses must match the saved provider and model. Invalid responses fail without repair or retry. The result follows the existing candidate, check, and acceptance path. `model.request` and `model.response` carry `kind: classify`, request ID, provider, and model; the response adds confidence, usage, and duration. A reported `usage.cost` adds to the run's `cost_usd`. Missing usage remains unknown.

### Scripts

Give each script action a name and purpose that describe its rules, result, and external changes. Describe each top-level output. Describe script checks in `reading.check` and script tools in their configured `description`. Readers show these descriptions; validation does not require them. Review them whenever behavior changes.

Split scripts where retrying one operation could repeat another completed action. Keep calculations together when they serve one decision. Return the decision rule or external receipt as inspectable output. For external writes, describe how to check uncertain completion and use the service's duplicate-prevention key when available.

Script actions and checks receive `METHOD_OPERATION_ID`: `mop_` followed by SHA-256 of the JSON array `[execution_id, step_id, iteration, phase]`, where phase is `action` or `check`. The saved execution ID is a UUID. Explicit retries reuse this operation ID; new runs, iterations, and phases have distinct IDs. The variable is reserved and cannot be declared as a secret. Tool call identities keep their existing behavior.

Runtime profiles name an executable, optional fixed arguments, and a declared version. Commands use argument arrays without shell expansion. Node, Python, or another JSON-speaking executable can be registered.

A script reads one JSON object on standard input, writes one JSON output object on standard output, and sends diagnostics to standard error. It runs from a saved copy of the bundle. Scripts receive PATH, LANG, METHOD_OUTPUT_DIR, METHOD_ENVIRONMENT (the configured connection map as JSON), the declared secrets, and METHOD_PROGRESS_FD when a progress pipe is attached. The executor hashes the resolved runtime binary and records the operator's declared version.

The operator must set `allow_local_processes: true`. These are trusted local processes, **not an OS sandbox**. They can access resources allowed to the operating-system user.

**Observed effects.** The runner records what each Python and Node script process did as `observed_effects: {network, reads, writes, env, runs}` on its `process.completed` or `process.failed` event; an action's value is also on `step.accepted`, and a reused iteration copies it from its source run. `network` lists hosts (never URLs or query strings), `reads` and `writes` list paths (bundle files relative to the bundle, output files as `$METHOD_OUTPUT_DIR/PATH`), `env` lists variable names that the script read or set (never values; `METHOD_*` names are left out), and `runs` lists program names (never arguments). Each list is sorted, unique, and at most 200 entries; `truncated: true` says that a list was cut. Interpreter, standard-library, `site-packages`, `node_modules`, `/dev`, and the run's own internal files are left out. Python is observed with an audit hook loaded through a `sitecustomize` module on `PYTHONPATH` (it runs any `sitecustomize` it hides); Node with a `--require` preload (`diagnostics_channel`, `fs`, `child_process`, and a `process.env` proxy). Both remove their variables before the script starts and write to a file at exit, never to standard output. Another runtime, a process that ends without exit handlers (a kill, `os._exit`), or Python with `-E`, `-I`, or `-S` gives `{unavailable: REASON}`; the step still runs. This is a record, not a sandbox: native extensions, raw system calls, and child processes' own effects are not observed.

**Model requests are steps.** Each model or classifier request is its own `call`, `agent`, or `classify` step, with its prompt in the Method, so that it is recorded and can be changed and compared. The runtime does not scan script text for model requests; the SDK's model check `script_calls_model` does.

#### Secrets

A Method declares the secrets that its scripts need by name and purpose. It never holds their values:

```yaml
secrets:
  ARCHIVE_TOKEN: Read-only token for the post archive.
```

Names use capital letters, digits, and underscores. The variables that the runtime sets for scripts are reserved: `PATH`, `LANG`, `HOME`, `USER`, `TMPDIR`, and names that begin with `METHOD_`. The host supplies the values (runtime option `secrets`); without it, the process environment does. Every script step receives every declared secret. A missing value fails preflight with `missing_secret` and lists the names in `missing`; no step runs. Model profiles and classification find `api_key_env` in the same way.

`run_data: account` (the default) or `run_data: device` tells a signed-in host where to keep run content. The runtime keeps all run records locally either way.

On timeout or process exit, the runner kills the process group on POSIX systems. The first release is tested on macOS and Linux. Windows process-tree termination and runtime compatibility are not claimed.

### Models and agents

Profiles are resolved once, in this order. On resume, the saved profiles. The Method's own `models` (hosted, or a local agent for an `agent` entry) and the model IDs that steps name (hosted, backend `method`). Then the caller's configured profiles (`config.models`), then the `models` of a saved package's `runtime.json` when the document has no `models`. A step without a profile uses `default`: the configured default when it names more than a bare local agent; otherwise the user's own local agent subscription, which is the coding agent that started the run (Claude Code from `CLAUDECODE`, Codex from `CODEX_THREAD_ID`) when it is installed and signed in, else an installed and signed-in Claude Code or Codex (Claude Code when both are). The host's hosted model (`hostedModel`, on account credit) is used only when no local agent is available. A local agent that fails, for example at a usage limit, fails the step like any other outside service; no other model is tried. Both agents use their normal sign-in. Each model phase records a `model.used` event with the backend and model that ran it. The selected profiles remain fixed on resume. Codex starts a fresh process with approval and sandbox prompts disabled; it is trusted local execution. Claude Code starts without prompts and may use `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch` and the Method tools; it has no shell. A supplied configuration must allow local processes.

In a live run, Claude Code and Codex steps may search and fetch from the web. With the config's `web: false`, or the environment variable `METHOD_WEB=off`, a Claude Code step has no `WebSearch` or `WebFetch`, and a Codex step runs with web search disabled; a Codex step that runs outside a sandbox can still reach the network through its shell. A comparison sets it, so that no arm uses the web unless the comparison tests tools.

The temporary Method MCP bridge exposes only the step's declared Method tools. Codex also retains its built-in and installed tools. Empty `tools` does not mean that Codex has no tools. Both `call` and `agent` use a Codex process with a structured final output on this backend. Internal Codex model requests and tools are not governed by Method's direct API request/turn counters.

Method enforces the Codex process deadline, prompt/output size, and Method bridge tool-call cap. It saves prompts, output schema, JSON events, stderr, and reported usage. It does not edit persistent Codex settings or enforce a monetary budget.

#### Direct API backends

Three direct providers are available. Each profile specifies the exact model identifier, `api_key_env`, and a required `max_output_tokens`. Each backend has one fixed endpoint; a profile cannot name another URL. No model is silently substituted. Use a model supporting strict structured outputs; incompatible settings return a recorded provider error.

| Backend | Endpoint | Optional setting |
|---|---|---|
| `openai-responses` | OpenAI Responses API | `reasoning_effort`: none, minimal, low, medium, high, xhigh |
| `anthropic-messages` | Anthropic Messages API | `effort`: low, medium, high, xhigh, max |
| `openrouter-chat` | OpenRouter chat completions | `reasoning_effort`: minimal, low, medium, high |
| `method` | The host's `hostedModels.request`: the same request as `openrouter-chat`, sent through the signed-in Method account. It needs no key; `max_output_tokens` is optional (16000). | `reasoning_effort`: minimal, low, medium, high |

The output schema goes to each provider's strict structured output. OpenRouter requests require providers that support the requested parameters and name no fallback models. Anthropic tool turns keep the assistant content, including thinking blocks, unchanged. `model.request`, `model.response`, and `model.error` record the backend. Usage is recorded as input and output tokens; Anthropic input includes cache reads and writes. A response that reports `usage.cost` adds it to the summary's `usage.cost_usd`.

`call` sends one request with a strict JSON output schema and no tools. The runner validates the response locally. It does not issue repair calls. A rate limit (HTTP 429) or server error (5xx) is retried as for classification: three attempts in all, each one a model request, each retry with a `notice`. When the step's check does not pass, the step gets one more attempt (see State updates and checks).

`agent` uses a fresh conversation and an explicit function-tool loop. The allowed tools are operator-configured scripts with typed inputs and outputs. The runner validates tool arguments, invokes the allowed script, validates its result, and sends the result back to the model. Reasoning items are retained between requests. Unknown tools, malformed arguments, refusal, or incomplete responses stop the operation.

Each agent tool has `effects: []` for an observation/pure operation, or a list of environment names it can change. Action tools with effects require corresponding step `changes`. Checker agents can only use tools with empty effects. This enforces which registered functions the model can call; the truth of a tool's effect declaration depends on its trusted implementation. The direct API backend does not add an arbitrary shell; the Codex backend has the separate access described above.

Computer-use support can be supplied through registered tools or the existing Codex setup. The runtime does not bundle a browser driver or a separate computer-use backend.

## State updates and checks

Declare state changes with `changes: [state.count]`. The output must then include a `state` object with complete replacement values for exactly those state names, alongside its ordinary outputs. This example returns one output and updates one state value:

```json
{"current": 3, "state": {"count": 3}}
```

The runner records candidate outputs, validates them, runs the requested check, and then replaces the state checkpoint. A failed or unknown check prevents that state commit. Already completed external actions remain possible; withholding a local state update does not undo them.

**One more attempt after a failed check.** When the check of a `call` or `agent` step returns `fail` or `unknown`, and the step has no environment `changes` and no `effects`, the runner records `step.retry` (`{step, iteration, attempt: 2, attempts: 2, reason, evidence, message}`) and runs the action once more. The check's name, reason, and evidence are added to the end of the rendered prompt. The second candidate goes through the same check. If it does not pass, the run fails with `check_failed`. Script and classification actions, and steps that change the outside world, get no second attempt. A check result in the wrong form is a problem in the Method's code (`invalid_output` in the check phase) and gets no second attempt.

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

Status is `pass`, `fail`, or `unknown`. `reason` is text and `evidence` is a list of text; both are for display only. A `reason` that is not text, and each evidence item that is not text, becomes JSON text, and evidence that is not a list becomes a list of one. The same rule applies to an effect judge's `reason` and `evidence`. `status` and `verdict` are never converted: another value fails the run as a problem in the Method's code. Evidence entries are references, not automatic proofs. The incoming evidence list is empty in this release; observations can be bound as data or obtained through a trusted read tool. Script checks run as trusted local code and are not isolated from the action's filesystem.

Output types are always checked. An omitted task check is recorded as `unchecked`, not `pass`. An external `changes: [environment.game]` declaration requires effects (next section); a check covers only outputs and state. Documents saved before `method/3.3` need no effect. A check of an action's completion does not establish that it was strategically useful.

## Effect contracts

A success status, receipt, or returned ID shows only that a service accepted a request. In `method/3.3`, the runtime confirms external changes by reading the changed system, and decides from those observations whether the run is complete.

**Local files need nothing.** For each `files` connection in a step's `changes`, the runtime lists the folder (or the one file) before and after the step: size and modification time, skipping `.git`, `node_modules`, `.venv`, `__pycache__` and `.method-runs`. A listing stops at 20,000 files or 3 seconds; such a folder is recorded once as `unobserved` and is not listed again in that run. It records the changed files in the ledger (`STEP/ITERATION/files:NAME`) and keeps a copy of up to 20 written files of at most 1 MB each under `effects/files/`, so the run record shows what the step wrote even after a later run overwrites it. When a text output of the step is a path inside the folder (an absolute path, or a relative value with no spaces that has a `/` or a file extension), that file, or a file inside that folder, must have been added or changed: "the step returned `out/weekly.md`, but that file did not change" fails the run with `effect_contradicted` before later steps start. A step that changes nothing, and claims no file, is recorded as `unchanged` and does not fail. 

**Other connections** (a service, a browser, a desktop) need an effect or a waiver. A short service effect, with defaults:

```yaml
steps:
  save_contact:
    do: {kind: run, runtime: node, entrypoint: save-contact.mjs}
    changes: [environment.crm]
    effects:
      saved:
        intent: The CRM has one contact with this email address.
        in: {email: inputs.email}
        observe: {kind: http, path: "/contacts?email={inputs.email}", expect: {fields: {count: 1}}}
```

A longer one, with a script observer and a 5-day schedule for mail:

```yaml
environment:
  mail: {type: service, description: Outgoing mail.}
  mailbox: {type: service, description: Delivery reports and bounces, read-only., role: observer}
steps:
  send_summary:
    name: Send summary
    purpose: Send the summary to the AP lead. Puts METHOD_OPERATION_ID in the Message-ID.
    in: {to: inputs.ap_lead, summary: summary}
    do: {kind: run, runtime: node, entrypoint: helpers/send.mjs}
    out: {receipt: {type: text, description: Provider receipt.}}
    changes: [environment.mail]
    effects:
      delivered:
        intent: The AP lead's mail server accepts the summary and does not return it.
        in: {to: inputs.ap_lead}
        observe: {kind: run, runtime: node, entrypoint: observers/mail-fetch.mjs}
        judge: {kind: run, runtime: node, entrypoint: observers/mail-judge.mjs}
        fixtures: observers/fixtures/delivered
        schedule: {first: 60s, then: [10m, 1h, 1d], horizon: 5d}
        confirm: unrefuted_at_horizon
        retry: never
        blocking: false
```

Rules:

- `changes` defaults to none. It is a declaration: the runtime cannot see what a trusted local script does.
- A step that changes a connection other than `files` has at least one effect, or a `no_effect_reason`: a plain sentence that says why no observer confirms the change, for example "Reads pages only; submits and posts nothing." for a browser step. The run records each waiver (`effects.waived` event and `unobserved_changes` in the result), so a reader sees which external changes nobody observed. Use one of the two, not both. A step that changes only files connections needs no waiver, because those are observed automatically; a waiver there has no effect.
- Defaults: `schedule` is one reading at once with a 1-minute horizon; `confirm` is `positive`; a built-in observer reads the connection that the step changes (read-only), or must name one when the step changes several.
- An environment with `role: observer` is visible only to effect observers. Actions cannot bind it, change it, or see its configured value in `METHOD_ENVIRONMENT`. Give observers separate, read-only credentials through their runtime profile.
- An effect's `in` cannot reference its own step's outputs. An observer never sees the receipt. It receives the **correlation token**: the action's `METHOD_OPERATION_ID`. Put the token where the changed system keeps a reference (a message header, an idempotency key, a note field). For an `agent` action with effects, the runtime adds the token to the prompt.
- `schedule` offsets count from the action's completion and must increase. The last offset, `horizon`, is the time after which no new evidence is expected. Units are `s`, `m`, `h`, and `d`. `first` defaults to `0s`.

**Built-in observers.** For the common cases, `observe` names a built-in kind and needs no script, judge, or fixtures; the runtime's own tests cover their judgment. Each runs in its own process and reads `connection`: by default the connection that the step changes, opened read-only, or an environment with `role: observer` when the observer needs separate, read-only credentials. Templates insert `{token}` and `{inputs.ALIAS}` from the effect's `in`.

```yaml
# A local file or folder (files connection): the report exists and holds the intended text.
observe: {kind: file, connection: store_reader, path: "runs/{inputs.day}/result.md", expect: {contains: "{inputs.person}"}}
# A SQLite database opened read-only: exactly one row. Two rows is a duplicate and contradicts the effect.
observe: {kind: sqlite, connection: repo_reader, database: data/memory.sqlite, query: "SELECT id FROM memory WHERE note = :note", params: {note: "{inputs.report}"}, expect: {rows: 1}}
# An HTTP JSON service: compare fields. increases needs two readings and holds for every later one.
observe: {kind: http, connection: game_reader, path: /, method: POST, body: {action: observe}, expect: {fields: {state.iron_plates_produced: {increases: true}}}}
```

- `file`: `expect.exists` (default true), `contains`, `sha256`. A missing file is no evidence yet; different contents contradict.
- `sqlite`: one `SELECT` with named parameters; `expect.rows`, or `min_rows` and `max_rows`. Fewer rows is no evidence yet; more rows than intended contradicts.
- `http`: `GET` by default; `POST` with a JSON `body` for APIs that read through POST. 404 and 410 are no evidence yet; another status outside `expect.status` (default 2xx) is unobservable. Each field is an exact value or `{at_least, at_most, increases}`. A field below `at_least` is no evidence until the horizon and then contradicts. With `increases`, every reading must be higher than the one before; the effect is confirmed only at the horizon. A bearer token for a read-only API comes from `METHOD_OBSERVER_TOKEN` in the executor's environment.

The action does not need to store the token when a business key identifies the change, as in the SQLite example.

**Script observers.** `observe` reads the changed system. It receives `{token, intent, inputs, attempt, action_outcome}`, the observer connections in `METHOD_ENVIRONMENT`, the token in `METHOD_EFFECT_TOKEN`, and its runtime profile's variables. It does not receive `METHOD_OUTPUT_DIR`. It returns `{"observations": [{"source", "ref", "observed_at"?, "data"?}]}`. `judge` receives `{token, intent, inputs, observations, previous, final}` with no connections and no profile variables. `previous` lists the earlier readings of this effect (`{observed_at, observations}`, oldest first), so a judge can decide a trend; `final` is true at the horizon. It and returns `{"verdict", "reason", "evidence"}`. The verdict is `confirmed` (positive evidence of the intended result), `contradicted` (evidence that it did not happen), `no_evidence`, or `unobservable`. Keep the judge a deterministic script: it is tested on fixtures.

**Fixtures.** A script observer needs `judge` and `fixtures`; a built-in needs neither. `fixtures` names a folder of JSON files: `{"observations": [...], "expect": "<verdict>", "inputs"?: {}, "token"?: "...", "previous"?: [...], "final"?: false}`. The folder is part of the bundle. Before any step runs, the runtime runs every judge on every fixture. The run fails with `effect_fixture_failed` unless each fixture gives its expected verdict and the folder has a `contradicted` case and an empty case (`observations: []`) that gives `no_evidence`. With `confirm: positive`, it also needs a `confirmed` case. A judge that cannot report a failure proves nothing.

**Verdicts.** The runtime maps each judgment to a verdict:

| Verdict | Meaning | Final |
|---|---|---|
| `pending` | No evidence yet, before the horizon. | No |
| `confirmed` | Positive evidence of the intended result. | Yes |
| `contradicted` | Evidence that the intended result did not happen. | Yes |
| `unrefuted` | The horizon passed with no evidence of failure, and `confirm: unrefuted_at_horizon`. Not proven. | Yes |
| `unknown` | No observation was possible, or the horizon passed with no positive evidence and `confirm: positive`. | At the horizon |

Absence of evidence never gives `confirmed`. For mail to other domains, positive evidence is usually not available; `unrefuted_at_horizon` with a horizon of about 5 days matches mail servers' retry periods.

**Ledger and status.** The runtime writes `effects.jsonl` in the run directory: one entry per registration or observation, with the token, observer inputs, action outcome, attempt, time, verdict, reason, evidence references, the SHA-256 of the observations, the next observation time, and the horizon. Raw observations are saved under `effects/`. The current verdict of an effect is its last entry. The run's status follows the worst verdict:

| Status | Condition | Exit code |
|---|---|---|
| `failed` | An effect is contradicted: `failure.code` is `effect_contradicted` and the owner is `agent_work`. No `result.json` is written. | 1 |
| `unconfirmed` | No contradiction, and an effect is `unknown` at its horizon; `effects` lists it. `result.json` is written. | 3 |
| `completed` | Every other case. `effects.pending` counts effects still before their horizon. | 0 |

The summary and the run result carry an `effects` summary. Before the run reports, the runtime makes every observation that is due within `limits.effect_wait_ms` (operator configuration, default 300000, five minutes) and within the run deadline, so short schedules finish inside the run. `method observe RUN_DIR` makes the later observations that are due; `method observe --pending ROOT` does this for each run under ROOT with open effects. Schedule it, for example hourly. It runs only observers and judges, appends to the ledger and to `events.jsonl`, and records `run.status_changed` when new evidence changes the status, for example from `completed` to `failed` after a late bounce.

**Blocking and retry.** With `blocking: true`, the runtime waits for the first observation before later steps start. A contradiction then stops the run with `effect_contradicted`, and the step stays unaccepted, so resuming it needs `--retry STEP:ITERATION`. With `retry: idempotent` as well, the runtime first repeats the action once with the same `METHOD_OPERATION_ID` and observes again. Declare `idempotent` only when the service drops a repeated request with the same key. The runtime never repeats an action because an effect is `pending` or `unknown`.

**Failed actions.** When an action with effects fails, for example by a timeout or a crash, the runtime observes each effect at once with `action_outcome: indeterminate`. The failure's `next.text` lists the verdicts. A `confirmed` verdict means the change happened, and the action must not be retried.

Limits: observers are trusted local processes, not an OS sandbox. A read can have side effects (an IMAP fetch can mark mail as read). The separation of actions and observers is least privilege, not proof.

## Recorded cases

A case is a recorded run plus an expectation about it. It turns a correction into a test that every later version must pass. Cases live in `cases/ID/` next to the Method file and belong to that file name.

```sh
method case new task.method --id sources-named --run runs/bad --passing-run runs/fixed --note "The report doesn't say which source backs each point." --rubric "Every point names the source file that supports it." --rubric "The report is under 300 words."
method test task.method
method case retire task.method old-rule --by new-rule --reason "Policy changed on 2026-10-01."
```

A case keeps the copies of the files that its source run wrote, and a rubric judges a path inside a files connection by that run's copy, not by the file on disk now.

A case also keeps a copy of everything its run read, so that it still replays after the run folder or the input folders move, change, or are deleted:

- Each text value in the run's inputs and in each step iteration's inputs and outputs that is an absolute path to an existing file or folder is copied. A path inside the source run folder goes to `snapshot/run/PATH` (PATH relative to the run folder); any other path goes to `snapshot/ext/N/NAME`. A path that a script step made in the run folder is copied as the script left it: a run keeps that copy in its `kept/PATH` when the step is accepted (up to 5,000 files and 100 MB), because a later step may change or remove it before the case is made.
- Each `files` connection that no step writes is copied to `snapshot/env/NAME`.
- A path inside a copied folder uses that copy. A folder that holds the run folder (such as the home folder or the temporary folder) is not copied.
- All copies of a case together hold at most 5,000 files and 100 MB. `.git`, `node_modules`, `.venv` and `__pycache__` are left out. A path that does not fit is listed in `snapshot_missing`.

`case.json` lists the copies as `snapshots: [{original, copy, kind: run|ext|env}]` and the paths that did not fit as `snapshot_missing: [PATH]`. `recording.json` names the source run folder as `source_run_dir`. Copies stay on the computer with the case.

`--run` is the run that went wrong. The case must **fail** on it; otherwise the case does not capture the problem, or the note does not match what the run did, and `case new` refuses it (`case_not_red`). `--passing-run` is the run that the person accepted after the fix; the case must **pass** on it (`case_not_green`). A case with only `--passing-run` pins behaviour that is already right.

`case new` also checks the case against the instructions of the Method's model steps and the information each step received on the recorded run. When a rule can be met only by breaking an instruction (for example, the rule needs a fact that the inputs do not give and a prompt says not to invent facts, or the rule requires what a prompt forbids), `case new` refuses the case (`case_conflicts`) and names the rule and the instruction. Ask the person which one is right. When the case is right, change the instruction first. To keep both, add `--accept-conflict "the person's answer"`; `case.json` keeps the answer and the conflicts in `accepted_conflicts`.

`case new` reads the run's events and saves `recording.json` (each accepted iteration's inputs and outputs, a key for each step, the run's inputs and initial state, and the run's effect observations), the declared files of its steps, and `case.json` (note, author, source run, expectations, `runs`, `min_pass`, retention date). `--observations FILE` adds observations by effect key (`STEP/ITERATION/NAME`). `--redact FILE` maps recorded text to replacement text everywhere in the recording and the note.

Expectations (`--expect` is a JSON list):

- `{"kind": "equals", "ref": "outputs.report", "value": ...}` compares a step output, or another ref (see below).
- `{"kind": "status", "in": ["failed"]}` checks the run status.
- `{"kind": "effect", "effect": "send/0/delivered", "verdict": ["contradicted"]}` checks an effect verdict.
- `{"kind": "predicate", "runtime": "node", "entrypoint": "check.mjs"}` runs a script on `{status, failure, result, inputs, outputs, effects, tools, tool_calls, effect_inputs, files}` that returns `{"pass": true|false, "reason": "..."}`. The script is copied into the case. `tool_calls` lists each call of a Method tool as `{tool, step, iteration, arguments, standin}`, stand-ins of a replay included (`standin: true`); `effect_inputs` lists the recorded inputs of declared effects; `files` maps each file the run wrote (a path under `artifacts/`, or a path in a `files` connection) to an absolute path that the script can read.
- `{"kind": "rubric", "ref": "outputs.report", "criteria": [{"id": "c1", "text": "..."}]}` judges text, a record (as JSON), or a text file output against plain sentences. `--rubric SENTENCE` (repeatable) makes one; `--ref` defaults to the Method's result. `"context": ["outputs.material", "inputs.claim"]` (`--context REF`, repeatable) gives the judge other values to check against, such as the sources or the person's words; the judge reads them but does not judge them, and quotes come only from the judged value.

The `ref` of an `equals` or `rubric` expectation, and each `context` ref, names what the person saw:

- `outputs.NAME` (or a field below it): a step output. `inputs.NAME`: a run input.
- `result`: the whole run result.
- `file:PATH`: the text of a file that the run wrote. A relative PATH is under the run's `artifacts/`. An absolute PATH is a file in a `files` connection (the copy that the runtime kept), in a folder that the case copied (the attempt's own copy), or in the run folder.
- `effect:NAME`: for a Method tool, the list of the arguments of each of its calls, stand-ins included; for a declared effect, by key (`send/0/delivered`) or by name (`delivered`), its recorded inputs.

A case whose refs are all `outputs.NAME` or `inputs.NAME` runs only the steps that produce them; another ref runs the whole Method.

Each expectation can carry `text`, a plain-language statement for people. A case is refused if its non-rubric expectations pass on an empty result: such a case cannot detect the error.

**Rubric judge.** A model judges each criterion and quotes the words that decide it, or gives an empty quote when no single passage decides it (for example, when something must be absent). A quote that is not in the value fails the criterion. The check compares only letters and digits, so Markdown markup, list numbers, table bars and typographic quotes do not count, and an ellipsis in a quote joins passages that must appear in that order. By default the judge runs 3 times and a criterion passes only when every vote passes. The judge uses the model profile `judge` when the configuration has one, otherwise the default agent. Operator configuration can change `rubric: {judge_runs, classify_threshold, max_value_bytes}`. With `options.judges` (a list of judge profiles), each profile judges every criterion; a criterion passes only when every judge passes it, and a disagreement fails it with the reason `unsure`. Judgments are cached by value, criteria, and judge profile under `~/.cache/method/judgments` (or `METHOD_CACHE_DIR`). At `case new`, the judge's verdicts on the run that went wrong and the pass on the accepted run are saved as `examples.json`. When a classification provider is configured, the faster classification judge is used for a criterion only when it agrees with those examples, including at least one pass and one fail; otherwise the model judge stays.

**Replay.** `method test` runs the Method once per case run, with the recorded inputs. A step whose key (its definition, script files, the Method's declared `files` when the step runs a script, model profiles, tools, and its own active learned rules; not its name, reading, purpose, or effects) and inputs match the recording returns the recorded outputs and records `step.replayed`. Other steps run.

Each attempt has its own scratch folder, so two attempts never share a folder:

- The case's snapshots are copied into it. The recorded inputs and each served step output name these copies in place of the recorded paths (a whole path, a path below it, or a path inside text). Each `files` connection that no step writes is bound to its copy.
- Each `files` connection that a step writes is replaced by a scratch copy of the real folder (up to 5,000 files and 100 MB; a larger folder makes the case `unverifiable`), so a changed step that writes files runs safely and the real folder is not touched.
- A path in a step's inputs is compared with the path that the recorded run saw.
- A live step whose inputs name a path in `snapshot_missing` makes the attempt `unverifiable`, with the reason `missing_file` and the path.

A replay cannot change anything outside its scratch folder:

- Claude Code may use `Read`, `Glob` and `Grep` only in the scratch folder and the replay's run folder, and `Write` and `Edit` only in the run's `artifacts/` and the scratch folder. It has the Method tools and no `Bash`, `WebSearch` or `WebFetch`.
- Codex runs in its `workspace-write` sandbox with the scratch folder as its working folder, the run's `artifacts/` as the only other writable folder, and no network.
- A Method tool with `effects` does not run. It returns `{"replayed": true}`, and a `tool.standin` event records the tool and its arguments.
- A script that runs live gets `HOME` inside the scratch folder, `METHOD_REPLAY=1`, and a `TMPDIR` of its own under the system's short temporary root (`/tmp`), removed when the replay ends. Tools put sockets in `TMPDIR`, and macOS cuts a socket path at 104 characters.

A changed step that asks a person, a changed script step that changes a connection other than `files`, or a changed session that may use `shell` or `web` (which can reach past its room's copy), cannot run in a test: the case is `unverifiable`. When every expectation refers to `outputs.NAME`, only the steps that produce those outputs, and the steps they depend on, run. Effects are judged on recorded observations only; observers never read the live system in a test. Without recorded observations, an effect is `not_replayed`. With them, an absence of evidence stays `pending`. Live runs (not replays) are not limited in these ways.

**Results.** Every active case must pass. Without `--runs`, a case runs once when only scripts run, and three times when a model step runs live, because a model can answer differently each time; every run must pass. A case that passes some runs and fails another is reported as `unreliable`: the Method does not follow the rule every time. With `--runs N --min-pass M`, the case passes when at least M of N runs pass. A case stops as soon as its result is decided. The report's `totals` give the time, the model steps that ran live, and the judge calls that were not cached. Cases run 4 at a time; cases whose recorded steps differ from this version run first. Each case reports `duration_ms`. Each attempt reports `live_steps` (the steps that ran live), `standins` (`[{step, iteration, tool, arguments}]`), and `output`: what a person would have seen, `{result, files}`, with the text of up to 10 files that the attempt wrote, by the path that the recorded run used. A `file:PATH` ref with a relative path reads the attempt's copy of the recorded run's artifacts first, where the live steps wrote.

`testCase` and `testSuite` accept these options:

| Option | Meaning |
|---|---|
| `once` | One run decides (`runs: 1`). |
| `runs`, `minPass` | Run the case `runs` times; it passes when at least `minPass` runs pass. They replace the case's own values. |
| `live: [STEP]` | These steps run live even when they match the recording. The result and each attempt report `target_live`: true when every named step ran live. |
| `judgeCache: false` | The rubric judge votes again instead of reading the judgment cache. |
| `keepDir` | A folder that keeps each attempt's run folder and scratch folder; each attempt reports its `run_dir`. |
| `judges: [PROFILE]` | Rubric criteria are judged by each of these judge model profiles (for example the user's Claude Code and Codex). A criterion passes only when every judge passes it; when the judges disagree, it fails with the reason `unsure` (`unsure: true`). `evaluate`, `createCase` and `judgeRubric` take the same `options.judges`. |

With `--baseline OLD`, each case also runs on the old version, to show what the change fixed or broke:

| Verdict | Meaning | Blocks the gate |
|---|---|---|
| `pass` / `fixed` | Passes on the new version | No |
| `regression` | Passed on the old version, fails on the new one | Yes |
| `fail` | Fails | Yes |
| `unverifiable` | Cannot be replayed on this version | Yes |
| `not_red` / `not_fixed` | A `--new` case passed before the change, or still fails after it | Yes |

`method test` exits 0 when no case blocks the gate. Retired cases stay on disk with their reason and the case that superseded them, and are not run. Cases past their retention date are listed as expired.

## Learned rules

`learned.json` beside the Method file keeps rules learned from corrections, by step:

```json
{"format": "method-learned/1", "steps": {"write": [
  {"id": "lr_0123456789ab", "when": "the claim is about sanctions", "then": "Name the regulation.", "by": "Ryan",
   "from": {"judgment": "jdg_...", "case": "correction-..."}, "status": "active",
   "created": "2026-10-19T10:00:00Z", "retired_at": null, "retired_reason": null}]}}
```

`spec/method-learned.schema.json` is its schema. The file is part of the bundle and the manifest. A file that does not match the schema stops the run before any step.

Before a `call` or `agent` step runs, the runtime selects the active rules of that step:

- A rule with `when: null` always applies.
- One model call on the step's own model profile decides the others. Its input is `{inputs, conditions: [{id, when}]}`; its output is the list of ids that apply. Without conditional rules, there is no call.

The rules that apply are added at the end of the step's prompt under "Rules learned from corrections:". A `learned.applied` event records `{step, iteration, considered, applied}` (rule ids). A retired rule never applies.

The step's key, for replay and for reuse, includes the active rules of that step only, so a rule changes nothing for other steps. In a replay, the selection call runs only for a step that runs live.

## Loops and stopping

- `when` references a boolean. False skips the entire step. Skipped outputs do not exist; a consumer fails if it requests one.
- `each: {item: inputs.items}` runs once per item, in order. One collection alias is supported. Each output becomes a list in the original item order. An empty collection produces empty output lists.
- `concurrency: N` (1 or more) with `each` runs up to N items at once; the configuration limit `max_concurrency` (default 8) caps it. The step cannot use `ask`, `changes`, or `effects`. Outputs keep item order. A failed item does not stop the others: the running and queued items continue to their end, and then the step fails. `failure.iteration` is the first failed item and `failure.failed_iterations` lists every failed item. Accepted items stay in the checkpoint, and resume (with `--retry` for the failed item) runs only the failed and unfinished items.
- `repeat: {max_iterations: 5}` performs exactly five accepted invocations.
- `repeat: {max_iterations: 5, until: done}` checks a boolean step output after each accepted invocation. It stops when true. Reaching the limit without true fails the step. The last accepted state remains in the checkpoint.

Repeated inputs bound to state are refreshed each iteration. Other upstream values are fixed. Repeat returns the final accepted outputs; each returns collected lists. They cannot be combined. Multi-step loop bodies and parallel shared-state execution are not included.

`ask` creates a `needs_input` record and exits. Resume with `--human FILE` containing the actual human answer as shown below. The runtime does not generate a human answer.

## Limits and accounting

Operator configuration can override the finite default run limits: one hour, 100 model requests, 100 step invocations, 200 tool calls, 16 MiB each for input and output, and 8 concurrent items per step. A missing configuration uses the local Codex agent as model `default`. Custom scripts, tools, and models still require their configuration. Model requests and tool calls may be zero. A Method cannot increase those caps.

A model-using step can override `max_model_requests`; an agent-using step can also override `max_agent_turns`. A method/3.4 document's `limits.step` (or configuration `step_defaults`) can change the defaults; document `limits` set the run caps before configuration limits. Action and check share these limits and `timeout_ms` for each invocation. For the direct API backend, one agent turn is one model response. Repeated invocations share the run caps. For a direct API agent, the runner does not dispatch a tool when no follow-up model request or agent turn remains.

Direct API provider calls retry a rate limit or server error up to three attempts in all; each attempt is a model request. Codex manages its own internal requests; script-internal provider calls are also outside this accounting. Usage from completed provider responses is recorded; unavailable usage remains unknown. `cost_usd` is null because this release does not calculate prices or enforce a monetary budget. Request counts and output-token limits are resource caps, not a dollar guarantee. The operator must decide the spending allowance before live runs.

Run `elapsed_ms` starts after document/configuration validation, initial-value checks, and runtime resolution. It includes bundle capture, execution, checks, and recording. Measure CLI wall-clock time separately when comparing full startup overhead. Game time and pause settings belong to the game adapter; this runner does not control or pause simulation.

## Files, traces, and recovery

`files` explicitly lists additional helper/dependency files. Direct script and tool entrypoints, and `learned.json` when it exists, are included automatically. Files are copied into the run's bundle and hashed. Relative paths cannot escape the source directory, including through symlinks. Large model weights should be external with their version/hash supplied through an explicit input or locked helper dependency; there is no managed model registry.

The runner verifies bundle hashes before each script execution. It records the Method and configuration hashes, runtime binary hashes, inputs, candidate outputs, state changes, checks, model requests/responses, tool dispatches/results, errors, and timestamps. User-supplied model aliases resolve to the recorded settings. Hosted model weights can still change behind a provider identifier.

File outputs use `{path, sha256}`. Write them beneath `METHOD_OUTPUT_DIR`; paths are resolved relative to that artifacts directory. The runner checks their hashes. Imported input files are operator-supplied dependencies and are not automatically copied; list required policy files in `files`.

Generic run records are private local artifacts by default (directory mode 0700, files 0600). Known configured environment-secret values are redacted from traces and result files when at least four characters long. This is a convenience, not a comprehensive secret detector. State checkpoints contain actual state values; keep state and inputs free of credentials. Do not publish raw run directories without review.

Failures do not trigger automatic retries, except that a classification or model request that the service could not answer (HTTP 429 or 5xx, or an unavailable or timed-out classification service) is tried three times in all, and a `call` or `agent` step whose check does not pass gets one more attempt. A stopped run (`failed` or `needs_input`) has one failure record, written once, in `summary.json` and in the `run.failed` event:

```
failure: {
  owner,             // method_code | agent_work | outside_service | limit | setup | needs_you | method_platform
  code,              // the error code, such as check_failed, invalid_output, provider_error, timeout, usage_limit
  headline,          // one sentence: what happened and where, with names from the Method file and numbers only
  step, step_name,   // the step ID and its name, or null
  iteration,         // 0-based; the first failed task; null outside a step
  failed_iterations, // every failed task of a parallel each step; [] otherwise
  total,             // the number of tasks of an each step, or null
  phase,             // action | check | effect | tool | setup | null
  check_name,        // reading.check_name when the phase is check
  next: {action, text, command?}, // fix_method | run_again | raise_limit | fix_setup | answer | report_bug
  evidence,          // a list of text; may contain run content
  details,           // the raw message and validator text; may contain run content
  diagnostics?       // the last 20 stderr lines, only when a process failed
}
```

The owner says whose problem it is: the Method's code (a script, check, tool, observer, or judge returned data in the wrong form or exited with an error), the agent's work (a model or agent returned data in the wrong form, or a declared check did not pass), a service outside Method (after the retries), a limit, the setup (a secret, model, tool, connection, run lock, or resume mismatch), an answer that a person must give, or a problem in Method itself. Each owner has one headline template and one next action. When Claude Code or Codex stops at the usage limit of the person's plan, the failure has owner `limit` and code `usage_limit`; its headline says that it is a usage limit, with the agent's own message, and its next action is `run_again` after the limit resets. Running again reuses the steps that finished, by [step reuse](#reuse-unchanged-steps). The headline and `next.text` never contain inputs, outputs, prompts, or URLs. A data error names the producer, the field, the kind of value found, and the kind expected, for example "the check script check.mjs returned evidence[0] as an object, but it must be text". A run that cannot start (an invalid Method, a missing secret, a locked run) rejects with an error whose `failure` is the same record.

Each agent attempt has its own folder in the run's `artifacts/`: `claude/attempt-*`, `codex/attempt-*`, `session/attempt-*` for a session, or `model/attempt-*` for a `call` or `agent` step that the runtime sends to a model API. A Claude Code, Codex or session folder keeps `prompt.md` (the prompt it received), `events.jsonl` (the agent's own event stream) and `stderr.log`. Every attempt folder gets `transcript.jsonl` when the attempt ends, whether it succeeded or failed: the attempt in one format for every agent, one entry per line, `{i, role, kind, text, tool, path, raw_ref, inferred?}`. `role` is `user`, `assistant`, `tool` or `system`. `kind` is `prompt`, `message`, `thinking`, `tool_call`, `tool_result`, `file_read`, `file_write`, `command`, `search`, `plan`, `error` or `result`. `text` is the full text, never clipped. `raw_ref` names the source: `prompt.md`, `events.jsonl:LINE` in the attempt folder, `result.json` (`last-message.txt` for a Codex session), or `run:SEQUENCE`, the event of the run's `events.jsonl` with that `sequence` (the model request and response of a model step). `inferred: true` marks a guess, such as a file that a Codex shell command read. Configured secret values are redacted from the transcript, as in the run events. These records are not the step's output: a case's tested output leaves them out.

`events.jsonl` events that a person reads carry `message`, one plain sentence: `run.started`, `run.completed`, `run.failed` (the headline), `step.started`, `step.accepted`, `step.retry`, `check.completed`, `tool.dispatched`, `tool.completed`, `tool.failed`, `tool.standin`, `learned.applied`, `human.required`, `effect.observed`, and `notice`. Tasks are 1-based in text ("task 5 of 12") and 0-based in `iteration`. `step.started` of an `each` step has `total`, the number of tasks. A `notice` event (`{step?, iteration?, key, kind, message, attempt?, attempts?}`) records a problem that the run handles itself: a retry (`kind: retry`), an error-type or warning-type event in the Codex or Claude Code event stream (`kind: agent`, with the agent's own message), or 80% use of a run or step limit for time, model requests, tool calls, or invocations (`kind: limit`, once per limit). `key` is `STEP:ITERATION:KIND:NAME`, the same for each repeat of the same problem, so a reader shows the newest one. Lines that an agent writes only to its standard error are not notices.

To continue the same run with its original files, resume:

```sh
method run task.method --run-dir runs/example --resume
# After inspecting an unfinished action and its external effects:
method run task.method --run-dir runs/example --resume --retry STEP:ITERATION
```

`checkpoint.json` saves the execution ID and device name, accepted iterations, typed state, inputs, runtime identity, active dispatch, and cumulative usage. Accepted work is reused, including each/repeat outputs. Method (its content digest, which leaves out `id`), configuration, runtime executable, and bundle hashes must match. Accepted file outputs are verified again. Run time excludes time while stopped; consumed execution time and request budgets do not reset. Completed runs return their saved result.

An unfinished invocation requires explicit retry. A stopped `ask` accepts `--human JSON` with `{steps: {"STEP:ITERATION": {outputs: {...}}}}`; checks still run. The runner does not guess whether an uncertain external action completed. Inspect the target first.

A process lock prevents concurrent resume. An abruptly killed process can leave `.lock`; confirm the process is dead before removing it. An active lock must stay in place. Inspect `events.jsonl`, `summary.json`, and `checkpoint.json` before recovery.

For new evidence or changed inputs, use a new run. `--state prior-run/state.json` imports state but starts the method from the beginning. An application ledger of evidence hashes can select only changed work. This is separate from resuming a stopped run.

### Reuse unchanged steps

A host can pass earlier run directories as `cacheFrom`. Before an iteration runs, the runner computes its key: the step definition without display text (`name`, `purpose`, `reading`), the resolved inputs (including the `each` item), the model profiles, classification setup, tool definitions, and runtime profiles that it uses, and, for a step that runs a script, its own entrypoints and every bundle file that is not another step's entrypoint or `learned.json` (the runtime does not trace which helper files a script imports), and the step's own active learned rules. A session's key also covers the content of each file in its room folder. A host can number the repeats of the same work with the run option `repeat` (0 when omitted): each repeat is a separate run, so a step is reused only from an earlier run of the same repeat. When an earlier run accepted an iteration with the same key, the runner copies its declared file outputs (and the assets of a `method-website` file), checks their hashes, and accepts its outputs without executing anything. Its `step.started` and `step.accepted` events have `reused_from`, and the summary's `reused` counts the reused iterations of each step.

A step is never reused when it has `ask` or `effects`, changes state or an external system, or uses a tool with effects. A step that reads `run.started_at` gets new inputs on each run, so it runs again. `fresh: true` runs every step; `fresh: [STEP]` runs those steps again even when a match exists. A fix to one step therefore needs no special command: run the Method again, and the steps whose definition and inputs did not change are reused. Steps after a changed step are reused when their inputs are the same as before.

## Validation evidence

The test suite executes real local scripts and the complete model/tool orchestration against deterministic response fixtures. The HTTP request format, error handling, output validation, and accounting are tested with a mocked HTTP transport. No live billed model call or game performance result is claimed by those tests.

## Parsing and API contract

The SDK and runtime use the same parser and document validator. Parsing permits bounded YAML aliases (maximum expansion count 20), rejects duplicate keys and documents over 2 MB, and preserves text whitespace. File values require exactly `path` and a lowercase 64-character `sha256`. Invalid documents throw `MethodValidationError` with the code of the first error issue (for example `invalid_method`, `invalid_prompt`, `unknown_model`, or `unsupported_format`) and the issue itself as `issue`. `methodIssues(document, options)` returns every [issue](#issues); `validateMethod` throws its first error. `documentForDigest(document)` returns the document without `id`, for the content digest.

The JavaScript API exports `RuntimeConfig`, `RunOptions`, and the status-based `RunResult` union. `runMethod(file, config, options)` returns completed, failed, or needs_input records. It does not perform the product CLI's account sync or automatic environment preparation.

`run.started` records the execution ID and device name. `summary.json` and the run result carry `execution_id`, also while the run is running. The summary preserves `execution_id`, `started_at` and `device_name` from the original run on resume.

The executor records its package version as `executor_version` in the checkpoint, manifest, and run start/resume events. Resume requires that exact executor version before setup or execution. A checkpoint without this field requires its original SDK/runtime installation. These checks are separate from script executable hashes. Completed results can still be uploaded without execution.

## Browser connections

An agent can select `browser: environment.NAME`, where NAME is a browser
environment. The host supplies that connection's standard browser controls.
Omitted `tools` means no custom tools. Interactive controls require the
connection in `changes` and a declared check. Browser sessions and credentials
are supplied by the host, outside the Method.

### Run labels

Optional `run_label` selects a saved scalar value, such as `inputs.topic` or
`steps.prepare.outputs.plan.date`. The reference must end at a declared text,
number, or boolean field. Step references must select a step without `each` or
`repeat`; selecting one invocation from a repeated step is not supported.
Choose a short, non-sensitive value; it will be visible in run lists and navigation.
Viewers use the current method definition with each run's recorded inputs or
step outputs. They never apply current defaults to historical runs. Missing,
blank, wrongly typed, or ambiguous values fall back to the run timestamp.
Before a step saves its output, its run uses the timestamp. Whitespace is collapsed
and labels are limited to 160 characters. The timestamp remains available for
repeat runs. This field changes display only; historical execution versions and
saved evidence are unchanged.
