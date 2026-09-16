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
```

Select the intended isolated Docker context for both commands. The test resolves the image to its immutable ID before creating a container. `HARNESS_TEST_OPENCODE_IMAGE` can select a different image reference for testing; the production transport requires a full `sha256:` image ID.

The live test runs the actual binary and plugin through a scripted model response, a brokered artifact call, and a final answer. It also checks alternate session rejection, denied native-shell effects with a writable-directory control, network isolation, absence of host paths/sockets, and container removal.

**This is transport evidence, not a production runtime certificate.** The test supplies deterministic engine/provider responses. The externally started host launcher still needs production registration/attachment wiring, persistent runtime lifecycle recovery, specialist orchestration, and integrated compaction. Full engine-backed conformance on both host platforms remains required before release.
