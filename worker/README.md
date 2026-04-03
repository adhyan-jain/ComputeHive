# ComputeHive Worker

The worker is a Go service that executes coordinator-assigned jobs in Docker.

Core behavior:

- registers with coordinator `WorkerService/RegisterWorker`
- sends periodic heartbeats
- polls jobs from coordinator `WorkerService/RequestJob`
- downloads and verifies artifact archives when present
- runs container workload with CPU/memory/GPU constraints
- uploads collected output artifacts when configured
- submits final status via `WorkerService/SubmitResult`

## Folder Structure

```text
worker/
├── cmd/worker/              # Entrypoint
├── internal/artifact/       # Artifact fetch + hash verification
├── internal/config/         # Env/flag parsing
├── internal/domain/         # Job/result/heartbeat models
├── internal/executor/       # Docker execution pipeline
├── internal/output/         # Output collection + object storage upload
├── internal/resources/      # Host capability and load reporting
├── internal/store/          # Coordinator gRPC client adapter
├── internal/worker/         # Worker loop and orchestration
├── pkg/pb/                  # Generated protobuf types
└── Dockerfile
```

## Runtime Requirements

- Go 1.25+
- Docker daemon + `docker` CLI
- network reachability to coordinator and Redis/object storage endpoints

## Configuration

The worker reads values from environment variables, optional `.env`, and CLI flags.

Most-used settings:

- `COORDINATOR_ADDR` (default: `127.0.0.1:50051`)
- `WORKER_ID` (default: hostname-based)
- `POLL_VIA_SERVER` (default: `true`)
- `REDIS_ADDR` / `REDIS_URL`
- `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_USE_TLS`
- `HEARTBEAT_INTERVAL`, `HEARTBEAT_TTL`
- `DEFAULT_JOB_TIMEOUT`
- `DOCKER_BINARY`
- `ALLOW_GPU_JOBS`
- `S3_BUCKET`, `S3_PUBLIC_BUCKET_URL`
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN`
- `S3_SIGN_REQUESTS`, `S3_SIGNING_REGION`, `S3_SIGNING_SERVICE`
- `OUTPUT_COLLECTION_DIR`, `OUTPUT_MAX_FILES`, `OUTPUT_MAX_BYTES`

Run `go run ./cmd/worker -h` to view all supported flags.

## Run Locally

```bash
cd worker
go run ./cmd/worker
```

Example with explicit coordinator and Redis values:

```bash
go run ./cmd/worker \
  -coordinator-addr 127.0.0.1:50051 \
  -redis-addr 127.0.0.1:6379 \
  -worker-id worker-local-01
```

## Build and Test

```bash
cd worker
go test ./...
go build ./cmd/worker
```

## Containerized Worker

The worker executes Docker jobs, so mount the host Docker socket when running in a container:

```bash
docker build -t computehive-worker ./worker
docker run --rm \
  -e COORDINATOR_ADDR=host.docker.internal:50051 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  computehive-worker
```

## Notes

- Current store implementation is coordinator gRPC-driven for polling and result submission.
- `POLL_VIA_SERVER` is currently expected to remain enabled.
