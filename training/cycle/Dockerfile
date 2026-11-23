# Training cycle image: the training image (Python, CPU PyTorch, Node) plus boto3 for the S3 API of
# R2 and of the local MinIO stand-in. zap-train:local is never rebuilt here.
FROM zap-train:local
COPY requirements.lock /tmp/requirements.lock
# Wheels come from the project cache (.cache/wheels-cycle), checked against the hashes in the lock file.
RUN --mount=type=bind,from=wheels,target=/wheels \
    pip install --no-cache-dir --disable-pip-version-check --no-index --find-links /wheels --require-hashes -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
