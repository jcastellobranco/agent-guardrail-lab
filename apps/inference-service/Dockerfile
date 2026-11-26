FROM python:3.12-slim AS build
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY apps/inference-service/requirements.lock.txt /tmp/requirements.lock.txt
RUN pip install --no-cache-dir torch==2.10.0 --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir -r /tmp/requirements.lock.txt
FROM python:3.12-slim AS runtime
ENV PATH=/opt/venv/bin:$PATH PYTHONUNBUFFERED=1 HF_HOME=/model-cache PROBE_DIR=/artifacts
RUN groupadd -g 10001 lab && useradd -u 10001 -g lab -m lab && mkdir /model-cache /artifacts && chown lab:lab /model-cache /artifacts
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY --chown=lab:lab apps/inference-service/inference_lab ./inference_lab
COPY --chown=lab:lab apps/inference-service/data ./data
USER lab
EXPOSE 8001
CMD ["uvicorn","inference_lab.api:app","--host","0.0.0.0","--port","8001","--workers","1"]
