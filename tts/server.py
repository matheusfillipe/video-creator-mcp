import ctypes
import gc
import io
import os
import tempfile
import threading
import time

import soundfile as sf
import torch
import uvicorn
from chatterbox.tts_turbo import ChatterboxTurboTTS
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS", "8")))

IDLE_BEFORE_UNLOAD_SECONDS = 600

libc = ctypes.CDLL("libc.so.6")
# The autoregressive sampler is not thread-safe and serializes anyway, so only one
# generation runs at a time; concurrent callers queue on this lock. Loading and
# unloading take it too, so we never drop the model under a running generation.
lock = threading.Lock()
model = None
last_used = time.monotonic()
app = FastAPI()


def release_idle_model() -> None:
    global model
    while True:
        time.sleep(60)
        with lock:
            if model is not None and time.monotonic() - last_used >= IDLE_BEFORE_UNLOAD_SECONDS:
                model = None
                gc.collect()
                # glibc keeps freed tensors in its heap, so without a trim the process
                # stays full size with nothing loaded.
                libc.malloc_trim(0)


threading.Thread(target=release_idle_model, daemon=True).start()


def render(
    text: str,
    exaggeration: float,
    cfg_weight: float,
    temperature: float,
    audio_prompt_path: str | None = None,
) -> Response:
    global model, last_used
    with lock:
        if model is None:
            model = ChatterboxTurboTTS.from_pretrained(device=os.environ.get("DEVICE", "cpu"))
        wav = model.generate(
            text,
            audio_prompt_path=audio_prompt_path,
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
            temperature=temperature,
        )
        sample_rate = model.sr
        last_used = time.monotonic()
    buf = io.BytesIO()
    sf.write(buf, wav.squeeze(0).cpu().numpy(), sample_rate, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


class SpeechRequest(BaseModel):
    input: str
    exaggeration: float = 0.5
    cfg_weight: float = 0.5
    temperature: float = 0.8


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest):
    return render(req.input, req.exaggeration, req.cfg_weight, req.temperature)


@app.post("/v1/audio/speech/upload")
def speech_upload(
    input: str = Form(...),
    exaggeration: float = Form(0.5),
    cfg_weight: float = Form(0.5),
    temperature: float = Form(0.8),
    voice_file: UploadFile = File(...),
):
    suffix = os.path.splitext(voice_file.filename or "ref.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(voice_file.file.read())
        ref_path = handle.name
    try:
        return render(input, exaggeration, cfg_weight, temperature, ref_path)
    finally:
        os.unlink(ref_path)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8004")))
