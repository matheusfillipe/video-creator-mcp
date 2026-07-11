# Optional expressive-TTS backend for video_tts: a thin HTTP wrapper around the
# chatterbox-tts library's Turbo model, exposing the two endpoints video_tts calls
# (/v1/audio/speech and /v1/audio/speech/upload). CPU-only. The chatterbox package is
# a library, not a server, and no maintained image ships the Turbo model, so we run it
# directly here. Pin the CPU build of the exact torch chatterbox-tts wants first, so
# installing the library does not pull ~2GB of unused CUDA wheels.
FROM python:3.11-slim

ENV HF_HOME=/models \
    PORT=8004 \
    PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir chatterbox-tts fastapi "uvicorn[standard]" soundfile python-multipart

COPY server.py /app/server.py
WORKDIR /app
EXPOSE 8004

CMD ["python", "server.py"]
