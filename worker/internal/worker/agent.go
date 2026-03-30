package worker

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/adhyan-jain/ComputeHive/worker/internal/artifact"
	"github.com/adhyan-jain/ComputeHive/worker/internal/config"
	"github.com/adhyan-jain/ComputeHive/worker/internal/domain"
)

type storeAPI interface {
	PullJob(ctx context.Context) (*domain.Job, bool, error)
	PublishHeartbeat(ctx context.Context, heartbeat domain.WorkerHeartbeat) error
	PublishJobStatus(ctx context.Context, status domain.JobStatusUpdate) error
	PublishJobResult(ctx context.Context, result domain.JobResult) error
}

type fetcherAPI interface {
	Fetch(ctx context.Context, job domain.Job) (artifact.Bundle, error)
}

type reporterAPI interface {
	Snapshot(ctx context.Context) domain.ResourceSnapshot
}

type executorAPI interface {
	Run(ctx context.Context, job domain.Job, bundle artifact.Bundle) domain.JobResult
}

type Agent struct {
	cfg      config.Config
	store    storeAPI
	fetcher  fetcherAPI
	reporter reporterAPI
	executor executorAPI
	logger   *slog.Logger
	started  time.Time

	mu           sync.RWMutex
	status       string
	currentJobID string
}

func NewAgent(cfg config.Config, store storeAPI, fetcher fetcherAPI, reporter reporterAPI, executor executorAPI, logger *slog.Logger) *Agent {
	return &Agent{
		cfg:      cfg,
		store:    store,
		fetcher:  fetcher,
		reporter: reporter,
		executor: executor,
		logger:   logger,
		started:  time.Now().UTC(),
		status:   domain.WorkerStatusIdle,
	}
}

func (a *Agent) Run(ctx context.Context) error {
	a.logger.Info("worker started", "worker_id", a.cfg.WorkerID, "redis_addr", a.cfg.RedisAddr, "queue_key", a.cfg.QueueKey)

	go a.heartbeatLoop(ctx)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		job, found, err := a.store.PullJob(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			a.logger.Error("failed to pull job", "error", err)
			time.Sleep(time.Second)
			continue
		}
		if !found {
			continue
		}

		if err := a.handleJob(ctx, job); err != nil {
			a.logger.Error("job handling failed", "job_id", job.ID, "error", err)
		}
	}
}

func (a *Agent) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(a.cfg.HeartbeatInterval)
	defer ticker.Stop()

	a.publishHeartbeat(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.publishHeartbeat(ctx)
		}
	}
}

func (a *Agent) publishHeartbeat(ctx context.Context) {
	heartbeatCtx, cancel := context.WithTimeout(ctx, a.cfg.RedisIOTimeout+2*time.Second)
	defer cancel()

	status, currentJobID := a.state()
	heartbeat := domain.WorkerHeartbeat{
		WorkerID:      a.cfg.WorkerID,
		Status:        status,
		CurrentJobID:  currentJobID,
		LastSeen:      time.Now().UTC(),
		UptimeSeconds: int64(time.Since(a.started).Seconds()),
		Version:       a.cfg.Version,
		Resource:      a.reporter.Snapshot(heartbeatCtx),
	}

	if err := a.store.PublishHeartbeat(heartbeatCtx, heartbeat); err != nil && heartbeatCtx.Err() == nil {
		a.logger.Warn("failed to publish heartbeat", "error", err)
	}
}

