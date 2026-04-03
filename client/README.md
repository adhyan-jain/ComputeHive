# ComputeHive Desktop Client

This app is the ComputeHive desktop interface built with:

- frontend: Vite + TypeScript
- desktop shell/backend: Tauri 2 + Rust

It supports two user flows:

- user mode: package a project as a Docker artifact and submit a run request
- contributor mode: start/stop a local worker process from the desktop UI

## Prerequisites

- Node.js 20+
- pnpm
- Rust toolchain (`rustup`)
- Tauri system dependencies for Linux
- Docker daemon + Docker CLI in `PATH`
- running coordinator and Redis

## Install and Run

```bash
cd client
pnpm install
pnpm tauri dev
```

Useful scripts:

```bash
pnpm dev       # frontend only (Vite)
pnpm build     # frontend production build
pnpm tauri dev # full desktop app in dev mode
pnpm tauri build
```

Vite dev port is fixed to `1420` (see `vite.config.ts`).

## Required Configuration

The Tauri backend loads environment values from:

- repo root `.env` (preferred)
- current working directory `.env`

Required env vars:

- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `REDIS_URL`

Optional env vars:

- `S3_SESSION_TOKEN`
- `S3_PUBLIC_BUCKET_URL`
- `COORDINATOR_ADDR` (default: `127.0.0.1:50051`)
- `COMPUTEHIVE_WORKER_DIR` (contributor mode)
- `COMPUTEHIVE_WORKER_BIN` (contributor mode)

## What Happens on Run Request

When you select a project and request a run, the desktop app:

1. Detects or generates Docker setup for the selected folder.
2. Builds a Docker image.
3. Exports the image archive.
4. Compresses the archive to `.tar.gz`.
5. Computes SHA256 checksum.
6. Uploads the artifact to object storage.
7. Calls coordinator `SubmitJob` over gRPC.
8. Polls coordinator for job completion and displays result/output metadata.

## Contributor Sharing Mode

Contributor mode starts a worker process from the desktop app.

Resolution order:

1. `COMPUTEHIVE_WORKER_BIN` if set and exists
2. worker binary at `<worker-dir>/worker`
3. fallback: `go run ./cmd/worker` inside the worker directory

Worker directory defaults to `../../worker` relative to `client/src-tauri/`.

## Troubleshooting

- Docker errors: ensure Docker daemon is running and `docker` is on `PATH`.
- Worker not found in contributor mode: set `COMPUTEHIVE_WORKER_DIR` or `COMPUTEHIVE_WORKER_BIN`.
- Coordinator connection issues: verify `COORDINATOR_ADDR` and coordinator process.
- Upload issues: verify object storage credentials and bucket URL values.
