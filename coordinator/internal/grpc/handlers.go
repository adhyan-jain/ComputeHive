package grpcserver

import (
	"context"
	"fmt"
	"time"

	pb "coordinator/pkg/pb"
)

func (s *Server) RegisterWorker(ctx context.Context, req *pb.RegisterWorkerRequest) (*pb.RegisterWorkerResponse, error) {
	_ = s
	_ = ctx
	_ = req

	return &pb.RegisterWorkerResponse{
		WorkerId:                 &pb.WorkerID{Value: fmt.Sprintf("worker-%d", time.Now().UnixNano())},
		HeartbeatIntervalSeconds: 10,
	}, nil
}

func (s *Server) Heartbeat(ctx context.Context, req *pb.HeartbeatRequest) (*pb.HeartbeatResponse, error) {
	_ = s
	_ = ctx
	_ = req

	return &pb.HeartbeatResponse{
		Accepted:       true,
		ServerTimeUnix: time.Now().Unix(),
	}, nil
}

func (s *Server) RequestJob(ctx context.Context, req *pb.RequestJobRequest) (*pb.RequestJobResponse, error) {
	_ = s
	_ = ctx
	_ = req

	return &pb.RequestJobResponse{HasJob: false}, nil
}

func (s *Server) SubmitResult(ctx context.Context, req *pb.SubmitResultRequest) (*pb.SubmitResultResponse, error) {
	_ = s
	_ = ctx
	_ = req

	return &pb.SubmitResultResponse{Accepted: true}, nil
}

func (s *Server) SubmitJob(ctx context.Context, req *pb.SubmitJobRequest) (*pb.SubmitJobResponse, error) {
	_ = s
	_ = ctx
	_ = req

	return &pb.SubmitJobResponse{
		JobId:  &pb.JobID{Value: fmt.Sprintf("job-%d", time.Now().UnixNano())},
		Status: pb.Status_STATUS_QUEUED,
	}, nil
}

func (s *Server) GetJobStatus(ctx context.Context, req *pb.GetJobStatusRequest) (*pb.GetJobStatusResponse, error) {
	_ = s
	_ = ctx
	_ = req

	return &pb.GetJobStatusResponse{
		Status:        pb.Status_STATUS_QUEUED,
		UpdatedAtUnix: time.Now().Unix(),
	}, nil
}

func (s *Server) GetJobResult(ctx context.Context, req *pb.GetJobResultRequest) (*pb.GetJobResultResponse, error) {
	_ = s
	_ = ctx
	_ = req

	return &pb.GetJobResultResponse{
		Status:          pb.Status_STATUS_RUNNING,
		ResultAvailable: false,
	}, nil
}
