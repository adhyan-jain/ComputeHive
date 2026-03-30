package domain

import "time"

const (
	WorkerStatusIdle = "idle"
	WorkerStatusBusy = "busy"
)

type ResourceSnapshot struct {
	Hostname             string   `json:"hostname"`
	OS                   string   `json:"os"`
	Arch                 string   `json:"arch"`
	CPUCores             int      `json:"cpu_cores"`
	MemoryTotalBytes     uint64   `json:"memory_total_bytes,omitempty"`
	MemoryAvailableBytes uint64   `json:"memory_available_bytes,omitempty"`
	GPUCount             int      `json:"gpu_count"`
	GPUModels            []string `json:"gpu_models,omitempty"`
	DockerAvailable      bool     `json:"docker_available"`
	DockerVersion        string   `json:"docker_version,omitempty"`
}

type WorkerHeartbeat struct {
	WorkerID      string           `json:"worker_id"`
	Status        string           `json:"status"`
	CurrentJobID  string           `json:"current_job_id,omitempty"`
	LastSeen      time.Time        `json:"last_seen"`
	UptimeSeconds int64            `json:"uptime_seconds"`
	Version       string           `json:"version"`
	Resource      ResourceSnapshot `json:"resource"`
}
