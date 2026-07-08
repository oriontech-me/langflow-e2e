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
FROM ollama/ollama:latest

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
