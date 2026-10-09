FROM denoland/deno:2.9.6@sha256:2014dc167ece617ef7e7ba40631ac2234c59e75ce693e7cc2dc2602b3c87859d AS deno
FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641 AS api-source
ARG FACODI_API_SOURCE_SHA=f3258cc550ab04f712d475f87569a40ce39c8c39
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git init /opt/facodi-api \
    && git -C /opt/facodi-api fetch --depth=1 https://github.com/marcelo-m7/facodi-api.git "$FACODI_API_SOURCE_SHA" \
    && git -C /opt/facodi-api checkout --detach FETCH_HEAD \
    && test "$(git -C /opt/facodi-api rev-parse HEAD)" = "$FACODI_API_SOURCE_SHA"

FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ARG FACODI_API_SOURCE_SHA=f3258cc550ab04f712d475f87569a40ce39c8c39
LABEL org.opencontainers.image.source="https://github.com/marcelo-m7/facodi-supabase" \
      com.facodi.converter.source="$FACODI_API_SOURCE_SHA"
ENV DENO_DIR=/opt/deno-cache DENO_NO_UPDATE_CHECK=1 HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 FACODI_ISOLATED_WORKER_ENABLED=false
COPY --from=deno /usr/bin/deno /usr/bin/deno
COPY --from=api-source /opt/facodi-api/facodi_api/core/ingestion/document_transport.py /opt/facodi-api/facodi_api/core/ingestion/document_transport.py
WORKDIR /app
COPY workers/canonical/requirements.txt /app/workers/canonical/requirements.txt
RUN pip install --no-cache-dir -r /app/workers/canonical/requirements.txt
COPY deno.json deno.lock /app/
COPY supabase/functions/_shared /app/supabase/functions/_shared
COPY workers/canonical /app/workers/canonical
RUN deno cache --config=/app/deno.json --frozen workers/canonical/index.ts workers/canonical/document.ts
USER 10001:10001
ENTRYPOINT ["/usr/bin/deno", "run", "--no-prompt", "--cached-only", "--frozen", "--config=/app/deno.json", "--allow-env", "--allow-net=bhfywztfyidvrlarebmg.supabase.co:443,www.youtube.com:443,generative-language.googleapis.com:443,generativelanguage.googleapis.com:443", "--allow-read=/app,/opt/deno-cache,/opt/facodi-api,/tmp", "--allow-write=/tmp", "--allow-run=/usr/local/bin/python3", "/app/workers/canonical/index.ts"]