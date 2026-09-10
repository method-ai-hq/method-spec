# Proposal: Method 3

Status: design draft, 10 September 2026. Not a released schema or implemented runtime. Examples use the reserved working identifier `method/3-draft`; the final version identifier remains subject to implementation review.

## Problem and goal

The original executor uses an agent run to perform an operation and, when requested, a separate agent run to review it. That is useful for unfamiliar work. It also imposes model and process overhead on routine work.

Let the author choose how each operation runs while retaining typed data, explicit state, checks, and an inspectable record. Astra can search over these choices and their content. The format does not itself perform policy search or guarantee an improvement.

Keep the human-readable purpose of each operation. Store the code, prompts, and model references needed to execute that purpose. A saved YAML document alone is insufficient when execution depends on changing files or models.

## Three execution types

| Type | Meaning | Intended use |
| --- | --- | --- |
| `agent` | A bounded agent process that may call allowed tools. | Investigation, unfamiliar work, and adaptive action sequences. |
| `call` | One model request with a declared response shape and no tool loop. | Classification, planning decisions, and structured extraction. |
| `run` | A registered runtime executes a versioned entrypoint with typed data. | Calculations, API adapters, fast routines, exact checks, and model inference. |

Computer use is an agent capability, not a fourth execution type. A loop is control flow, not a model type. Model selection is configuration, not a separate step.

A task-specific neural network, decision tree, or other trained model can run behind `run`. A fine-tuned language model can use `call` when the provider interface supports it. The initial format does not specify training data pipelines, optimizers, GPU scheduling, or weight updates. A future training procedure can return a versioned model artifact without changing the meaning of an inference step.

## Common step contract

Retain root inputs, environment, state, steps, and result, and the existing data types. Retain step names, input bindings, typed outputs, dependencies, conditions, and declared changes.

Change `do` from text to a tagged object. Exactly one execution type is selected. Use a required plain-English `purpose` on a new-format executable step to explain its intended effect. Keep the old human `ask` form; it is exclusive with `do` and is not used in autonomous scored gameplay.

All execution types receive the same resolved inputs and must return the same declared output object. Every result is type-validated before checks or state commits. Producing valid JSON does not establish that the decision is correct.

Illustrative shape:

```yaml
purpose: Select the next production goal from current shortages.
in:
  shortages: shortages
do:
  kind: call
  model: planner
  prompt: Choose one goal from the supplied shortages and explain the choice.
out:
  decision:
    type: record
    description: The selected goal and its reason.
    fields:
      goal: text
      reason: text
limits:
  timeout_ms: 5000
```

These fields are proposed, not accepted by the existing SDK.

## Execution settings

### Agent

`do` contains `kind: agent`, a `model` profile, a `prompt`, and an explicit list of permitted tool or environment bindings. An empty list means no tools. A fresh context is the first reference behavior. State needed by another invocation must be returned explicitly.

Set both elapsed-time and agent-turn limits. A backend must reject limits or access restrictions it cannot enforce, rather than silently run with broader access. An allowlist in a prompt is not enforcement. Existing unrestricted Codex shell execution must not be described as isolated.

Persistent agent sessions can be added later if measurements require them. They introduce hidden memory and recovery costs; they are not part of the first slice.

### Call

`do` contains `kind: call`, a `model` profile, and a `prompt`. The output declarations define the requested response schema. The runner validates the returned data even when a provider offers structured output support.

One invocation makes one model request. Invalid output is a recorded failure. Automatic repair prompts or hidden semantic retries are excluded from the first slice; an author can define repair explicitly. Provider transport retries must be bounded and recorded, including uncertainty about billed usage.

### Run

`do` contains `kind: run`, a runtime profile, an entrypoint relative to the Method bundle, and optional explicit argument values. Pass arguments as an array; do not interpolate inputs into a shell command string.

The first reference transport is one JSON object on standard input and one JSON output object on standard output. Diagnostic text goes to standard error. A nonzero exit, invalid response, or timeout is an execution failure. Impose output-size limits. Resolve entrypoints inside the bundle and reject escaping paths.

`run` means script execution, not guaranteed determinism. A script may use randomness, read a changing environment, or call a model. Record those dependencies and all model use; a model invoked inside a script must not be reported as zero-cost execution.

Start with process-per-invocation. A persistent local inference process or service may later remove model-loading overhead. Do not claim low latency before measuring the complete invocation.

## Profiles and execution configuration

Methods refer to named model and runtime profiles, such as `planner` or `python`. Host configuration resolves each profile to a provider/model/settings or runtime version. Credentials and local paths remain outside the Method.

The experiment controls the available profiles and their resource caps. A candidate can select among permitted profiles. Record the complete non-secret resolved configuration and its hash with each run. Changing a profile invalidates a like-for-like comparison unless disclosed; the same alias alone does not identify the same policy.

Model names do not promise intelligence, speed, availability, or identical results. Unsupported settings fail validation or preflight. The first runner supports a small declared set of backends rather than every provider.

## Checks

Retain the existing exact check forms. Also allow an agent check and a `run` check using the corresponding execution contract. Legacy text checks migrate to an explicit agent check.

Script and agent checks receive a separate check input object containing the step inputs, candidate outputs, and permitted effect evidence. They return `status` (`pass`, `fail`, or `unknown`), a reason, and evidence references. Exact checks normalize to the same recorded result. `unknown` never becomes a pass.

An explicit checker uses the same tagged shape as `do`, for example `check: {kind: run, runtime: python, entrypoint: checks/production.py}`. The runner supplies the check input object; the step author does not add a second set of data bindings. Checkers have a fixed response contract rather than user-defined `out`. Normalize the existing ambiguous-check outcome to `unknown` during migration without changing its stop behavior.

