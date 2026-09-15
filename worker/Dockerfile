# Pin BASE_IMAGE to a reviewed digest for a release image; the engine requires the
# resulting immutable image ID for every execution.
ARG BASE_IMAGE=python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
FROM ${BASE_IMAGE}
RUN groupadd -g 1000 harness && useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin harness \
    && mkdir /workspace && chown 1000:1000 /workspace
COPY runner.py /opt/agent-harness/runner.py
RUN chmod 0444 /opt/agent-harness/runner.py
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/python3", "-I", "/opt/agent-harness/runner.py"]
