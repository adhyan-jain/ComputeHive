package store

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/adhyan-jain/ComputeHive/worker/internal/config"
	"github.com/adhyan-jain/ComputeHive/worker/internal/domain"
)

type Store struct {
	cfg config.Config
}

func New(cfg config.Config) *Store {
	return &Store{cfg: cfg}
}

func (s *Store) PullJob(ctx context.Context) (*domain.Job, bool, error) {
	payload, found, err := s.brpop(ctx, s.cfg.QueueKey, s.cfg.PollTimeout)
	if err != nil || !found {
		return nil, found, err
	}

	var job domain.Job
	if err := json.Unmarshal([]byte(payload), &job); err != nil {
		return nil, false, fmt.Errorf("unmarshal job payload: %w", err)
	}

	return &job, true, nil
}

func (s *Store) PublishHeartbeat(ctx context.Context, heartbeat domain.WorkerHeartbeat) error {
	data, err := json.Marshal(heartbeat)
	if err != nil {
		return err
	}

	key := fmt.Sprintf("%s:%s:heartbeat", s.cfg.WorkerKeyPrefix, heartbeat.WorkerID)
	if err := s.setEx(ctx, key, string(data), s.cfg.HeartbeatTTL); err != nil {
		return err
	}

	return s.publish(ctx, s.cfg.WorkerEventsChannel, string(data))
}

func (s *Store) PublishJobStatus(ctx context.Context, status domain.JobStatusUpdate) error {
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}

	key := fmt.Sprintf("%s:%s:status", s.cfg.JobKeyPrefix, status.JobID)
	if err := s.setEx(ctx, key, string(data), s.cfg.ResultTTL); err != nil {
		return err
	}

	return s.publish(ctx, s.cfg.JobEventsChannel, string(data))
}

func (s *Store) PublishJobResult(ctx context.Context, result domain.JobResult) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}

	key := fmt.Sprintf("%s:%s:result", s.cfg.JobKeyPrefix, result.JobID)
	if err := s.setEx(ctx, key, string(data), s.cfg.ResultTTL); err != nil {
		return err
	}
	if err := s.lpush(ctx, s.cfg.ResultsKey, string(data)); err != nil {
		return err
	}

	return s.publish(ctx, s.cfg.JobEventsChannel, string(data))
}

func (s *Store) setEx(ctx context.Context, key, value string, ttl time.Duration) error {
	seconds := max(1, int(ttl/time.Second))
	_, err := s.do(ctx, s.cfg.RedisIOTimeout, "SET", key, value, "EX", strconv.Itoa(seconds))
	return err
}

func (s *Store) publish(ctx context.Context, channel, message string) error {
	_, err := s.do(ctx, s.cfg.RedisIOTimeout, "PUBLISH", channel, message)
	return err
}

func (s *Store) lpush(ctx context.Context, key, value string) error {
	_, err := s.do(ctx, s.cfg.RedisIOTimeout, "LPUSH", key, value)
	return err
}

func (s *Store) brpop(ctx context.Context, key string, timeout time.Duration) (string, bool, error) {
	seconds := max(1, int(timeout/time.Second))
	reply, err := s.do(ctx, timeout+s.cfg.RedisIOTimeout, "BRPOP", key, strconv.Itoa(seconds))
	if err != nil {
		return "", false, err
	}
	if reply.nil {
		return "", false, nil
	}
	if len(reply.array) != 2 {
		return "", false, fmt.Errorf("unexpected BRPOP reply length %d", len(reply.array))
	}

	return reply.array[1].String(), true, nil
}

func (s *Store) do(ctx context.Context, timeout time.Duration, args ...string) (respValue, error) {
	conn, reader, err := s.open(ctx, timeout)
	if err != nil {
		return respValue{}, err
	}
	defer conn.Close()

	if err := writeCommand(conn, args); err != nil {
		return respValue{}, err
	}

	return readReply(reader)
}

func (s *Store) open(ctx context.Context, timeout time.Duration) (net.Conn, *bufio.Reader, error) {
	dialer := net.Dialer{Timeout: s.cfg.RedisDialTimeout}
	var (
		conn net.Conn
		err  error
	)
	if s.cfg.RedisUseTLS {
		tlsDialer := tls.Dialer{
			NetDialer: &dialer,
			Config: &tls.Config{
				MinVersion: tls.VersionTLS12,
				ServerName: redisServerName(s.cfg.RedisAddr),
			},
		}
		conn, err = tlsDialer.DialContext(ctx, "tcp", s.cfg.RedisAddr)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", s.cfg.RedisAddr)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("dial redis: %w", err)
	}

	deadline := time.Now().Add(timeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		conn.Close()
		return nil, nil, err
	}

	reader := bufio.NewReader(conn)
	if s.cfg.RedisPassword != "" {
		authArgs := []string{"AUTH"}
		if strings.TrimSpace(s.cfg.RedisUsername) != "" {
			authArgs = append(authArgs, s.cfg.RedisUsername)
		}
		authArgs = append(authArgs, s.cfg.RedisPassword)
		if _, err := s.simple(conn, reader, authArgs...); err != nil {
			conn.Close()
			return nil, nil, fmt.Errorf("redis auth: %w", err)
		}
	}
	if s.cfg.RedisDB != 0 {
		if _, err := s.simple(conn, reader, "SELECT", strconv.Itoa(s.cfg.RedisDB)); err != nil {
			conn.Close()
			return nil, nil, fmt.Errorf("redis select: %w", err)
		}
	}

	return conn, reader, nil
}

func (s *Store) simple(conn net.Conn, reader *bufio.Reader, args ...string) (respValue, error) {
	if err := writeCommand(conn, args); err != nil {
		return respValue{}, err
	}
	return readReply(reader)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func sanitizeError(message string) string {
	return strings.TrimSpace(message)
}

func redisServerName(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err == nil {
		return host
	}

	return addr
}