Checks cannot declare production side effects. Their environment must support only the access needed to observe evidence. If a backend cannot enforce this, record the limitation and do not claim independent isolation.

Type validation always runs. A task check can be omitted for an intermediate step, in which case task correctness remains unchecked. A passed exact check proves only its stated property. Verifier failures are distinct from a valid verifier result of `fail`.

An operation that declares an external environment change must supply a check of observed completion or use an adapter with an equivalent recorded completion check. This can cover a bounded group of game actions; it does not require one language-model check per action. Checking completion still does not prove strategic value.

Keep three concepts separate:

1. Output shape: did the operation return the required data?
2. Local effect: did the requested action occur?
3. Task result: did the whole procedure meet the external objective?

A policy may change its internal checks during search. It cannot change the experiment's final evaluator. Checking every small game action with an agent is not required by this proposal.

## State, effects, and failure

Preserve explicit `changes`. Read a state snapshot, execute, validate outputs, run requested checks, and commit declared state changes only after the operation is accepted. If no task check was requested, record the accepted state update as unchecked.

Save candidate outputs and observed effects even when the check fails. External actions may already have occurred and cannot be rolled back by withholding a local state commit. Never blindly retry an uncertain external action. Recovery must inspect the external state or use a supported idempotency mechanism.

Operations that can conflict on a state or environment binding are serialized in the first runner. This is not a distributed transaction guarantee. A checker failure or timeout stops the operation for explicit recovery; the runner does not invent a repair policy.

## Bounded control flow

Retain `when`, `after`, and `each`. Apply them to every execution type rather than creating separate agent-loop and model-loop features. Preserve existing `each` collection-output behavior. Limit the number of invocations and use sequential collection execution initially.

Propose `repeat: {max_iterations: N, until: done}` for repeated execution of one step. `N` is a positive integer; `until` is an optional boolean output of that step, checked after each accepted iteration. Without `until`, execute exactly N iterations. Inputs bound to state are refreshed between iterations. Other upstream inputs remain fixed.

Return the last accepted iteration's outputs as the step result and retain every iteration in the trace. Reaching N without satisfying a declared `until` condition is a recorded limit failure. Do not combine `repeat` with `each` in the first version. Evaluate step-level `when` before entering the loop. A skipped step has no output, consistent with the existing reference rules.

A single-step repeat is not a general nested subgraph loop. In the first implementation, an agent or a script can own a bounded observe/act loop. Add multi-step loop bodies only after a concrete use demonstrates the need. Implement `repeat` after the three execution types unless the first experiment requires it sooner.

## Limits and time

Require finite run and step deadlines. The effective deadline is the minimum of the step limit and remaining run time. Add turn and request limits where relevant. Enforce limits across actions and checks, not independently in a way that silently doubles the allowance.

The initial step-limit fields are `timeout_ms`, `max_agent_turns`, and `max_model_requests`, with positive integer values. `timeout_ms` covers one invocation including its check. The other fields apply to the whole invocation when that work can occur. A turn is one agent model response; a request count includes checker requests. Repeated invocations also share the enclosing run deadline and total request cap. A single `call` action still makes one model request even when its check makes another. Run-wide limits come from the operator's recorded execution configuration and cannot be increased by YAML.

The operator sets a total resource cap. A candidate cannot raise it. Reserve for potentially billable work before dispatch where accounting permits. Cancel work on deadline; record uncertain charges and any external work that cancellation cannot undo. Missing usage is unknown, not zero.

Record elapsed time, model time when available, game ticks, and pause settings separately. The game adapter controls whether simulation continues during reasoning. The format must not silently pause a real-time experiment.

The first implementation does not include a hard real-time scheduler. Periodic workers, interruption, priority queues, and parallel shared-world controllers are deferred. Low model latency alone does not establish that this runtime is suitable for StarCraft II response deadlines.

## Policy bundle and run record

A candidate version consists of its Method, referenced helper files, dependencies or lockfiles, and immutable model artifact references. Save a manifest of hashes. Large weights can remain external with a content hash and retrieval instructions; secrets are never bundled.

Record resolved profiles, tool definitions, evaluator version, inputs, outputs, checks, state updates, errors, limits, usage, and timestamps. Link every event to its step and iteration. Preserve unsuccessful trials. Reproduction means enough information to rerun and inspect; it does not promise identical stochastic outputs or unchanging hosted model weights.

Search edits candidate bundles between trials. Evaluation freezes the bundle and resolved settings while allowing its declared working state to change. Editing helper code counts as a policy change just as editing a prompt does.

## Compatibility

Keep `method/2` behavior stable. Do not reinterpret existing text `do` values as scripts or silently route them to a cheaper model. Migration converts a text `do` to an explicit agent object and a text `check` to an agent check. Existing exact checks and data bindings retain their meaning.

Migration needs an explicit model profile and finite limits; these cannot be inferred from old prose without a choice. Preserve execution semantics where possible and report every added default. Validate references, effects, capabilities, and limits in addition to JSON Schema structure.

Publish a new format identifier and release only when its validator, reference execution, and conformance examples agree. The draft is not a commitment to every field name.

## Decisions and review points

Accepted direction: three execution types; common data and checks; explicit resource limits; versioned artifacts; inference before training; fixed external evaluation.

Proposed choices for review: tagged `do` objects, required `purpose`, profile references, JSON process transport, separate check result shape, and last-output semantics for `repeat`.

Deferred: training APIs, neural-network architecture syntax, persistent agent memory, general nested workflow programming, distributed scheduling, and hard real-time guarantees.
