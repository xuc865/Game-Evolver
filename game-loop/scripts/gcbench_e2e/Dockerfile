FROM ubuntu:22.04@sha256:3b06811b2afd352be909dd088a004166d665dc76d38b13eada33522a9d915c6f

ARG GAMECRAFT_BENCH_COMMIT=21028dfa726b10e340f102961aba21ca8016499b
ARG GODOT_VERSION=4.6.2
ARG GODOT_ZIP_SHA256=30e6b6d141f0cd5bebd629ad1d0ef1324e60091bb20662d026b402ba58c59937

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PROJECT_ENVIRONMENT=/opt/gamecraft-venv \
    PATH=/opt/gamecraft-venv/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONPATH=/opt/gamecraft-bench \
    GAMECRAFT_BENCH_GODOT_BIN=/usr/local/bin/godot \
    GODOT_SILENCE_ROOT_WARNING=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip bash coreutils findutils procps util-linux mount \
      xvfb xdotool ffmpeg x11-utils x11-xserver-utils \
      libxcursor1 libxinerama1 libxrandr2 libxi6 libgl1 libegl1 \
      libfontconfig1 libasound2 libpulse0 libudev1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.8.14 /uv /uvx /usr/local/bin/

RUN uv python install 3.12 \
    && uv venv --python 3.12 /opt/gamecraft-venv \
    && git clone https://github.com/FreedomIntelligence/gamecraft-bench.git /opt/gamecraft-bench \
    && git -C /opt/gamecraft-bench checkout --detach "$GAMECRAFT_BENCH_COMMIT" \
    && uv pip install --python /opt/gamecraft-venv/bin/python \
         'harbor==0.7.1' -e /opt/gamecraft-bench

RUN curl -fL --retry 3 \
      -o /tmp/godot.zip \
      "https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip" \
    && echo "${GODOT_ZIP_SHA256}  /tmp/godot.zip" | sha256sum -c - \
    && unzip -q /tmp/godot.zip -d /opt/godot \
    && mv "/opt/godot/Godot_v${GODOT_VERSION}-stable_linux.x86_64" /usr/local/bin/godot \
    && chmod 0755 /usr/local/bin/godot \
    && rm /tmp/godot.zip

LABEL org.opencontainers.image.source="https://github.com/FreedomIntelligence/gamecraft-bench" \
      gamecraft-bench.commit="21028dfa726b10e340f102961aba21ca8016499b" \
      godot.version="4.6.2.stable.official.71f334935"

WORKDIR /opt/gamecraft-bench

