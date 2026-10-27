package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTransferRateLimitIsPerUserAndRoute(t *testing.T) {
	s := &Server{}
	next := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }
	recipient := s.limit("recipient", 2, next)
	request := func(handler http.HandlerFunc, user string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/", nil)
		r = r.WithContext(context.WithValue(r.Context(), userContextKey, User{ID: user}))
		w := httptest.NewRecorder()
		handler(w, r)
		return w
	}
	for i := 0; i < 2; i++ {
		if w := request(recipient, "alice"); w.Code != http.StatusNoContent {
			t.Fatal(w.Code)
		}
	}
	if w := request(recipient, "alice"); w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" || !strings.Contains(w.Body.String(), "rate_limited") {
		t.Fatal(w)
	}
	if w := request(recipient, "bob"); w.Code != http.StatusNoContent {
		t.Fatal(w.Code)
	}
	if w := request(s.limit("quote", 2, next), "alice"); w.Code != http.StatusNoContent {
		t.Fatal(w.Code)
	}
}

func TestTransferRateLimitHoldsUnderConcurrentRequests(t *testing.T) {
	s := &Server{}
	var passed, limited atomic.Int32
	handler := s.limit("recipient", 10, func(w http.ResponseWriter, _ *http.Request) { passed.Add(1); w.WriteHeader(http.StatusNoContent) })
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("GET", "/", nil)
			r = r.WithContext(context.WithValue(r.Context(), userContextKey, User{ID: "alice"}))
			w := httptest.NewRecorder()
			handler(w, r)
			if w.Code == http.StatusTooManyRequests {
				limited.Add(1)
			}
		}()
	}
	wg.Wait()
	if passed.Load() != 10 || limited.Load() != 40 {
		t.Fatal(passed.Load(), limited.Load())
	}
}

func TestLimiterDiscardsOldWindowWithoutRetainingInactiveUsers(t *testing.T) {
	s := &Server{}
	s.limits.start = time.Now().Add(-2 * time.Minute)
	s.limits.windows = map[string]window{"old-user": {start: s.limits.start, n: 100}}
	r := httptest.NewRequest("GET", "/", nil).WithContext(context.WithValue(context.Background(), userContextKey, User{ID: "alice"}))
	w := httptest.NewRecorder()
	s.limit("recipient", 1, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })(w, r)
	if w.Code != http.StatusNoContent || len(s.limits.windows) != 1 {
		t.Fatal(w.Code, s.limits.windows)
	}
	if _, ok := s.limits.windows["old-user"]; ok {
		t.Fatal("old window retained")
	}
}
