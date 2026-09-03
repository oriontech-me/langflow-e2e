# Ollama with the e2e test model baked in — used as a CI service container by
# ollama-provider.spec.ts (QA-CHECKLIST §7.6, issue #583).
#
# Baking the weights into the image removes the per-run 1.3GB pull from
# registry.ollama.ai (a recurring flake source) and pins the model: CI pulls
# only from ghcr, the same infra GitHub Actions runs on.
#
# Rebuild + push happens via .github/workflows/build-ollama-image.yml (on
# changes to this file or manual dispatch). To change the model, update
# OLLAMA_E2E_MODEL here AND OLLAMA_TEST_MODEL in the workflows/.env.
#
# The base tag is PINNED, and that is a change from `latest`. This image is
# rebuilt rarely, so `latest` meant the container's Ollama moved whenever
# someone happened to rebuild it — while scripts/start-ollama-source.sh, which
# serves these same specs natively on the machines without Docker, stayed
# where it was. A version difference between those two is the one difference
# the VM lane cannot tell apart from a product change, and it would arrive
# without anyone editing a line. 0.32.5 is what the image in the registry
# carries today (built 2026-08-01, when `latest` was 0.32.5), so pinning it
# records the status quo instead of moving it. Bumping this tag and the
# script's VERSION default is ONE change: scripts/start-ollama-source.test.mjs
# reads this line, so it cannot be done by halves.
FROM ollama/ollama:0.32.5

ARG OLLAMA_E2E_MODEL=llama3.2:1b

# `ollama pull` needs the server up; run both in one layer so the downloaded
# weights (/root/.ollama) are committed into the image.
RUN ollama serve & \
    SERVER_PID=$!; \
    for i in $(seq 1 30); do \
      ollama list >/dev/null 2>&1 && break; \
      sleep 1; \
    done && \
    ollama pull "$OLLAMA_E2E_MODEL" && \
    ollama list && \
    kill "$SERVER_PID"

# Same entrypoint/port as the base image (ollama serve on 11434).
