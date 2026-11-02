# syntax=docker/dockerfile:1

# NeMo-Speech.cpp runtime for the Nemotron ASR engine. A version bump is one
# edit here: the version plus the SHA-256 of each release archive.
ARG NEMO_SPEECH_VERSION=0.1.0
ARG NEMO_SPEECH_SHA256_LINUX_X86_64_CUDA=e68628f396489c98fb353e070efaea5bc4977409ae7734fce56c251a79e29147
ARG NEMO_SPEECH_SHA256_LINUX_X86_64_CPU=0f74131d631ad2c694cf0ec53490866bb6461147959589a69fb6fc231944065b
ARG NEMO_SPEECH_SHA256_LINUX_AARCH64_CPU=0e4112255d566de7bdd142f239e984995c4447103ba8feb41f2bb5c559d561d3

# The archives are fetched on the build platform (no emulation needed) and
# chosen by the target architecture.
FROM --platform=$BUILDPLATFORM alpine:3.20 AS nemo-speech
ARG TARGETARCH
ARG NEMO_SPEECH_VERSION
ARG NEMO_SPEECH_SHA256_LINUX_X86_64_CUDA
ARG NEMO_SPEECH_SHA256_LINUX_X86_64_CPU
ARG NEMO_SPEECH_SHA256_LINUX_AARCH64_CPU
RUN <<'EOF'
set -eu
base="https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${NEMO_SPEECH_VERSION}"
fetch() {
  platform=$1 flavor=$2 sha=$3
  name="nemo-speech-${NEMO_SPEECH_VERSION}-${platform}"
  wget -q -O "/tmp/${name}.tar.gz" "${base}/${name}.tar.gz"
  echo "${sha}  /tmp/${name}.tar.gz" | sha256sum -c -
  tar -xzf "/tmp/${name}.tar.gz" -C /tmp
  mkdir -p "/out/${flavor}/share"
  mv "/tmp/${name}/bin" "/tmp/${name}/lib" "/out/${flavor}/"
  mv "/tmp/${name}/share/licenses" "/out/${flavor}/share/"
  rm -rf "/out/${flavor}/lib/cmake" "/tmp/${name}" "/tmp/${name}.tar.gz"
}
case "$TARGETARCH" in
  amd64)
    fetch linux-x86_64-cuda cuda "$NEMO_SPEECH_SHA256_LINUX_X86_64_CUDA"
    fetch linux-x86_64-cpu cpu "$NEMO_SPEECH_SHA256_LINUX_X86_64_CPU"
    ;;
  arm64)
    fetch linux-aarch64-cpu cpu "$NEMO_SPEECH_SHA256_LINUX_AARCH64_CPU"
    ;;
  *)
    echo "no NeMo-Speech build for TARGETARCH=${TARGETARCH}" >&2
    exit 1
    ;;
esac
EOF

# The CUDA build cannot even start without the host's libcuda.so.1 (it arrives
# only with --gpus and the NVIDIA container toolkit), so pick the build per run.
COPY --chmod=755 <<'EOF' /out/bin/nemo-speech
#!/bin/sh
root=/opt/nemo-speech
flavor=cpu
if [ -x "$root/cuda/bin/nemo-speech" ]; then
  if ldconfig -p 2>/dev/null | grep -q 'libcuda\.so\.1' \
    || [ -e /usr/lib/x86_64-linux-gnu/libcuda.so.1 ] \
    || [ -e /usr/lib64/libcuda.so.1 ] \
    || [ -e /usr/local/nvidia/lib64/libcuda.so.1 ]; then
    flavor=cuda
  fi
fi
if [ "${NEMO_SPEECH_DEBUG:-}" = "1" ]; then
  echo "nemo-speech launcher: using the $flavor build" >&2
fi
exec "$root/$flavor/bin/nemo-speech" "$@"
EOF

FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=nemo-speech /out/ /opt/nemo-speech/
ENV SUBSMELT_NEMO_SPEECH=/opt/nemo-speech/bin/nemo-speech

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV MEDIA_ROOT=/media
ENV HF_HOME=/models
ENV XDG_CACHE_HOME=/models

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
