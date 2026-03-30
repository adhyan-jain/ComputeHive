package domain

import (
	"fmt"
	"strings"
	"time"
)

const (
	JobStatusPreparing = "preparing"
	JobStatusRunning   = "running"
	JobStatusSucceeded = "succeeded"
	JobStatusFailed    = "failed"
)

type Job struct {
	ID             string            `json:"id,omitempty"`
	TaskID         string            `json:"task_id,omitempty"`
	ArtifactURL    string            `json:"artifact_url,omitempty"`
	S3URL          string            `json:"s3_url,omitempty"`
	ArtifactSHA256 string            `json:"artifact_sha256,omitempty"`
	ImageHash      string            `json:"image_hash,omitempty"`
	ImageRef       string            `json:"image_ref"`
	Command        []string          `json:"command,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	GPU            bool              `json:"gpu,omitempty"`
	CPUCores       float64           `json:"cpu_cores,omitempty"`
	MemoryMB       int64             `json:"memory_mb,omitempty"`
	TimeoutSeconds int               `json:"timeout_seconds,omitempty"`
}

func (j *Job) Normalize() {
	normalized := j.normalized()
	*j = normalized
}

func (j Job) Validate() error {
	j = j.normalized()

	if strings.TrimSpace(j.ID) == "" {
		return fmt.Errorf("job id is required")
	}
	if strings.TrimSpace(j.ArtifactURL) == "" {
		return fmt.Errorf("job artifact_url is required")
	}
	if strings.TrimSpace(j.ArtifactSHA256) == "" {
		return fmt.Errorf("job artifact_sha256 is required")
	}
	if strings.TrimSpace(j.ImageRef) == "" {
		return fmt.Errorf("job image_ref is required")
	}
	if j.CPUCores < 0 {
		return fmt.Errorf("cpu_cores must be >= 0")
	}
	if j.MemoryMB < 0 {
		return fmt.Errorf("memory_mb must be >= 0")
	}
	if j.TimeoutSeconds < 0 {
		return fmt.Errorf("timeout_seconds must be >= 0")
	}

	return nil
}

func (j Job) normalized() Job {
	if strings.TrimSpace(j.ID) == "" {
		j.ID = strings.TrimSpace(j.TaskID)
	}
	if strings.TrimSpace(j.ArtifactURL) == "" {
		j.ArtifactURL = strings.TrimSpace(j.S3URL)
	}
	if strings.TrimSpace(j.ArtifactSHA256) == "" {
		j.ArtifactSHA256 = strings.TrimSpace(j.ImageHash)
	}

	return j
}

type JobStatusUpdate struct {
	JobID      string     `json:"job_id"`
	WorkerID   string     `json:"worker_id"`
	Status     string     `json:"status"`
	Message    string     `json:"message,omitempty"`
	UpdatedAt  time.Time  `json:"updated_at"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

type JobResult struct {
	JobID             string    `json:"job_id"`
	WorkerID          string    `json:"worker_id"`
	Status            string    `json:"status"`
	StartedAt         time.Time `json:"started_at"`
	FinishedAt        time.Time `json:"finished_at"`
	DurationMillis    int64     `json:"duration_millis"`
	ExitCode          int       `json:"exit_code"`
	ImageRef          string    `json:"image_ref,omitempty"`
	ArtifactSHA256    string    `json:"artifact_sha256,omitempty"`
	ArtifactSizeBytes int64     `json:"artifact_size_bytes,omitempty"`
	Stdout            string    `json:"stdout,omitempty"`
	Stderr            string    `json:"stderr,omitempty"`
	Error             string    `json:"error,omitempty"`
}
