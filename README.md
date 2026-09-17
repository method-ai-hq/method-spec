# Method format and runtime

A Method is a YAML file that describes a reusable procedure: inputs, steps, outputs, state, and checks. JSON is also accepted. A validator checks the document without executing it.

This public MIT repository contains two parts:

- **Format and validator:** JSON Schema plus semantic checks for references, types, effects, and dependency cycles.
- **Executor (`@withmethod/runtime` 0.4.0):** local script, model, and agent execution; checks; state; run records; and checkpoint resume.

New Methods use `format: method/3.1`. `method/3` remains accepted with literal prompts. The original `method/2` schema is retained as a historical baseline; this executor does not run it directly.

The full [Method SDK and CLI](https://docs.withmethod.ai/sdk/overview) uses a pinned revision of this runtime and adds authoring, account access, saved versions, and dashboard uploads. Its MIT source is included in the SDK download. The hosted application repository is private. The YAML format itself does not require an account or a hosted service.

## Try the public runtime

Requires Node.js 22 or later. The script example needs no model credentials.

```sh
git clone https://github.com/method-ai-hq/method-spec.git
cd method-spec
npm ci --ignore-scripts
npm run check
npm run example
node src/cli.js --version
```

The example runs checked counter steps and saves a trace. Use `node src/cli.js validate FILE`, `schema`, `run`, or `migrate` for the standalone interface. This package exposes the standalone `method3` command. The full SDK owns `method`; use it when you need authoring or dashboard commands. Runtime 0.3.1 removes its conflicting `method` binary so installing the SDK cannot select the smaller runtime CLI by mistake. Distribution is through GitHub and Method downloads, not a claimed npm registry release.

## Model setup and limits

Model profiles preserve explicit settings. Otherwise the runtime selects the calling Codex or Claude Code process, or the sole installed supported agent. Ambiguous selection returns needs_input. Both use their normal sign-in. Simple local-agent files need no runtime.json. Scripts, custom tools, connections, and direct API model profiles need explicit configuration. When supplying a configuration file, enable `allow_local_processes` for scripts or Codex.

An explicit `backend: openai-responses` profile uses an API key environment variable. Request and agent-turn caps govern that direct API loop. Codex manages its own internal requests and installed tools. Method records Codex process logs and enforces its timeout and declared Method tool limits; it does not count every internal request or enforce a dollar budget.

Scripts and local coding agents are trusted local processes, not an OS sandbox. The Codex adapter disables approval and sandbox prompts. A Method tool list restricts the Method bridge, not all Codex access. Review the Method and helper code before running it.

## Read next

| Document | Purpose |
| --- | --- |
| [Current reference](spec/method-3.md) | Implemented syntax, execution, limits, and recovery. |
| [JSON Schema](spec/method-3.schema.json) | Current method/3 and method/3.1 grammar. |
| [Configuration schema](spec/runtime-config.schema.json) | Operator runtime, model, tool, and limit settings. |
| [Product documentation](https://docs.withmethod.ai) | Full CLI, JavaScript/Python SDKs, API, and MCP. |
| [Validation record](VALIDATION.md) | Checked behavior and limits of the evidence. |
| [Original proposal](proposals/method-3.md) | Historical rationale; the current reference takes precedence. |
| [Baseline provenance](PROVENANCE.md) | Original Method 2 source and hashes. |
| [Contribution record](HACKATHON.md) | Prior work and dated changes. |
| [Implementation plan](PLAN.md) | Original work stages. |

Game controls, policies, and measured game results belong in [method-factorio](https://github.com/method-ai-hq/method-factorio). Passing runtime tests does not establish model quality or game performance.

## Maintain the contract

`src/schema.js` defines the grammar. `npm run schema` generates JSON schemas and static shape validators. `src/semantics.js` checks meaning beyond the grammar. The product imports these public definitions at a pinned commit; it does not maintain a second current runtime.

Step purpose, data descriptions, and limit overrides are optional. `src/defaults.js` supplies finite defaults. Run `npm run check` before release and `npm run types` after a change that affects exported types. No private application source or history is included.
