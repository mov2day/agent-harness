# Conformance evidence

The specification's release gate includes independently reviewed runtime evidence on Linux and macOS. Unit tests and isolated command-worker tests do not certify an OpenCode or Codex runtime.

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
