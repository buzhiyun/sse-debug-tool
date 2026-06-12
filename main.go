package main

import (
	"bufio"
	"crypto/tls"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

//go:embed static
var staticFiles embed.FS

type ProxyRequest struct {
	URL      string            `json:"url"`
	Method   string            `json:"method"`
	Headers  map[string]string `json:"headers"`
	Body     string            `json:"body"`
	BodyType string            `json:"bodyType"`
	Form     map[string]string `json:"form"`
	SkipSSL  bool              `json:"skipSSL"`
}

type SSEEvent struct {
	Event string `json:"event"`
	Data  string `json:"data"`
	ID    string `json:"id,omitempty"`
}

func main() {
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(staticFS)))
	mux.HandleFunc("/api/proxy", handleProxy)

	log.Println("SSE Debug Tool starting on http://localhost:8765")
	log.Fatal(http.ListenAndServe(":8765", mux))
}

func handleProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ProxyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

	var bodyReader io.Reader
	switch req.BodyType {
	case "form":
		form := url.Values{}
		for k, v := range req.Form {
			form.Set(k, v)
		}
		bodyReader = strings.NewReader(form.Encode())
	case "json", "raw":
		if req.Body != "" {
			bodyReader = strings.NewReader(req.Body)
		}
	}

	// No total timeout — SSE streams can run arbitrarily long.
	// Only limit connection establishment and idle time.
	targetReq, err := http.NewRequestWithContext(r.Context(), req.Method, req.URL, bodyReader)
	if err != nil {
		writeSSEHeaders(w)
		flusher, _ := w.(http.Flusher)
		writeSSE(w, flusher, "error", map[string]string{"message": fmt.Sprintf("Invalid URL: %v", err)})
		writeSSE(w, flusher, "done", nil)
		return
	}

	for k, v := range req.Headers {
		targetReq.Header.Set(k, v)
	}
	if req.BodyType == "form" {
		targetReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}

	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: req.SkipSSL,
		},
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		IdleConnTimeout:       120 * time.Second,
	}
	// No Timeout on client — SSE streams must not have a total deadline.
	client := &http.Client{
		Transport: transport,
	}

	resp, err := client.Do(targetReq)
	if err != nil {
		writeSSEHeaders(w)
		flusher, _ := w.(http.Flusher)
		writeSSE(w, flusher, "error", map[string]string{"message": err.Error()})
		writeSSE(w, flusher, "done", nil)
		return
	}
	defer resp.Body.Close()

	contentType := resp.Header.Get("Content-Type")
	isSSE := strings.Contains(contentType, "text/event-stream")

	writeSSEHeaders(w)
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming not supported", http.StatusInternalServerError)
		return
	}

	writeSSE(w, flusher, "meta", map[string]interface{}{
		"status":  resp.StatusCode,
		"headers": flattenHeaders(resp.Header),
		"isSSE":   isSSE,
	})

	if isSSE && resp.StatusCode < 400 {
		parseSSEStream(resp.Body, w, flusher)
	} else {
		streamRawBody(resp.Body, w, flusher)
	}

	writeSSE(w, flusher, "done", nil)
}

func parseSSEStream(body io.Reader, w http.ResponseWriter, flusher http.Flusher) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var event SSEEvent
	idleTimer := time.NewTimer(15 * time.Second)
	defer idleTimer.Stop()

	// Channel for scanner lines
	lineCh := make(chan string, 256)
	go func() {
		for scanner.Scan() {
			lineCh <- scanner.Text()
		}
		close(lineCh)
	}()

	for {
		select {
		case line, ok := <-lineCh:
			if !ok {
				// Scanner finished
				if event.Data != "" || event.Event != "" {
					writeSSE(w, flusher, "sse", event)
				}
				return
			}
			idleTimer.Reset(15 * time.Second)

			if line == "" {
				if event.Data != "" || event.Event != "" {
					writeSSE(w, flusher, "sse", event)
					event = SSEEvent{}
				}
				continue
			}

			if strings.HasPrefix(line, ":") {
				writeSSE(w, flusher, "comment", strings.TrimSpace(strings.TrimPrefix(line, ":")))
				continue
			}

			field, value, ok := parseSSEField(line)
			if !ok {
				continue
			}

			switch field {
			case "event":
				event.Event = value
			case "data":
				if event.Data != "" {
					event.Data += "\n"
				}
				event.Data += value
			case "id":
				event.ID = value
			case "retry":
				// handled client-side
			}

		case <-idleTimer.C:
			// Upstream idle too long — send keepalive to browser
			writeSSE(w, flusher, "comment", "keepalive")
			idleTimer.Reset(15 * time.Second)
		}
	}
}

func parseSSEField(line string) (string, string, bool) {
	colonIdx := strings.IndexByte(line, ':')
	if colonIdx < 0 {
		return line, "", true
	}
	field := line[:colonIdx]
	value := line[colonIdx+1:]
	if len(value) > 0 && value[0] == ' ' {
		value = value[1:]
	}
	return field, value, true
}

func streamRawBody(body io.Reader, w http.ResponseWriter, flusher http.Flusher) {
	buf := make([]byte, 4096)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			writeSSE(w, flusher, "chunk", map[string]string{"data": string(buf[:n])})
		}
		if err != nil {
			break
		}
	}
}

func writeSSEHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, event string, data interface{}) {
	jsonData, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(jsonData))
	flusher.Flush()
}

func flattenHeaders(h http.Header) map[string]string {
	m := make(map[string]string)
	for k, v := range h {
		m[k] = strings.Join(v, ", ")
	}
	return m
}
