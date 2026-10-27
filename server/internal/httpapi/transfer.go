package httpapi

import (
	"net/http"
)

func (s *Server) contextRecipient(w http.ResponseWriter, r *http.Request) {
	if s.contexts.Transfer == nil {
		writeError(w, 503, "transfers unavailable")
		return
	}
	q := r.URL.Query()
	recipient, err := s.contexts.Transfer.ResolveRecipient(
		r.Context(),
		q.Get("asset"),
		q.Get("query"),
	)
	if err != nil {
		contextError(w, err)
		return
	}
	writeJSON(w, 200, recipient)
}

func (s *Server) contextQuote(w http.ResponseWriter, r *http.Request) {
	if s.contexts.Transfer == nil {
		writeError(w, 503, "transfers unavailable")
		return
	}
	var body struct {
		Asset     string `json:"asset"`
		Recipient string `json:"recipient"`
		Units     string `json:"units"`
	}
	if !decode(w, r, &body) {
		writeError(w, 400, "invalid")
		return
	}
	q, err := s.contexts.Transfer.QuoteTransfer(r.Context(), body.Asset, body.Recipient, body.Units)
	if err != nil {
		contextError(w, err)
		return
	}
	writeJSON(w, 201, q)
}

func (s *Server) contextTransfer(w http.ResponseWriter, r *http.Request) {
	if s.contexts.Transfer == nil {
		writeError(w, 503, "transfers unavailable")
		return
	}
	key, ok := requestKey(w, r)
	if !ok {
		return
	}
	var body struct {
		QuoteID string `json:"quoteId"`
	}
	if !decode(w, r, &body) {
		writeError(w, 400, "invalid")
		return
	}
	receipt, err := s.contexts.Transfer.ConfirmTransfer(r.Context(), body.QuoteID, key)
	if err != nil {
		contextError(w, err)
		return
	}
	writeJSON(w, 200, receipt)
}
