package config

import (
	"os"
	"strings"
)

// Config holds runtime settings for the coordinator process.
type Config struct {
	GRPCPort  string
	RedisAddr string
}

func Load() Config {
	return Config{
		GRPCPort:  getEnv("GRPC_PORT", "50051"),
		RedisAddr: getEnv("REDIS_ADDR", "localhost:6379"),
	}
}

func (c Config) GRPCListenAddr() string {
	if strings.HasPrefix(c.GRPCPort, ":") {
		return c.GRPCPort
	}
	return ":" + c.GRPCPort
}

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		return value
	}
	return fallback
}
