# Training image: Python with CPU-only PyTorch, plus the same Node binary the site uses, so the
# self-play workers run the real rules engine and the real forward pass.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS node

FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY requirements.lock /tmp/requirements.lock
# Wheels come from the project cache (.cache/wheels), checked against the hashes in the lock file.
RUN --mount=type=bind,from=wheels,target=/wheels \
    pip install --no-cache-dir --disable-pip-version-check --no-index --find-links /wheels --require-hashes -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
