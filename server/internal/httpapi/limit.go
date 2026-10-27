package httpapi

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

type window struct {
	start time.Time
	n     int
}

// limiter is a per-user fixed window held in memory.
// shortcut: per replica and per user only; a gateway limiter per IP stays the primary defence.
type limiter struct {
	mu      sync.Mutex
	windows map[string]window
	start   time.Time
}

// limit allows at most n calls per minute for one user and route; it must run after authentication.
func (s *Server) limit(route string, n int, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		now := time.Now()
		key := route + "\x00" + userFrom(r.Context()).ID
		s.limits.mu.Lock()
		// Rotate the fixed window in O(1); never scan all users under the lock.
		if s.limits.windows == nil || now.Sub(s.limits.start) >= time.Minute {
			s.limits.windows = map[string]window{}
			s.limits.start = now
		}
		v := s.limits.windows[key]
		v.start = s.limits.start
		v.n++
		s.limits.windows[key] = v
		retry := int(time.Minute-now.Sub(v.start)) / int(time.Second)
		s.limits.mu.Unlock()
		if v.n > n {
			w.Header().Set("Retry-After", strconv.Itoa(retry+1))
			writeError(w, http.StatusTooManyRequests, "rate_limited")
			return
		}
		next(w, r)
	}
}
