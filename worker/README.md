# Worker Node

This folder contains the first bootstrap of the ComputeHive worker node. The worker is a small Go service that:

- sends heartbeats to Redis
- reports machine resources
- pulls jobs from a Redis queue
- downloads image archives from object storage
- verifies the uploaded archive hash
- loads and executes jobs inside Docker containers
- stores job status and results back in Redis

## Folder Structure

```text
worker/
├── cmd/worker               # CLI entrypoint
├── internal/artifact        # Artifact download + SHA256 verification
├── internal/config          # Env and flag parsing
├── internal/domain          # Job, result, and heartbeat models
├── internal/executor        # Docker load + run pipeline
├── internal/resources       # CPU, memory, GPU, Docker reporting
├── internal/store           # Minimal Redis client + worker persistence
├── internal/worker          # Main worker loop
├── examples                 # Sample job payloads
├── Dockerfile               # Optional container image for the worker
└── .env.example             # Local configuration template
```

## What This Version Supports

- Redis-backed job queue using `BRPOP`
- periodic heartbeats with TTL
- worker status changes: `idle`, `busy`
- image archive download from signed URLs or bucket URLs
- SHA256 verification before execution
- `docker load` followed by isolated `docker run`
- Docker job isolation with CPU and memory limits
- optional GPU job flag support through `--gpus all`
- result publishing for later coordinator and dashboard work

## Job Format

Push JSON payloads like this into the pending queue:

```json
{
  "task_id": "sample-job-001",
  "s3_url": "https://example-bucket.r2.dev/tasks/sample-job-001.tar.gz",
  "image_hash": "replace-with-sha256-of-the-tar-gz",
  "image_ref": "computehive/sample-job-001:latest",
  "command": [
    "python",
    "-c",
    "total = sum(i * i for i in range(1000000)); print(total)"
  ],
  "env": {
    "PYTHONUNBUFFERED": "1"
  },
  "cpu_cores": 1,
  "memory_mb": 256,
  "timeout_seconds": 120,
  "gpu": false
}
```

The worker expects the uploaded archive to come from:

```bash
docker build -t computehive/sample-job-001:latest .
docker save computehive/sample-job-001:latest | gzip > sample-job-001.tar.gz
```

The `image_ref` in the job payload must match a tag present inside the uploaded archive.

## Redis Keys

- queue: `computehive:jobs:pending`
- results list: `computehive:jobs:results`
- job status key: `computehive:jobs:<job-id>:status`
- job result key: `computehive:jobs:<job-id>:result`
- worker heartbeat key: `computehive:workers:<worker-id>:heartbeat`

Two pub/sub channels are also emitted for future coordinator and dashboard integration:

- `computehive:events:workers`
- `computehive:events:jobs`

## Run Locally

```bash
cd worker
go run ./cmd/worker
```

You can override config through flags or environment variables:

```bash
go run ./cmd/worker \
  -worker-id worker-local-01 \
  -redis-addr 127.0.0.1:6379 \
  -queue-key computehive:jobs:pending
```

## Queue A Sample Job

```bash
redis-cli LPUSH computehive:jobs:pending "$(cat examples/sample-job.json)"
```

## Build The Worker

```bash
go build ./cmd/worker
```

## Containerized Worker

The `Dockerfile` builds the worker itself. If you run the worker container, mount the host Docker socket so the worker can start job containers:

```bash
docker build -t computehive-worker ./worker
docker run --rm \
  -e REDIS_ADDR=host.docker.internal:6379 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  computehive-worker
```
