# Method specification

A Method is a readable, executable procedure with typed inputs and outputs, explicit state, and checks. Its execution can be inspected and its versions can be compared.

This public repository separates the format from the hosted Method product.

## Status

- **Published baseline:** `method/2`, exported from the public MIT-licensed Method SDK 0.3.0. See the [format notes](spec/method-2.md) and [JSON Schema](spec/method-2.schema.json).
- **Implemented version:** [`method/3`](spec/method-3.md), with a public validator, local executor, and CLI in this repository. Runtime package: `@withmethod/runtime` 0.1.0.
- **Validation:** real script execution and fixture-based model/tool tests. Live billed model calls and a game speed improvement have not been measured.

The format keeps one common step contract and adds three ways to execute work: an agent, one model call, or a script. Existing trained models can be called through those interfaces. Training infrastructure is outside the first scope.

## Run it

Requires Node.js 22 or later. No API key is needed for the script example.

```sh
npm ci --ignore-scripts
npm run check
npm run example
```

The example increases a counter through checked script steps and saves a trace. For model calls and tool-using agents, see [the reference and setup instructions](spec/method-3.md) and [model-tools.method](examples/model-tools.method). The model backend uses the OpenAI Responses API with an API key; it does not use a Codex subscription.

Scripts and tool implementations are trusted local processes, not an OS sandbox. The CLI is named `method3` and does not replace the older `method` command.

## Read next

| Document | Purpose |
| --- | --- |
| [Method 3 reference](spec/method-3.md) | Implemented syntax, runtime behavior, limits, and migration. |
| [Original Method 3 proposal](proposals/method-3.md) | Design rationale and deferred work. |
| [Implementation plan](PLAN.md) | Small implementation stages and acceptance checks. |
| [Factorio experiment](EXPERIMENT.md) | How to test the execution types and policy search. |
| [Hackathon contribution record](HACKATHON.md) | Prior work, new work, and claims supported so far. |
| [Baseline provenance](PROVENANCE.md) | Public source, license, and artifact hashes. |
| [Runtime validation](VALIDATION.md) | Tests, package installation, and limits of the evidence. |
| [Script example](examples/counter.method) | Runnable without model calls. |
| [Model and agent example](examples/model-tools.method) | One call, an agent tool loop, and an exact check. |

Game controls, playing policies, and game evidence belong in [method-factorio](https://github.com/method-ai-hq/method-factorio). This repository owns the general format and reference validator and runner. The hosted application and SDK 0.3.0 remain separate; this release does not update them.

Original material and the included SDK baseline use the [MIT license](LICENSE). No private application source or history is included.
