package grpcserver

import (
	"context"
	"fmt"
	"log"
	"net"

	"coordinator/internal/config"
	pb "coordinator/pkg/pb"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
)

// Server implements both worker-facing and client-facing gRPC services.
type Server struct {
	pb.UnimplementedWorkerServiceServer
	pb.UnimplementedClientServiceServer
	redis *redis.Client
}

func NewServer(redisClient *redis.Client) *Server {
	return &Server{redis: redisClient}
}

func Start(ctx context.Context, cfg config.Config, svc *Server) error {
	listener, err := net.Listen("tcp", cfg.GRPCListenAddr())
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.GRPCListenAddr(), err)
	}

	grpcServer := grpc.NewServer()
	pb.RegisterWorkerServiceServer(grpcServer, svc)
	pb.RegisterClientServiceServer(grpcServer, svc)

	go func() {
		<-ctx.Done()
		grpcServer.GracefulStop()
	}()

	log.Printf("coordinator gRPC server listening on %s", cfg.GRPCListenAddr())
	return grpcServer.Serve(listener)
}
