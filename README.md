# agent-harness

A local policy engine for coding agents, with specialized roles, review gates, controlled tools, and context management.

**Implementation in progress.** The core engine, contained OpenCode launcher and specialist workflow are implemented. The live five-stage workflow passes on macOS with a scripted provider; automatic compaction also passes with retained specialists. Full runtime conformance, learning/restart integration and Codex runtime verification remain open. The [delivery ledger](docs/IMPLEMENTATION.md) tracks verified behavior and remaining release work against the [specification](docs/plan.MD).

## Development

Requires Node.js 22.17+, Git, a C compiler, and Linux or macOS. Live runtime and worker tests also require an isolated Docker daemon.

```sh
npm ci
npm run verify
npm run harness -- init
npm run harness -- enroll --repository /absolute/path/to/worktree
npm run harness -- pair --runtime opencode
npm start
```

Initialization prints the location of the owner-readable web credential. Use it to sign in to the loopback controls. Keep engine state and pairing credentials outside enrolled repositories. Enrollment and pairing commands run while the engine is stopped; running-engine enrollment is also available in the controls.

The web interface manages policy, reviews, evidence, context, learning and recovery. Root coding sessions start from a separate host terminal using the [OpenCode launcher](runtime/opencode/README.md). Unsupported or uncertified runtimes cannot perform protected operations.

See [conformance evidence and live tests](conformance/README.md) for test commands, platform results and their scope.