func (a *Agent) handleJob(ctx context.Context, job *domain.Job) error {
	job.Normalize()
	if err := job.Validate(); err != nil {
		return a.publishInvalidJob(ctx, *job, err)
	}

	startedAt := time.Now().UTC()
	a.setState(domain.WorkerStatusBusy, job.ID)
	defer a.setState(domain.WorkerStatusIdle, "")

	a.logger.Info("starting job", "job_id", job.ID, "artifact_url", job.ArtifactURL, "image_ref", job.ImageRef)

	preparingStatus := domain.JobStatusUpdate{
		JobID:     job.ID,
		WorkerID:  a.cfg.WorkerID,
		Status:    domain.JobStatusPreparing,
		Message:   "downloading and verifying image artifact",
		UpdatedAt: startedAt,
		StartedAt: &startedAt,
	}
	if err := a.store.PublishJobStatus(ctx, preparingStatus); err != nil {
		return fmt.Errorf("publish preparing status: %w", err)
	}

	timeout := a.cfg.DefaultJobTimeout
	if job.TimeoutSeconds > 0 {
		timeout = time.Duration(job.TimeoutSeconds) * time.Second
	}

	jobCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	bundle, err := a.fetcher.Fetch(jobCtx, *job)
	if err != nil {
		return a.publishFailedJob(ctx, *job, startedAt, err)
	}
	defer func() {
		if err := artifact.Cleanup(bundle); err != nil {
			a.logger.Warn("failed to cleanup artifact bundle", "job_id", job.ID, "error", err)
		}
	}()

	runningAt := time.Now().UTC()
	runningStatus := domain.JobStatusUpdate{
		JobID:     job.ID,
		WorkerID:  a.cfg.WorkerID,
		Status:    domain.JobStatusRunning,
		Message:   "artifact verified; loading image and starting container",
		UpdatedAt: runningAt,
		StartedAt: &startedAt,
	}
	if err := a.store.PublishJobStatus(ctx, runningStatus); err != nil {
		return fmt.Errorf("publish running status: %w", err)
	}

	result := a.executor.Run(jobCtx, *job, bundle)

	if strings.TrimSpace(result.Status) == "" {
		result.Status = domain.JobStatusFailed
	}
	if result.JobID == "" {
		result.JobID = job.ID
	}
	if result.WorkerID == "" {
		result.WorkerID = a.cfg.WorkerID
	}

	if err := a.store.PublishJobResult(ctx, result); err != nil {
		return fmt.Errorf("publish job result: %w", err)
	}

	finishedAt := result.FinishedAt
	statusMessage := "job completed"
	if result.Status == domain.JobStatusFailed {
		statusMessage = strings.TrimSpace(result.Error)
		if statusMessage == "" {
			statusMessage = "job failed"
		}
	}

	finalStatus := domain.JobStatusUpdate{
		JobID:      job.ID,
		WorkerID:   a.cfg.WorkerID,
		Status:     result.Status,
		Message:    statusMessage,
		UpdatedAt:  finishedAt,
		StartedAt:  &startedAt,
		FinishedAt: &finishedAt,
	}
	if err := a.store.PublishJobStatus(ctx, finalStatus); err != nil {
		return fmt.Errorf("publish final job status: %w", err)
	}

	a.logger.Info("finished job", "job_id", job.ID, "status", result.Status, "exit_code", result.ExitCode)
	return nil
}

func (a *Agent) publishFailedJob(ctx context.Context, job domain.Job, startedAt time.Time, taskErr error) error {
	finishedAt := time.Now().UTC()
	result := domain.JobResult{
		JobID:          job.ID,
		WorkerID:       a.cfg.WorkerID,
		Status:         domain.JobStatusFailed,
		StartedAt:      startedAt,
		FinishedAt:     finishedAt,
		DurationMillis: finishedAt.Sub(startedAt).Milliseconds(),
		ExitCode:       -1,
		ImageRef:       job.ImageRef,
		ArtifactSHA256: job.ArtifactSHA256,
		Error:          taskErr.Error(),
	}
	if err := a.store.PublishJobResult(ctx, result); err != nil {
		return err
	}

	status := domain.JobStatusUpdate{
		JobID:      job.ID,
		WorkerID:   a.cfg.WorkerID,
		Status:     domain.JobStatusFailed,
		Message:    taskErr.Error(),
		UpdatedAt:  finishedAt,
		StartedAt:  &startedAt,
		FinishedAt: &finishedAt,
	}
	return a.store.PublishJobStatus(ctx, status)
}

func (a *Agent) publishInvalidJob(ctx context.Context, job domain.Job, validationErr error) error {
	if strings.TrimSpace(job.ID) == "" {
		return validationErr
	}

	now := time.Now().UTC()
	result := domain.JobResult{
		JobID:          job.ID,
		WorkerID:       a.cfg.WorkerID,
		Status:         domain.JobStatusFailed,
		StartedAt:      now,
		FinishedAt:     now,
		DurationMillis: 0,
		ExitCode:       -1,
		ImageRef:       job.ImageRef,
		ArtifactSHA256: job.ArtifactSHA256,
		Error:          validationErr.Error(),
	}
	if err := a.store.PublishJobResult(ctx, result); err != nil {
		return err
	}

	status := domain.JobStatusUpdate{
		JobID:      job.ID,
		WorkerID:   a.cfg.WorkerID,
		Status:     domain.JobStatusFailed,
		Message:    validationErr.Error(),
		UpdatedAt:  now,
		FinishedAt: &now,
	}
	return a.store.PublishJobStatus(ctx, status)
}

func (a *Agent) setState(status, currentJobID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.status = status
	a.currentJobID = currentJobID
}

func (a *Agent) state() (string, string) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.status, a.currentJobID
}
