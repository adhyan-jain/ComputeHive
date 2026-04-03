# ComputeHive

ComputeHive is a distributed compute prototype with three core pieces:

- a Go coordinator service that exposes gRPC APIs
- a Go worker runtime that executes container jobs
- a Tauri desktop client that builds/upload artifacts and submits jobs

## Monorepo Layout

```text
ComputeHive/
├── client/                  # Tauri desktop app (Vite + TypeScript + Rust)
├── coordinator/             # gRPC coordinator service (Go)
├── worker/                  # Worker runtime (Go)
├── shared/proto/            # Protobuf source contracts
└── docker-compose.yml       # Reserved for local stack wiring (currently empty)
```

## Component Overview

### Coordinator (`coordinator/`)

- Runs WorkerService and ClientService gRPC endpoints
- Persists worker/job state in Redis
- Schedules pending jobs to eligible workers
- Requeues running jobs when a worker heartbeat expires

Default listener: `:50051`

### Worker (`worker/`)

- Registers itself with the coordinator
- Sends periodic heartbeats with resource snapshots
- Pulls jobs from coordinator `RequestJob`
- Downloads and verifies artifacts when provided
- Executes jobs using Docker and submits results via gRPC

### Desktop Client (`client/`)

- Builds Docker image from a selected project directory
- Compresses and uploads the image artifact to object storage
- Submits run requests to coordinator
- Polls job result and shows execution output
- Can start/stop a local worker process in contributor mode

## gRPC Contracts

Source files:

- `shared/proto/worker.proto`
- `shared/proto/client.proto`

Services:

- `compute.v1.WorkerService`
  - `RegisterWorker`
  - `Heartbeat`
  - `RequestJob`
  - `SubmitResult`
- `compute.v1.ClientService`
  - `SubmitJob`
  - `GetJobStatus`
  - `GetJobResult`

## Prerequisites

- Go 1.24+ (coordinator) and Go 1.25+ (worker)
- Docker daemon and Docker CLI
- Redis instance (cloud or local for worker/client experiments)
- Node.js + pnpm (desktop client frontend)
- Rust toolchain + Tauri system dependencies (desktop client)

## Quick Start

1. Start coordinator

```bash
cd coordinator
export REDIS_ADDR="<redis-host>:<port>"
export REDIS_PASSWORD="<redis-password>"
export REDIS_DB=0
export REDIS_TLS=true
go run cmd/server/main.go
```

2. Start worker

```bash
cd worker
export COORDINATOR_ADDR="127.0.0.1:50051"
go run ./cmd/worker
```

3. Start desktop client

```bash
cd client
pnpm install
pnpm tauri dev
```

See component-specific setup in:

- `client/README.md`
- `worker/README.md`

## Notes


- `docker-compose.yml` is currently not wired.
- Proto generation is checked in under `coordinator/pkg/pb` and `worker/pkg/pb`.
