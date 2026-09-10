# Method specification

A Method is a readable, executable procedure with typed inputs and outputs, explicit state, and checks. Its execution can be inspected and its versions can be compared.

This public repository separates the format from the hosted Method product.

## Status

- **Published baseline:** `method/2`, exported from the public MIT-licensed Method SDK 0.3.0. See the [format notes](spec/method-2.md) and [JSON Schema](spec/method-2.schema.json).
- **Proposed next version:** [Method 3 design](proposals/method-3.md). The examples use `method/3-draft`. No released runner supports that identifier yet.
- **Implementation:** this repository does not yet contain a new runner, Method 3 validator, or measured speed improvement.

The proposal keeps one common step contract and adds three ways to execute work: an agent, one model call, or a script. Existing trained models can be called through those interfaces. Training infrastructure is outside the first scope.

## Read next

| Document | Purpose |
| --- | --- |
| [Method 3 proposal](proposals/method-3.md) | Syntax, meaning, boundaries, and migration. |
| [Implementation plan](PLAN.md) | Small implementation stages and acceptance checks. |
| [Factorio experiment](EXPERIMENT.md) | How to test the execution types and policy search. |
| [Hackathon contribution record](HACKATHON.md) | Prior work, new work, and claims supported so far. |
| [Baseline provenance](PROVENANCE.md) | Public source, license, and artifact hashes. |
| [Illustrative Method](examples/factory-decision.method) | Proposed syntax; not an executable example yet. |

Game controls, playing policies, and game evidence belong in [method-factorio](https://github.com/method-ai-hq/method-factorio). This repository owns the general format and, when implemented, a small reference validator and runner. The hosted application is a separate product.

Original material and the included SDK baseline use the [MIT license](LICENSE). No private application source or history is included.
