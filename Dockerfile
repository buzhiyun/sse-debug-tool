FROM golang:1.22-alpine AS builder
WORKDIR /build
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -buildvcs=false -o sse-debug-tool .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /build/sse-debug-tool /usr/local/bin/sse-debug-tool
EXPOSE 8765
ENTRYPOINT ["sse-debug-tool"]
