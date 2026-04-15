# syntax=docker/dockerfile:1.6
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 \
        python3-pip \
        python3-venv \
        ffmpeg \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3.10 /usr/bin/python && \
    ln -sf /usr/bin/pip3 /usr/bin/pip

WORKDIR /app

COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY pyproject.toml ./
COPY subsmelt_whisper ./subsmelt_whisper
RUN pip install -e .

ENV MEDIA_DIR=/media \
    MODELS_DIR=/models \
    CONFIG_DIR=/config \
    HOST=0.0.0.0 \
    PORT=9000

VOLUME ["/media", "/models", "/config"]
EXPOSE 9000

CMD ["subsmelt-whisper", "serve"]
