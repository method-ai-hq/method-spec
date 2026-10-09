# Method reference

Implemented by `@withmethod/runtime` 0.10.0. The full Method SDK uses this runtime at a pinned Git revision. New methods use this format under the same Method product and command.

Use `format: method/3.3` for new documents. Existing `method/3.1` and `method/3.2` documents retain their validation rules. Method 3.3 adds effect contracts: an external change is confirmed by an observer, not by the action's receipt. The machine-readable grammar is [method-3.schema.json](method-3.schema.json). Operator configuration uses [runtime-config.schema.json](runtime-config.schema.json). The validator also checks references, dependencies, data declarations, loop conditions, and effects; JSON Schema alone is insufficient.

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
method observe RUN_DIR
method test example.method
```

The runtime package installs no command. Contributors can run `node src/cli.js` in this checkout. The contributor harness accepts `--agent codex|claude`; the SDK also supplies account commands, automatic setup, and background workers.

`validate` checks the Method and, when supplied, the configuration grammar. `run` additionally resolves profiles, tools, capabilities, environment bindings, and bundle files. A validation pass alone does not establish executable setup or task correctness.

`run` prints status, elapsed time, model request count, and the run directory. Read `result.json` in that directory for the result. Exit codes are 0 for completion, 1 for failure, 2 for a human-input request, and 3 for an unconfirmed run: every step finished, but an observer could not confirm an external change by its horizon. A new run needs a new directory. Use `--resume` to continue the same saved run.

## Document and data

Root fields are `format`, `name`, `goal`, `inputs`, `state`, `environment`, `files`, `steps`, `result`, and optional plain-text `run_prompt` for the outside agent. `run_prompt` does not expand variables. Step `reading` fields provide display text and do not change execution. Only format, name, goal, steps, and result are required.

Inputs and state declarations have a type and optional description and default. Supply missing initial values through `--inputs` and `--state`, each pointing to a JSON object. Unknown or wrongly typed values fail before any operation. State is saved as one atomic `state.json` checkpoint in the run directory. Method 3 does not use Method 2's per-state `file` field.

Types are `text`, `number`, `boolean`, `record`, `list`, and `file`. Records require `fields`. Lists require exactly one of `items` or `fields`; the latter describes each record in the list. Nested fields may use a short type name or a full shape. All declared fields are required and extra fields fail. Defaults must meet the declared type.

References such as `inputs.target`, `state.count`, and `decision.goal` connect data. `run.started_at` contains an ISO timestamp. Named step outputs must be unique across the Method. Reserved namespaces cannot be reused as output names. Data references determine execution order; `after` adds explicit dependencies. Cycles fail validation. Independent steps currently run sequentially.

The `environment` declarations describe connections. Operator configuration supplies a non-secret string for each connection, such as a local endpoint. Bind these values through `in` where needed. Credentials belong in environment variables, not in the Method or configuration data.

## Executable steps

Script actions require a nonempty `name` and `purpose` in Method 3.2. Other step purposes and all limit overrides are optional. Default step limits are ten minutes and 32 model requests or agent turns; explicit limits override these values. Use exactly one of `do` or `ask`. The `do` forms are:

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

`in` maps local aliases to references. `out` declares output values. The process or model returns a JSON object whose keys match `out` exactly, plus the state replacements described below. Inputs are supplied as JSON data. Model and human prompts can insert declared scalar inputs with `{{name}}` or `{{customer.name}}`. Agent check prompts use `{{inputs.name}}` and `{{outputs.answer}}`. Only text, finite numbers, and booleans can be inserted. Unknown references fail validation; missing runtime values fail before model execution. Escape literal opening braces with a backslash in a YAML block scalar. Values are inserted once without expression evaluation or recursive expansion. Command arguments, labels, tool descriptions, and run_prompt are not templates.

### Classification

Classification is available in Method 3.2:

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

Each invocation reserves one model request and calls the provider once. Requests and responses are bounded to 64 KiB or the smaller configured byte limit. The invocation deadline and cancellation apply. Responses must match the saved provider and model. Invalid responses fail without repair or automatic retry. The result follows the existing candidate, check, and acceptance path. `model.request` and `model.response` carry `kind: classify`, request ID, provider, and model; the response adds confidence, usage, and duration. A reported `usage.cost` adds to the run's `cost_usd`. Missing usage remains unknown.

### Scripts

In Method 3.2, give each script action a name and purpose that describe its rules, result, and external changes. Describe each top-level output. Describe script checks in `reading.check` and script tools in their configured `description`. Review these descriptions whenever behavior changes.

Split scripts where retrying one operation could repeat another completed action. Keep calculations together when they serve one decision. Return the decision rule or external receipt as inspectable output. For external writes, describe how to check uncertain completion and use the service's duplicate-prevention key when available.

Script actions and checks receive `METHOD_OPERATION_ID`: `mop_` followed by SHA-256 of the JSON array `[execution_id, step_id, iteration, phase]`, where phase is `action` or `check`. The saved execution ID is a UUID. Explicit retries reuse this operation ID; new runs, iterations, and phases have distinct IDs. The variable is reserved and cannot be declared as a secret. Tool call identities keep their existing behavior.

Runtime profiles name an executable, optional fixed arguments, and a declared version. Commands use argument arrays without shell expansion. Node, Python, or another JSON-speaking executable can be registered.

A script reads one JSON object on standard input, writes one JSON output object on standard output, and sends diagnostics to standard error. It runs from a saved copy of the bundle. Scripts receive PATH, LANG, METHOD_OUTPUT_DIR, METHOD_ENVIRONMENT (the configured connection map as JSON), the declared secrets, and METHOD_PROGRESS_FD when a progress pipe is attached. The executor hashes the resolved runtime binary and records the operator's declared version.

The operator must set `allow_local_processes: true`. These are trusted local processes, **not an OS sandbox**. They can access resources allowed to the operating-system user.

**Observed effects.** The runner records what each Python and Node script process did as `observed_effects: {network, reads, writes, env, runs}` on its `process.completed` or `process.failed` event; an action's value is also on `step.accepted`, and a reused iteration copies it from its source run. `network` lists hosts (never URLs or query strings), `reads` and `writes` list paths (bundle files relative to the bundle, output files as `$METHOD_OUTPUT_DIR/PATH`), `env` lists variable names that the script read or set (never values; `METHOD_*` names are left out), and `runs` lists program names (never arguments). Each list is sorted, unique, and at most 200 entries; `truncated: true` says that a list was cut. Interpreter, standard-library, `site-packages`, `node_modules`, `/dev`, and the run's own internal files are left out. Python is observed with an audit hook loaded through a `sitecustomize` module on `PYTHONPATH` (it runs any `sitecustomize` it hides); Node with a `--require` preload (`diagnostics_channel`, `fs`, `child_process`, and a `process.env` proxy). Both remove their variables before the script starts and write to a file at exit, never to standard output. Another runtime, a process that ends without exit handlers (a kill, `os._exit`), or Python with `-E`, `-I`, or `-S` gives `{unavailable: REASON}`; the step still runs. This is a record, not a sandbox: native extensions, raw system calls, and child processes' own effects are not observed.

**Model requests are steps.** Each model or classifier request is its own `call`, `agent`, or `classify` step, with its prompt in the Method, so that it is recorded and can be changed and compared. Preflight refuses a Method whose script files (declared `files` and entrypoints) name a model API host together with a model request endpoint (`completions`, `/messages`, `/responses`, `systemone`, `generateContent`, `embeddings`) (hosts: `openrouter.ai`, `api.openai.com`, `api.anthropic.com`, `api.typesafe.ai`, `generativelanguage.googleapis.com`, `api.deepseek.com`, `api.groq.com`, `api.mistral.ai`, `api.together.xyz`, `api.fireworks.ai`, `api.cohere.com`) or import a model client library (`openai`, `anthropic`, `@anthropic-ai/sdk`, `litellm`, `langchain`, `@ai-sdk/*`, and similar), with code `model_call_in_script`. Fixture files are not checked. A host that a script builds at run time is not found; the check is not a sandbox.

#### Secrets

A Method declares the secrets that its scripts need by name and purpose. It never holds their values:

```yaml
secrets:
  ARCHIVE_TOKEN: Read-only token for the post archive.
```

Names use capital letters, digits, and underscores. `PATH`, `LANG`, `HOME`, and names that begin with `METHOD_` are reserved. The host supplies the values (runtime option `secrets`); without it, the process environment does. Every script step receives every declared secret. A missing value fails preflight with `missing_secret` and lists the names in `missing`; no step runs. Model profiles and classification find `api_key_env` in the same way.

`run_data: account` (the default) or `run_data: device` tells a signed-in host where to keep run content. The runtime keeps all run records locally either way.

On timeout or process exit, the runner kills the process group on POSIX systems. The first release is tested on macOS and Linux. Windows process-tree termination and runtime compatibility are not claimed.

### Models and agents

Explicit model profiles take priority. Missing profiles use an explicit `--agent`, the configured default, the host's hosted model (`hostedModel`), the identified calling coding agent, or the sole installed supported agent. If both Codex and Claude are available without a choice, execution requests input. Both use their normal sign-in. The selected profiles remain fixed on resume. Codex starts a fresh process with approval and sandbox prompts disabled; it is trusted local execution. A supplied configuration must allow local processes. Without a config file, the CLI enables that default local path.

The temporary Method MCP bridge exposes only the step's declared Method tools. Codex also retains its built-in and installed tools. Empty `tools` does not mean that Codex has no tools. Both `call` and `agent` use a Codex process with a structured final output on this backend. Internal Codex model requests and tools are not governed by Method's direct API request/turn counters.

Method enforces the Codex process deadline, prompt/output size, and Method bridge tool-call cap. It saves prompts, output schema, JSON events, stderr, and reported usage. It does not edit persistent Codex settings or enforce a monetary budget.

#### Direct API backends

Three direct providers are available. Each profile specifies the exact model identifier, `api_key_env`, and a required `max_output_tokens`. Each backend has one fixed endpoint; a profile cannot name another URL. No model is silently substituted. Use a model supporting strict structured outputs; incompatible settings return a recorded provider error.

| Backend | Endpoint | Optional setting |
|---|---|---|
| `openai-responses` | OpenAI Responses API | `reasoning_effort`: none, minimal, low, medium, high, xhigh |
| `anthropic-messages` | Anthropic Messages API | `effort`: low, medium, high, xhigh, max |
| `openrouter-chat` | OpenRouter chat completions | `reasoning_effort`: minimal, low, medium, high |
| `method` | The host's `hostedModels.request`: the same request as `openrouter-chat`, sent through the signed-in Method account. It needs no key; `max_output_tokens` is optional (16000). | — |

The output schema goes to each provider's strict structured output. OpenRouter requests require providers that support the requested parameters and name no fallback models. Anthropic tool turns keep the assistant content, including thinking blocks, unchanged. `model.request`, `model.response`, and `model.error` record the backend. Usage is recorded as input and output tokens; Anthropic input includes cache reads and writes. A response that reports `usage.cost` adds it to the summary's `usage.cost_usd`.

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

Output types are always checked. An omitted task check is recorded as `unchecked`, not `pass`. In `method/3.1` and `method/3.2`, an external `changes: [environment.game]` declaration requires an explicit check. In `method/3.3` it requires effects (next section); a check then covers only outputs and state. A check of an action's completion does not establish that it was strategically useful.

## Effect contracts

A success status, receipt, or returned ID shows only that a service accepted a request. In `method/3.3`, the runtime confirms external changes by reading the changed system, and decides from those observations whether the run is complete.

**Local files need nothing.** For each `files` connection in a step's `changes`, the runtime lists the folder (or the one file) before and after the step: size and modification time, skipping `.git`, `node_modules`, `.venv`, `__pycache__`, `sensitive` and `.method-runs`. A listing stops at 20,000 files or 3 seconds; such a folder is recorded once as `unobserved` and is not listed again in that run. It records the changed files in the ledger (`STEP/ITERATION/files:NAME`) and keeps a copy of up to 20 written files of at most 1 MB each under `effects/files/`, so the run record shows what the step wrote even after a later run overwrites it. When a text output of the step is a path inside the folder (an absolute path, or a relative value with no spaces that has a `/` or a file extension), that file, or a file inside that folder, must have been added or changed: "the step returned `out/weekly.md`, but that file did not change" fails the run with `effect_contradicted` before later steps start. A step that changes nothing, and claims no file, is recorded as `unchanged` and does not fail. 

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

Rules in `method/3.3`:

- `changes` defaults to none. It is a declaration: the runtime cannot see what a trusted local script does.
- A step that changes a connection other than `files` has at least one effect, or a `no_effect_reason`: a plain sentence that says why no observer confirms the change, for example "Reads pages only; submits and posts nothing." for a browser step. The run records each waiver (`effects.waived` event and `unobserved_changes` in the result), so a reader sees which external changes nobody observed. Use one of the two, not both. A waiver for a step that changes only files connections is refused, because those are observed automatically.
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
| `failed` (`effect_contradicted`) | An effect is contradicted. No `result.json` is written. | 1 |
| `unconfirmed` (`effect_unconfirmed`) | No contradiction, and an effect is `unknown` at its horizon. `result.json` is written. | 3 |
| `completed` | Every other case. `effects.pending` counts effects still before their horizon. | 0 |

The summary and the run result carry an `effects` summary. Before the run reports, the runtime makes every observation that is due within `limits.effect_wait_ms` (operator configuration, default 300000, five minutes) and within the run deadline, so short schedules finish inside the run. `method observe RUN_DIR` makes the later observations that are due; `method observe --pending ROOT` does this for each run under ROOT with open effects. Schedule it, for example hourly. It runs only observers and judges, appends to the ledger and to `events.jsonl`, and records `run.status_changed` when new evidence changes the status, for example from `completed` to `failed` after a late bounce.

**Blocking and retry.** With `blocking: true`, the runtime waits for the first observation before later steps start. A contradiction then stops the run with `effect_contradicted`, and the step stays unaccepted, so resuming it needs `--retry STEP:ITERATION`. With `retry: idempotent` as well, the runtime first repeats the action once with the same `METHOD_OPERATION_ID` and observes again. Declare `idempotent` only when the service drops a repeated request with the same key. The runtime never repeats an action because an effect is `pending` or `unknown`.

**Failed actions.** When an action with effects fails, for example by a timeout or a crash, the runtime observes each effect at once with `action_outcome: indeterminate`. The failure's recovery text lists the verdicts. A `confirmed` verdict means the change happened, and the action must not be retried.

Limits: observers are trusted local processes, not an OS sandbox. A read can have side effects (an IMAP fetch can mark mail as read). The separation of actions and observers is least privilege, not proof.

## Recorded cases

A case is a recorded run plus an expectation about it. It turns a correction into a test that every later version must pass. Cases live in `cases/ID/` next to the Method file and belong to that file name.

```sh
method case new task.method --id sources-named --run runs/bad --passing-run runs/fixed --note "The report doesn't say which source backs each point." --rubric "Every point names the source file that supports it." --rubric "The report is under 300 words."
method test task.method
method case retire task.method old-rule --by new-rule --reason "Policy changed on 2026-10-01."
```

A case keeps the copies of the files that its source run wrote, and a rubric judges a path inside a files connection by that run's copy, not by the file on disk now.

`--run` is the run that went wrong. The case must **fail** on it; otherwise the case does not capture the problem, or the note does not match what the run did, and `case new` refuses it (`case_not_red`). `--passing-run` is the run that the person accepted after the fix; the case must **pass** on it (`case_not_green`). A case with only `--passing-run` pins behaviour that is already right.

`case new` reads the run's events and saves `recording.json` (each accepted iteration's inputs and outputs, a key for each step, the run's inputs and initial state, and the run's effect observations), the declared files of its steps, and `case.json` (note, author, source run, expectations, `runs`, `min_pass`, retention date). `--observations FILE` adds observations by effect key (`STEP/ITERATION/NAME`). `--redact FILE` maps recorded text to replacement text everywhere in the recording and the note. Cases cannot be built from runs under `sensitive/`.

Expectations (`--expect` is a JSON list):

- `{"kind": "equals", "ref": "outputs.report", "value": ...}` compares a step output, or `result`.
- `{"kind": "status", "in": ["failed"]}` checks the run status.
- `{"kind": "effect", "effect": "send/0/delivered", "verdict": ["contradicted"]}` checks an effect verdict.
- `{"kind": "predicate", "runtime": "node", "entrypoint": "check.mjs"}` runs a script on `{status, code, result, outputs, effects}` that returns `{"pass": true|false, "reason": "..."}`. The script is copied into the case.
- `{"kind": "rubric", "ref": "outputs.report", "criteria": [{"id": "c1", "text": "..."}]}` judges text, a record (as JSON), or a text file output against plain sentences. `--rubric SENTENCE` (repeatable) makes one; `--ref` defaults to the Method's result. `"context": ["outputs.material", "inputs.claim"]` (`--context REF`, repeatable) gives the judge other values to check against, such as the sources or the person's words; the judge reads them but does not judge them, and quotes come only from the judged value.

Each expectation can carry `text`, a plain-language statement for people. A case is refused if its non-rubric expectations pass on an empty result: such a case cannot detect the error.

**Rubric judge.** A model judges each criterion and quotes the words that decide it, or gives an empty quote when no single passage decides it (for example, when something must be absent). A quote that is not in the value fails the criterion. By default the judge runs 3 times and a criterion passes only when every vote passes. The judge uses the model profile `judge` when the configuration has one, otherwise the default agent. Operator configuration can change `rubric: {judge_runs, classify_threshold, max_value_bytes}`. Judgments are cached by value, criteria, and judge profile under `~/.cache/method/judgments` (or `METHOD_CACHE_DIR`). At `case new`, the judge's verdicts on the run that went wrong and the pass on the accepted run are saved as `examples.json`. When a classification provider is configured, the faster classification judge is used for a criterion only when it agrees with those examples, including at least one pass and one fail; otherwise the model judge stays.

**Replay.** `method test` runs the Method once per case run, with the recorded inputs. A step whose key (its definition, script files, model profiles, and tools; not its name, reading, purpose, or effects) and inputs match the recording returns the recorded outputs and records `step.replayed`. Other steps run. Each `files` connection that a step writes is replaced by a scratch copy of the real folder (up to 5,000 files and 100 MB; a larger folder makes the case `unverifiable`), so a changed step that writes files runs safely and the real folder is not touched. Folders that are only read stay as they are. A path in a step's inputs is compared with the path that the recorded run saw. When every expectation refers to `outputs.NAME`, only the steps that produce those outputs, and the steps they depend on, run. A changed step that asks a person or changes another kind of connection cannot run in a test: the case is `unverifiable`. Effects are judged on recorded observations only; observers never read the live system in a test. Without recorded observations, an effect is `not_replayed`. With them, an absence of evidence stays `pending`.

**Results.** Every active case must pass. Without `--runs`, a case runs once when only scripts run, and three times when a model step runs live, because a model can answer differently each time; every run must pass. A case that passes some runs and fails another is reported as `unreliable`: the Method does not follow the rule every time. With `--runs N --min-pass M`, the case passes when at least M of N runs pass. A case stops as soon as its result is decided. The report's `totals` give the time, the model steps that ran live, and the judge calls that were not cached. Cases run 4 at a time; cases whose recorded steps differ from this version run first. Each case reports `duration_ms`. With `--baseline OLD`, each case also runs on the old version, to show what the change fixed or broke:

| Verdict | Meaning | Blocks the gate |
|---|---|---|
| `pass` / `fixed` | Passes on the new version | No |
| `regression` | Passed on the old version, fails on the new one | Yes |
| `fail` | Fails | Yes |
| `unverifiable` | Cannot be replayed on this version | Yes |
| `not_red` / `not_fixed` | A `--new` case passed before the change, or still fails after it | Yes |

`method test` exits 0 when no case blocks the gate. Retired cases stay on disk with their reason and the case that superseded them, and are not run. Cases past their retention date are listed as expired.

## Loops and stopping

- `when` references a boolean. False skips the entire step. Skipped outputs do not exist; a consumer fails if it requests one.
- `each: {item: inputs.items}` runs once per item, in order. One collection alias is supported. Each output becomes a list in the original item order. An empty collection produces empty output lists.
- `concurrency: N` (1–32) with `each` runs up to N items at once; the configuration limit `max_concurrency` (default 8) caps it. The step cannot use `ask`, `changes`, or `effects`. Outputs keep item order. The first failure stops the other running items and fails the step; items accepted before it stay in the checkpoint, and resume (with `--retry` for the failed item) runs only the unfinished items.
- `repeat: {max_iterations: 5}` performs exactly five accepted invocations.
- `repeat: {max_iterations: 5, until: done}` checks a boolean step output after each accepted invocation. It stops when true. Reaching the limit without true fails the step. The last accepted state remains in the checkpoint.

Repeated inputs bound to state are refreshed each iteration. Other upstream values are fixed. Repeat returns the final accepted outputs; each returns collected lists. They cannot be combined. Multi-step loop bodies and parallel shared-state execution are not included.

`ask` creates a `needs_input` record and exits. Resume with `--human FILE` containing the actual human answer as shown below. The runtime does not generate a human answer.

## Limits and accounting

Operator configuration can override the finite default run limits: one hour, 100 model requests, 100 step invocations, 200 tool calls, 16 MiB each for input and output, and 8 concurrent items per step. A missing configuration uses the local Codex agent as model `default`. Custom scripts, tools, and models still require their configuration. Model requests and tool calls may be zero. A Method cannot increase those caps.

A model-using step can override `max_model_requests`; an agent-using step can also override `max_agent_turns`. Configuration `step_defaults` can change the defaults. Action and check share these limits and `timeout_ms` for each invocation. For the direct API backend, one agent turn is one model response. Repeated invocations share the run caps. For a direct API agent, the runner does not dispatch a tool when no follow-up model request or agent turn remains.

Direct API provider calls have no automatic retries. Codex manages its own internal requests; script-internal provider calls are also outside this accounting. Usage from completed provider responses is recorded; unavailable usage remains unknown. `cost_usd` is null because this release does not calculate prices or enforce a monetary budget. Request counts and output-token limits are resource caps, not a dollar guarantee. The operator must decide the spending allowance before live runs.

Run `elapsed_ms` starts after document/configuration validation, initial-value checks, and runtime resolution. It includes bundle capture, execution, checks, and recording. Measure CLI wall-clock time separately when comparing full startup overhead. Game time and pause settings belong to the game adapter; this runner does not control or pause simulation.

## Files, traces, and recovery

`files` explicitly lists additional helper/dependency files. Direct script and tool entrypoints are included automatically. Files are copied into the run's bundle and hashed. Relative paths cannot escape the source directory, including through symlinks. Large model weights should be external with their version/hash supplied through an explicit input or locked helper dependency; there is no managed model registry.

The runner verifies bundle hashes before each script execution. It records the Method and configuration hashes, runtime binary hashes, inputs, candidate outputs, state changes, checks, model requests/responses, tool dispatches/results, errors, and timestamps. User-supplied model aliases resolve to the recorded settings. Hosted model weights can still change behind a provider identifier.

File outputs use `{path, sha256}`. Write them beneath `METHOD_OUTPUT_DIR`; paths are resolved relative to that artifacts directory. The runner checks their hashes. Imported input files are operator-supplied dependencies and are not automatically copied; list required policy files in `files`.

Generic run records are private local artifacts by default (directory mode 0700, files 0600). Known configured environment-secret values are redacted from traces and result files when at least four characters long. This is a convenience, not a comprehensive secret detector. State checkpoints contain actual state values; keep state and inputs free of credentials. Do not publish raw run directories without review.

Failures do not trigger automatic retries, except that a classification the service could not answer (HTTP 429 or 5xx, or an unavailable or timed-out service) is tried three times in all. A failed run's summary gives `code`, `error`, a `fix` sentence, and, when a step was running, `failed_step`, `iteration`, and the last 20 lines of its `diagnostics`. To continue the same run with its original files, resume:

```sh
method run task.method --config runtime.json --run-dir runs/example --resume
# After inspecting an unfinished action and its external effects:
method run task.method --config runtime.json --run-dir runs/example --resume --retry STEP:ITERATION
```

`checkpoint.json` saves the execution ID and device name, accepted iterations, typed state, inputs, runtime identity, active dispatch, and cumulative usage. Accepted work is reused, including each/repeat outputs. Method, configuration, runtime executable, and bundle hashes must match. Accepted file outputs are verified again. Run time excludes time while stopped; consumed execution time and request budgets do not reset. Completed runs return their saved result.

An unfinished invocation requires explicit retry. A stopped `ask` accepts `--human JSON` with `{steps: {"STEP:ITERATION": {outputs: {...}}}}`; checks still run. The runner does not guess whether an uncertain external action completed. Inspect the target first.

A process lock prevents concurrent resume. An abruptly killed process can leave `.lock`; confirm the process is dead before removing it. An active lock must stay in place. Inspect `events.jsonl`, `summary.json`, and `checkpoint.json` before recovery.

For new evidence or changed inputs, use a new run. `--state prior-run/state.json` imports state but starts the method from the beginning. An application ledger of evidence hashes can select only changed work. This is separate from resuming a stopped run.

### Reuse unchanged steps

A host can pass earlier run directories as `cacheFrom`. Before an iteration runs, the runner computes its key: the step definition without display text (`name`, `purpose`, `reading`), the resolved inputs (including the `each` item), the model profiles, classification setup, tool definitions, and runtime profiles that it uses, and, for a step that runs a script, its own entrypoints and every bundle file that is not another step's entrypoint (the runtime does not trace which helper files a script imports). When an earlier run accepted an iteration with the same key, the runner copies its declared file outputs (and the assets of a `method-website` file), checks their hashes, and accepts its outputs without executing anything. Its `step.started` and `step.accepted` events have `reused_from`, and the summary's `reused` counts the reused iterations of each step.

A step is never reused when it has `ask` or `effects`, changes state or an external system, or uses a tool with effects. A step that reads `run.started_at` gets new inputs on each run, so it runs again. `fresh: true` runs every step; `fresh: [STEP]` runs those steps again even when a match exists. A fix to one step therefore needs no special command: run the Method again, and the steps whose definition and inputs did not change are reused. Steps after a changed step are reused when their inputs are the same as before.

## Validation evidence

The test suite executes real local scripts and the complete model/tool orchestration against deterministic response fixtures. The HTTP request format, error handling, output validation, and accounting are tested with a mocked HTTP transport. No live billed model call or game performance result is claimed by those tests.

## Parsing and API contract

The SDK and runtime use the same parser and document validator. Parsing permits bounded YAML aliases (maximum expansion count 20), rejects duplicate keys and documents over 2 MB, and preserves text whitespace. File values require exactly `path` and a lowercase 64-character `sha256`. Invalid documents throw `MethodValidationError` with `invalid_method` or `unsupported_format`.

The JavaScript API exports `RuntimeConfig`, `RunOptions`, and the status-based `RunResult` union. `runMethod(file, config, options)` returns completed, failed, or needs_input records. It does not perform the product CLI's account sync or automatic environment preparation.

`run.started` records the execution ID and device name. The summary preserves `started_at` and `device_name` from the original run on resume.

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
