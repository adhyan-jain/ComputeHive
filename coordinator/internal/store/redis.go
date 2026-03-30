package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	pb "coordinator/pkg/pb"

	"github.com/redis/go-redis/v9"
)

const (
	workersKey  = "workers"
	jobQueueKey = "job_queue"
)

const (
	JobStatusQueued    = "queued"
	JobStatusRunning   = "running"
	JobStatusCompleted = "completed"
)

type WorkerRecord struct {
	ID                 string           `json:"id"`
	AvailableResources *pb.ResourceSpec `json:"available_resources,omitempty"`
	WorkerVersion      string           `json:"worker_version,omitempty"`
	RegisteredAtUnix   int64            `json:"registered_at_unix"`
	LastHeartbeatUnix  int64            `json:"last_heartbeat_unix,omitempty"`
}

type JobRecord struct {
	ID                string            `json:"id"`
	ContainerImage    string            `json:"container_image"`
	Command           []string          `json:"command"`
	RequiredResources *pb.ResourceSpec  `json:"required_resources,omitempty"`
	Environment       map[string]string `json:"environment,omitempty"`
	MaxRuntimeSeconds int32             `json:"max_runtime_seconds,omitempty"`
	Status            string            `json:"status"`
	CreatedAtUnix     int64             `json:"created_at_unix"`
	AssignedWorkerID  string            `json:"assigned_worker_id,omitempty"`
}

type ResultRecord struct {
	JobID          string `json:"job_id"`
	WorkerID       string `json:"worker_id"`
	ResultStatus   string `json:"result_status,omitempty"`
	ExitCode       int32  `json:"exit_code,omitempty"`
	StdoutExcerpt  string `json:"stdout_excerpt,omitempty"`
	StderrExcerpt  string `json:"stderr_excerpt,omitempty"`
	OutputURI      string `json:"output_uri,omitempty"`
	FinishedAtUnix int64  `json:"finished_at_unix,omitempty"`
}

func workerKey(workerID string) string {
	return "worker:" + workerID
}

func workerAliveKey(workerID string) string {
	return "worker_alive:" + workerID
}

func jobKey(jobID string) string {
	return "job:" + jobID
}

func jobStatusKey(jobID string) string {
	return "job_status:" + jobID
}

func resultKey(jobID string) string {
	return "result:" + jobID
}

func NewRedisClient(ctx context.Context, addr string) (*redis.Client, error) {
	client := redis.NewClient(&redis.Options{Addr: addr})

	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	if err := client.Ping(pingCtx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("ping redis at %s: %w", addr, err)
	}

	return client, nil
}

func SaveWorker(ctx context.Context, client *redis.Client, worker *WorkerRecord) error {
	payload, err := json.Marshal(worker)
	if err != nil {
		return fmt.Errorf("marshal worker: %w", err)
	}

	pipe := client.TxPipeline()
	pipe.SAdd(ctx, workersKey, worker.ID)
	pipe.Set(ctx, workerKey(worker.ID), payload, 0)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("save worker %s: %w", worker.ID, err)
	}

	return nil
}

func GetWorker(ctx context.Context, client *redis.Client, workerID string) (*WorkerRecord, error) {
	raw, err := client.Get(ctx, workerKey(workerID)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get worker %s: %w", workerID, err)
	}

	var worker WorkerRecord
	if err := json.Unmarshal([]byte(raw), &worker); err != nil {
		return nil, fmt.Errorf("unmarshal worker %s: %w", workerID, err)
	}

	return &worker, nil
}

func SetWorkerAlive(ctx context.Context, client *redis.Client, workerID string, ttl time.Duration) error {
	if err := client.Set(ctx, workerAliveKey(workerID), "1", ttl).Err(); err != nil {
		return fmt.Errorf("set worker alive %s: %w", workerID, err)
	}
	return nil
}

func EnqueueJob(ctx context.Context, client *redis.Client, job *JobRecord) error {
	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job: %w", err)
	}

	pipe := client.TxPipeline()
	pipe.Set(ctx, jobKey(job.ID), payload, 0)
	pipe.Set(ctx, jobStatusKey(job.ID), JobStatusQueued, 0)
	pipe.RPush(ctx, jobQueueKey, job.ID)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("enqueue job %s: %w", job.ID, err)
	}

	return nil
}

func PopQueuedJobID(ctx context.Context, client *redis.Client) (string, error) {
	jobID, err := client.LPop(ctx, jobQueueKey).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("lpop %s: %w", jobQueueKey, err)
	}

	return jobID, nil
}

func SaveJob(ctx context.Context, client *redis.Client, job *JobRecord) error {
	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("marshal job: %w", err)
	}

	if err := client.Set(ctx, jobKey(job.ID), payload, 0).Err(); err != nil {
		return fmt.Errorf("save job %s: %w", job.ID, err)
	}

	return nil
}

func GetJob(ctx context.Context, client *redis.Client, jobID string) (*JobRecord, error) {
	raw, err := client.Get(ctx, jobKey(jobID)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get job %s: %w", jobID, err)
	}

	var job JobRecord
	if err := json.Unmarshal([]byte(raw), &job); err != nil {
		return nil, fmt.Errorf("unmarshal job %s: %w", jobID, err)
	}

	return &job, nil
}

func SetJobStatus(ctx context.Context, client *redis.Client, jobID, status string) error {
	if err := client.Set(ctx, jobStatusKey(jobID), status, 0).Err(); err != nil {
		return fmt.Errorf("set job status %s: %w", jobID, err)
	}
	return nil
}

func GetJobStatus(ctx context.Context, client *redis.Client, jobID string) (string, error) {
	status, err := client.Get(ctx, jobStatusKey(jobID)).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get job status %s: %w", jobID, err)
	}

	return status, nil
}

func SaveResult(ctx context.Context, client *redis.Client, result *ResultRecord) error {
	payload, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("marshal result: %w", err)
	}

	if err := client.Set(ctx, resultKey(result.JobID), payload, 0).Err(); err != nil {
		return fmt.Errorf("save result %s: %w", result.JobID, err)
	}

	return nil
}

func GetResult(ctx context.Context, client *redis.Client, jobID string) (*ResultRecord, error) {
	raw, err := client.Get(ctx, resultKey(jobID)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get result %s: %w", jobID, err)
	}

	var result ResultRecord
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("unmarshal result %s: %w", jobID, err)
	}

	return &result, nil
}
