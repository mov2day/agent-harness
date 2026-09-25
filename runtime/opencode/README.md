# Contained OpenCode runtime

This image pins OpenCode and its plugin package to **1.18.31**, with a pinned Node base image and npm lockfile. The host transport is `src/adapters/contained-opencode.ts`.

## Boundary

- Each session gets a fresh container, a read-only image, private temporary directories, an unprivileged user, resource limits, and no external network or host mounts.
- The container holds no provider key, integration credential, owner credential, or engine capability. The trusted host bridge holds those credentials.
- A bounded stdin/stdout protocol permits only scoped tool, context, and model requests. Raw OpenCode session IDs are bound once; the host transport does not expose pairing, policy, review approval, or enrollment methods to the container.
- The plugin denies native tools and shell calls and injects authoritative context. Container isolation protects the host independently of plugin hooks.
- Model requests use the host model channel. The container converts the bounded, complete provider response into the streaming protocol OpenCode expects.
- OpenCode's configuration directory is precreated in the immutable image. This prevents startup dependency installation in the offline container. See the pinned upstream [configuration loader](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/config/config.ts) and [dependency installer](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/core/src/npm.ts).

## Build and transport test

```sh
docker build -f runtime/opencode/Dockerfile -t agent-harness-opencode:1.18.31 .
npm run test:opencode:live
npm run test:opencode:engine
npm run test:opencode:specialists
```

Select the intended isolated Docker context for both commands. The test resolves the image to its immutable ID before creating a container. `HARNESS_TEST_OPENCODE_IMAGE` can select a different image reference for testing; the production transport requires a full `sha256:` image ID.

The live test runs the actual binary and plugin through a scripted model response, a brokered artifact call, and a final answer. It also checks alternate session rejection, denied native-shell effects with a writable-directory control, network isolation, absence of host paths/sockets, and container removal.

The engine integration test uses the production HTTP bridge, registration, policy, leases, model channel, artifacts, container inspection and shutdown. It scripts only the provider responses, including a forbidden Conductor file read followed by an allowed artifact write. Its runtime certificate is an explicit disposable fixture, never release evidence.

The specialist test exercises all five review stages with ten assignments and seven real containers. A Reviewer is reused within the original root; producer sessions are released after review. It checks artifact ownership and input lineage, separate connections, terminal task outcomes and actual removal of every container. The provider responses and certificate are disposable fixtures; the test does not evaluate model quality or replace the separate file/command and release conformance suites.

The system-context hook mutates `output.system` in place. The pinned [OpenCode request preparation](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/llm/request.ts#L52-L71) retains that original array. Reassigning the property silently loses the injected context; the specialist test asserts the engine-assigned role in the actual provider payload.

## External launcher

Run the engine separately, with the same Docker context as the launcher. Enroll the Git worktree, pair an OpenCode integration, install a current verified runtime certificate, configure a host model profile, and publish supported role model settings before starting a session.

```sh
npm run runtime:opencode -- \
  --repository ENROLLED_REPOSITORY_ID \
  --repository-path /absolute/path/to/worktree \
  --pairing /owner-only/path/to/opencode-pairing.json \
  --certificate VERIFIED_CERTIFICATE_ID \
  --goal "Describe the intended task"
```

Use `--once` to stop after the first completed runtime turn. Otherwise, the host terminal accepts follow-up instructions. `--engine` selects another loopback engine port. The compiled entry point is `dist/runtime-cli.js`.

Before container creation, the engine durably records the exact image, name, connection, session, certificate, model and initial operator goal. Attachment rechecks authority and independently inspects the container. A retry cannot replace an attached runtime or change the original launch request. Revocation, termination and restart stop protected operations and trigger cleanup of the recorded process. Unknown creation outcomes, identity mismatches and removal failures remain visible under **Audit → Runtime cleanup**; the retry action never removes a container whose recorded identity differs.

## Specialist assignments

The Conductor uses `harness_delegate` with a role, task and explicit artifact IDs. The host first obtains engine admission and a durable assignment, then claims it with credentials kept outside the runtime. The specialist gets a separate contained process and connection. Its final text becomes an untrusted artifact owned by that specialist and shared with the root; it cannot create approvals.

Use `action: "message"` with an idle specialist's engine session ID to reuse its retained context, `action: "status"` with a task ID to read the outcome, and `action: "finish"` to release an idle specialist. Reuse is restricted to the same root session and repository. Starting or reusing a specialist shares only the artifacts supplied in that assignment. Released specialists cannot be resumed. Root shutdown also cleans up retained specialists.

The host never replays a task whose claim survived without its local execution state. It records reconciliation and pauses dependent authority. Revocation while awaiting a result cannot return the earlier successful admission as an ordinary completed result.

## Context accounting

Host model profiles accept `contextWindow` (default 32,768) and `tokenizer` (`o200k_base`, `cl100k_base`, or the conservative `utf8_bytes` fallback). Encoding data is bundled locally. Counts include framing allowances and are budget estimates; provider-reported usage can increase them. Tokenization runs outside the authority event loop with bounded input, queue depth and deadlines. The engine limits output to the remaining usable space, starts compaction near 70% at a complete exchange boundary, and rejects new optional context at 90%.

The trusted host reports completion for each exact model-issued tool call after any delegated task finishes. Pending calls prevent further inference and checkpoint acceptance. Large tool results return untrusted artifact references; existing artifact identity and provenance remain intact. Duplicate delivery cannot spend the budget twice. Unsafe continuation pauses the session through shared authority invalidation.

The host rebuilds authoritative instructions before every provider request. Automatic compaction archives the covered conversation, requests a bounded tool-free summary from the assigned model, and commits the checkpoint with complete engine state and source lineage. Narrative remains untrusted. Later provider requests replace the exact covered prefix with that checkpoint; the host rejects changed transcript prefixes. A model may request an earlier checkpoint with `harness_compact` and `{"action":"request"}`. The request waits until all tool results complete. The host admits only exact model-issued calls before dispatch, including safe replay checks.

A failed compaction retains the previous checkpoint and gets one retry before the session pauses through shared invalidation. The model request audit records the inference purpose and exact payload hash. The live engine test exercises two checkpoints, a malformed summary retry and denied deletion after an injected summary. The retained Reviewer test exercises five checkpoints across five separate assignments.

Clean checkpoint restart/reload remains unfinished. The runtime retains its own local transcript under the transport size limit. Full authoritative state and source references are preserved; an oversized checkpoint pauses safely.

## Reading saved output

Use `harness_artifact` with `{"action":"page","id":"ARTIFACT_ID","hash":"EXACT_CONTENT_HASH","offset":0,"bytes":512}`. For a bounded tool result, use its `outputArtifact` and `outputHash` fields as the page ID and hash. Existing artifact echoes also preserve the original `id` and `hash` when that is the content you need.

Continue at the returned `next` offset until it is `null`. Offsets count UTF-8 bytes; the engine keeps characters intact. The optional page size ranges from 4 to 1,024 bytes. Every page retains the artifact identity, trust and current validity. A wrong hash, unshared artifact, invalid byte boundary or corrupted content is rejected. Read permissions do not turn the content into instructions or approvals. The page mechanism has local tests; its updated image description and live Linux/runtime checks are pending.

**Full release certification is still pending.** Learning and clean restart integration, full engine-backed conformance on both host platforms and separate Codex runtime verification remain required.
