# Method format and runtime

A Method is a YAML file that describes a reusable procedure: inputs, steps, outputs, state, and checks. JSON is also accepted. A validator checks the document without executing it.

This public MIT repository contains two parts:

- **Format and validator:** JSON Schema plus semantic checks for references, types, effects, and dependency cycles.
- **Executor (`@withmethod/runtime` 0.9.0):** local script, model, and agent execution; checks; state; run records; and checkpoint resume.

New methods use `format: method/3.2`. Existing `method/3.1` documents keep their validation rules.

The full [Method SDK and CLI](https://docs.withmethod.ai/sdk/overview) uses a pinned revision of this runtime and adds authoring, account access, saved versions, and dashboard uploads. The SDK source and releases are public at [method-sdk](https://github.com/method-ai-hq/method-sdk). The hosted application repository is private. The YAML format itself does not require an account or a hosted service.

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

The example runs checked counter steps and saves a trace. `node src/cli.js` is a contributor test harness. This package installs no executable command. Use the public [SDK](https://github.com/method-ai-hq/method-sdk) and its `method` command for user workflows. Distribution is through GitHub and Method downloads.

## Model setup and limits

Model profiles preserve explicit settings. Otherwise the runtime selects the calling Codex or Claude Code process, or the sole installed supported agent. Ambiguous selection returns needs_input. Both use their normal sign-in. Simple local-agent files need no runtime.json. Scripts, custom tools, connections, and direct API model profiles need explicit configuration. When supplying a configuration file, enable `allow_local_processes` for scripts or Codex.

An explicit `backend: openai-responses` profile uses an API key environment variable. Request and agent-turn caps govern that direct API loop. Codex manages its own internal requests and installed tools. Method records Codex process logs and enforces its timeout and declared Method tool limits; it does not count every internal request or enforce a dollar budget.

Scripts and local coding agents are trusted local processes, not an OS sandbox. The Codex adapter disables approval and sandbox prompts. A Method tool list restricts the Method bridge, not all Codex access. Review the Method and helper code before running it.

## Read next

| Document | Purpose |
| --- | --- |
| [Current reference](spec/method-3.md) | Implemented syntax, execution, limits, and recovery. |
| [JSON Schema](spec/method-3.schema.json) | Method 3.1 and 3.2 grammar. |
| [Configuration schema](spec/runtime-config.schema.json) | Operator runtime, model, tool, and limit settings. |
| [Product documentation](https://docs.withmethod.ai) | Full CLI, JavaScript/Python SDKs, API, and MCP. |
| [Validation record](VALIDATION.md) | Checked behavior and limits of the evidence. |

Game controls, policies, and measured game results belong in [method-factorio](https://github.com/method-ai-hq/method-factorio). Passing runtime tests does not establish model quality or game performance.

## Maintain the contract

`src/schema.js` defines the grammar. `npm run schema` generates JSON schemas and static shape validators. `src/document.js` owns browser-safe YAML parsing, typed document errors, default values, and document validation. It preserves text and permits bounded YAML aliases. `src/semantics.js` owns shapes, references, and dependency rules. The product imports these public definitions at a pinned commit; it does not maintain a second current runtime.

Method 3.2 requires script names, purposes, output descriptions, and script-check descriptions. Limit overrides remain optional. `src/defaults.js` supplies finite defaults. Run `npm run check` before release and `npm run types` after a change that affects exported types. No private application source or history is included.
