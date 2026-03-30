FROM golang:1.25-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -o /out/worker ./cmd/worker

FROM docker:29-cli

RUN adduser -D -h /app worker
USER worker
WORKDIR /app

COPY --from=build /out/worker /usr/local/bin/worker

ENTRYPOINT ["worker"]
