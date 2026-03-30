package config

import (
	"testing"
	"time"
)

func TestParseUsesEnvironmentDefaults(t *testing.T) {
	getenv := func(key string) string {
		values := map[string]string{
			"WORKER_ID":                 "worker-test-01",
			"REDIS_ADDR":                "redis.internal:6379",
			"HEARTBEAT_INTERVAL":        "9s",
			"ALLOW_GPU_JOBS":            "false",
			"ARTIFACT_DOWNLOAD_TIMEOUT": "3m",
			"ARTIFACT_MAX_BYTES":        "2048",
		}
		return values[key]
	}

	cfg, err := parse(nil, getenv)
	if err != nil {
		t.Fatalf("parse returned error: %v", err)
	}

	if cfg.WorkerID != "worker-test-01" {
		t.Fatalf("expected worker id from env, got %q", cfg.WorkerID)
	}
	if cfg.RedisAddr != "redis.internal:6379" {
		t.Fatalf("expected redis addr from env, got %q", cfg.RedisAddr)
	}
	if cfg.HeartbeatInterval != 9*time.Second {
		t.Fatalf("expected heartbeat interval 9s, got %v", cfg.HeartbeatInterval)
	}
	if cfg.AllowGPUJobs {
		t.Fatalf("expected allow-gpu-jobs to be false")
	}
	if cfg.ArtifactDownloadTimeout != 3*time.Minute {
		t.Fatalf("expected artifact download timeout 3m, got %v", cfg.ArtifactDownloadTimeout)
	}
	if cfg.ArtifactMaxBytes != 2048 {
		t.Fatalf("expected artifact max bytes 2048, got %d", cfg.ArtifactMaxBytes)
	}
}

func TestParseAllowsFlagOverrides(t *testing.T) {
	getenv := func(key string) string {
		values := map[string]string{
			"WORKER_ID":  "worker-env",
			"REDIS_ADDR": "redis-env:6379",
		}
		return values[key]
	}

	cfg, err := parse([]string{"-worker-id", "worker-flag", "-redis-addr", "redis-flag:6379"}, getenv)
	if err != nil {
		t.Fatalf("parse returned error: %v", err)
	}

	if cfg.WorkerID != "worker-flag" {
		t.Fatalf("expected worker id to come from flags, got %q", cfg.WorkerID)
	}
	if cfg.RedisAddr != "redis-flag:6379" {
		t.Fatalf("expected redis addr to come from flags, got %q", cfg.RedisAddr)
	}
}
