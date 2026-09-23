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
```

Select the intended isolated Docker context for both commands. The test resolves the image to its immutable ID before creating a container. `HARNESS_TEST_OPENCODE_IMAGE` can select a different image reference for testing; the production transport requires a full `sha256:` image ID.

The live test runs the actual binary and plugin through a scripted model response, a brokered artifact call, and a final answer. It also checks alternate session rejection, denied native-shell effects with a writable-directory control, network isolation, absence of host paths/sockets, and container removal.

The engine integration test uses the production HTTP bridge, registration, policy, leases, model channel, artifacts, container inspection and shutdown. It scripts only the provider responses, including a forbidden Conductor file read followed by an allowed artifact write. Its runtime certificate is an explicit disposable fixture, never release evidence.

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

**Full release certification is still pending.** Specialist orchestration, integrated compaction, full engine-backed conformance on both host platforms and separate Codex runtime verification remain required.
