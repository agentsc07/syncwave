FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OMP_NUM_THREADS=2 \
    TORCH_HOME=/home/user/.cache/torch \
    CACHE_DIR=/home/user/cache \
    PORT=7860

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces run as uid 1000
RUN useradd -m -u 1000 user
USER user
ENV PATH=/home/user/.local/bin:$PATH
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --user torch==2.2.2 torchaudio==2.2.2 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --user -r requirements.txt

# Pre-download htdemucs weights at build time (no cold-start download)
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')"

COPY --chown=user app.py .

EXPOSE 7860
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-7860}"]
