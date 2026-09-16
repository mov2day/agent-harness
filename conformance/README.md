# Conformance evidence

The specification's release gate requires applicable OpenCode conformance tests on Linux and macOS, with independently approved evidence for any N/A cells. Codex requires separate adapter verification. Unit tests and isolated command-worker tests do not certify an OpenCode or Codex runtime.

## Live command workers

Build `worker/Dockerfile`, obtain the full image ID with `docker image inspect`, then run:

```sh
HARNESS_TEST_WORKER_IMAGE=sha256:<full-image-id> npm run test:workers:live
```

Set `DOCKER_CONTEXT` when using a dedicated VM. The suite requires an actual container daemon and image; it never falls back to a mock. It verifies fresh temporary state, no general network, no host mounts or control sockets, an unprivileged process, immutable input snapshots, cleanup, and cancellation after authority revocation. The engine-health fixture in this suite isolates the worker mechanism; full runtime containment certification is separate.

### Observed on 2026-09-15

- Host: macOS arm64; dedicated Colima profile `agent-harness`, no host directory mounts, no SSH agent forwarding or port forwarding.
- Worker image: `sha256:73ba8e5b4a002d029a99ea56b7f7d02d5781adde00c63efe29fb3e6b4a04a33e`.
- Both live worker scenarios passed, including a repeat after lifecycle fixes.
- Full local suite: 49 tests passed before the additional cleanup-failure test; the nine affected lifecycle/snapshot/worker tests then passed. Type checking and production build passed.

This record reports observations, not independent approval or a release certificate.

## Linux native verification

`Dockerfile.linux` builds the full source/test environment on a pinned Node 22 Debian base. It copies the source into the VM and runs as the unprivileged `node` user. It does not mount the host repository.

```sh
docker build -f conformance/Dockerfile.linux -t agent-harness-linux-tests:local .
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges agent-harness-linux-tests:local
```

On 2026-09-15 the Linux arm64 image `9658938cc789` passed type checking, all 50 tests, and the production build. This includes actual `openat2` helper execution and adversarial namespace-race fixtures. The additional restart-clock tests were added afterward and verified locally; this earlier Linux result does not cover them.

The updated Linux image `4cd54277674c` passed all **63** tests, type checking and the production build on 2026-09-16. The same 63 tests and checks passed on macOS. This run adds restart-clock recovery, model validation, bounded runtime health, failed audit writes/commits, and real TLS gateway fixtures. TLS fixture routing is local and explicitly controlled by the test; production DNS checks, pinned lookup and hostname verification remain enabled.

The subsequent Linux image `806b52545ce4` passed **69/69** tests, type checking and the production build on 2026-09-16. The same checks passed on macOS. This adds five restricted model-channel scenarios and a test that verifies runtime/worker/dependency changes invalidate source fingerprints.

## Live OpenCode transport

On 2026-09-16, `npm run test:opencode:live` passed with the actual OpenCode **1.18.31** binary and plugin in image `785c96345416`, using the dedicated Colima daemon from the macOS host. The conversation traversed context retrieval, a streamed model response, a scoped artifact call, and a final answer. Probes confirmed raw-session spoof rejection, a denied native-shell request with no file effect, no external network, no host repository/socket access, and container removal.

The provider and engine replies in this transport test are deterministic fixtures. It does not certify the full engine-backed workflow, Linux host integration, or the Codex runtime. Build/run instructions and remaining integration requirements are in the [OpenCode runtime notes](../runtime/opencode/README.md).

## Authorization mechanism benchmark

```sh
HARNESS_TEST_WORKER_IMAGE=sha256:<full-image-id> npm run benchmark:authorization
```

This benchmark uses eight real isolated Python containers and the production health inspector, identity checks, policy resolution, SQLite writer and durable intent path. The runtime certificates are explicitly disposable fixtures; this benchmark cannot certify OpenCode or Codex. It writes a detailed local report to `conformance/results/authorization.json`.

The macOS arm64 run on 2026-09-15 completed 500 scheduled requests in 9.983 seconds. Admission including durable intent measured p95 **2.768 ms**, p99 **4.283 ms** (targets: 20/50 ms). Separate durable audit transactions measured p95 **0.444 ms**, p99 **0.767 ms**. Stopping an actual container caused session invalidation.

Health is inspected in one asynchronous batch every 250 ms. Admissions require an inspection less than 1,000 ms old; slow, missing, stale or failed checks invalidate authority. Runtime isolation is verified at attachment and each refresh. This bounded health observation interval does not grant extra capability lifetime.
