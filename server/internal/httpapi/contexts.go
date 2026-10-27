package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	cv1 "github.com/voxel-vault/api/internal/currency/contracts/v1"
	iv1 "github.com/voxel-vault/api/internal/inventory/contracts/v1"
	wv1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
)

type ContextPorts struct {
	UserContext func(context.Context, string) context.Context
	Collection  iv1.CollectionClient
	Workshop    iv1.WorkshopClient
	Wallet      wv1.ReadClient
	Transfer    wv1.TransferClient
	Currency    cv1.Provider
	Subjects    SubjectDirectory
	// Per-user requests per minute for the transfer routes; all must be positive.
	RecipientPerMinute, QuotePerMinute, TransferPerMinute int
}

type SubjectDirectory interface {
	Exists(context.Context, string) (bool, error)
}

func (s *Server) guardEconomy(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if err := s.economyGuard(r.Context()); err != nil {
			writeError(w, 503, "economy temporarily unavailable")
			return
		}
		next(w, r)
	}
}

func (s *Server) contextRoutes() {
	player := func(method, path string, h http.HandlerFunc) {
		pattern := strings.NewReplacer("{instanceID}", ":instanceID", "{itemID}", ":itemID", "{operationID}", ":operationID").
			Replace(path)
		h = s.requirePermission(pattern, method, s.guardEconomy(h))
		if method != "GET" {
			h = s.sameOrigin(h)
		}
		s.mux.HandleFunc(method+" "+path, h)
	}
	player("GET", "/api/v1/inventory", s.contextInventory)
	player("POST", "/api/v1/inventory/{instanceID}/claim", s.contextClaim)
	player("POST", "/api/v1/inventory/{instanceID}/open", s.contextOpen)
	player("GET", "/api/v1/inventory/merge", s.contextOdds)
	player("POST", "/api/v1/inventory/merge", s.contextMergeChests)
	player("GET", "/api/v1/inventory/items", s.contextItems)
	player("POST", "/api/v1/inventory/items/merge", s.contextMergeItems)
	for _, action := range []string{"repair", "salvage", "sell"} {
		player("POST", "/api/v1/inventory/items/{itemID}/"+action, s.contextWork(action))
	}
	player("GET", "/api/v1/inventory/operations/{operationID}", s.contextOperation)
	player("POST", "/api/v1/inventory/operations/{operationID}/cancel", s.contextCancel)
	player("GET", "/api/v1/wallet", s.contextWallet)
	player("GET", "/api/v1/wallet/transactions", s.contextHistory)
	player("GET", "/api/v1/wallet/recipient", s.limit("recipient", s.contexts.RecipientPerMinute, s.contextRecipient))
	player("POST", "/api/v1/wallet/quotes", s.limit("quote", s.contexts.QuotePerMinute, s.contextQuote))
	player("POST", "/api/v1/wallet/transfers", s.limit("transfer", s.contexts.TransferPerMinute, s.contextTransfer))
	s.mux.HandleFunc(
		"POST /api/v1/admin/users/{userID}/chests",
		s.sameOrigin(
			s.requirePermission(
				"/api/v1/admin/users/:userID/chests",
				"POST",
				s.guardEconomy(s.contextGrant),
			),
		),
	)
}

func contextError(w http.ResponseWriter, err error) {
	var i *iv1.Error
	var wallet *wv1.Error
	code := "unavailable"
	if errors.As(err, &i) {
		code = i.Code
	}
	if errors.As(err, &wallet) {
		code = wallet.Code
	}
	var currencyError *cv1.Error
	if errors.As(err, &currencyError) {
		code = currencyError.Code
	}
	status := 503
	switch code {
	case "invalid":
		status = 400
	case "not_found":
		status = 404
	case "conflict", "not_ready":
		status = 409
	case "quote_expired", "insufficient_funds":
		status = 409
	case "forbidden":
		status = 403
	case "rate_limited":
		status = http.StatusTooManyRequests
	}
	writeError(w, status, code)
}

func requestKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.Header.Get("Idempotency-Key")
	if len(id) == 0 || len(id) > 160 || strings.TrimSpace(id) != id ||
		strings.ContainsAny(id, "\x00\r\n") {
		writeError(w, 400, "Idempotency-Key is required")
		return "", false
	}
	return id, true
}

type contextChestDTO struct {
	chestDTO
	ExactSeed string `json:"seed"`
}

func (s *Server) contextChest(x iv1.Chest) (contextChestDTO, error) {
	r := contextChestDTO{
		chestDTO: chestDTO{
			ID:          x.ID,
			CaseID:      x.Type,
			Status:      x.Status,
			Revision:    x.Revision,
			Rarity:      x.Rarity,
			Condition:   x.Condition,
			SessionID:   x.Session,
			DestroyedAt: x.DestroyedAt,
			Origin:      originDTO{Source: x.Source, Parents: x.Parents},
			Contents:    []contentDTO{},
			Traits:      []traitDTO{},
		},
		ExactSeed: x.Seed,
	}
	total := 0.0
	for _, slot := range x.Contents {
		total += slot.Weight
	}
	rb := s.rulebook()
	for _, slot := range x.Contents {
		r.Contents = append(
			r.Contents,
			contentDTO{
				Item:   rulebookItemDTO(rb, slot.Item, percent(slot.Weight, total)),
				Weight: slot.Weight,
			},
		)
	}
	for _, trait := range x.Traits {
		r.Traits = append(
			r.Traits,
			traitDTO{ID: trait.ID, Intensity: trait.Intensity, Seed: trait.Seed},
		)
	}
	if x.Drop != nil {
		r.Drop = &dropDTO{Item: rulebookItemDTO(rb, x.Drop.Item, 0), State: x.Drop.Condition}
	}
	if x.OpenedAt != nil {
		at, err := time.Parse(time.RFC3339Nano, *x.OpenedAt)
		if err != nil {
			return r, err
		}
		r.OpenedAt = &at
	}
	return r, nil
}

func (s *Server) contextInventory(w http.ResponseWriter, r *http.Request) {
	owner := userFrom(r.Context()).ID
	if err := s.contexts.Collection.GrantStarter(r.Context(), owner, s.starter); err != nil {
		contextError(w, err)
		return
	}
	cs, err := s.contexts.Collection.Chests(r.Context(), owner)
	if err != nil {
		contextError(w, err)
		return
	}
	result := []contextChestDTO{}
	for _, c := range cs {
		x, err := s.contextChest(c)
		if err != nil {
			writeError(w, 503, "invalid inventory response")
			return
		}
		result = append(result, x)
	}
	writeJSON(w, 200, result)
}

func (s *Server) contextClaim(w http.ResponseWriter, r *http.Request) {
	session, ok := sessionBody(w, r)
	if !ok {
		return
	}
	x, err := s.contexts.Collection.Claim(
		r.Context(),
		userFrom(r.Context()).ID,
		r.PathValue("instanceID"),
		session,
	)
	if err != nil {
		contextError(w, err)
		return
	}
	c, err := s.contextChest(x.Chest)
	if err != nil {
		writeError(w, 503, "invalid inventory response")
		return
	}
	writeJSON(w, 200, map[string]any{"chest": c, "landing": x.Landing})
}

func (s *Server) contextOpen(w http.ResponseWriter, r *http.Request) {
	session, ok := sessionBody(w, r)
	if !ok {
		return
	}
	x, err := s.contexts.Collection.Open(
		r.Context(),
		userFrom(r.Context()).ID,
		r.PathValue("instanceID"),
		session,
	)
	if err != nil {
		contextError(w, err)
		return
	}
	c, err := s.contextChest(x)
	if err != nil {
		writeError(w, 503, "invalid inventory response")
		return
	}
	body := map[string]any{"chest": c, "item": nil}
	if x.Reward != nil {
		v := x.Reward
		body["item"] = s.contextItem(
			iv1.Item{
				ID:         v.ID,
				Definition: v.Definition,
				Condition:  v.Condition,
				Origin:     v.Origin,
				Status:     "available",
			},
			nil,
		)
	}
	writeJSON(w, 200, body)
}

func (s *Server) contextOdds(w http.ResponseWriter, r *http.Request) {
	o, err := s.contexts.Collection.MergeOdds(
		r.Context(),
		userFrom(r.Context()).ID,
		r.URL.Query().Get("a"),
		r.URL.Query().Get("b"),
	)
	if err != nil {
		contextError(w, err)
		return
	}
	dto := mergeOddsDTO{
		Traits:   []traitOddsDTO{},
		Contents: contentsOddsDTO{Total: o.Contents, Kept: o.Size, Keep: percent(o.ItemKeep, 1)},
	}
	for _, t := range o.Traits {
		dto.Traits = append(
			dto.Traits,
			traitOddsDTO{ID: t.ID, Keep: percent(t.Keep, 1), Upgrade: percent(t.Upgrade, 1)},
		)
	}
	writeJSON(w, 200, dto)
}

func (s *Server) contextMergeChests(w http.ResponseWriter, r *http.Request) {
	key, ok := requestKey(w, r)
	if !ok {
		return
	}
	a, b, ok := pairBody(w, r)
	if !ok {
		return
	}
	x, err := s.contexts.Collection.MergeChests(
		r.Context(),
		iv1.PairRequest{Owner: userFrom(r.Context()).ID, RequestID: key, A: a, B: b},
	)
	if err != nil {
		contextError(w, err)
		return
	}
	c, err := s.contextChest(x)
	if err != nil {
		writeError(w, 503, "invalid inventory response")
		return
	}
	writeJSON(w, 201, c)
}

type contextAmountDTO struct {
	Resource string `json:"resource"`
	Value    string `json:"value"`
}
type contextOffersDTO struct {
	Repair      *contextAmountDTO `json:"repair"`
	Salvage     contextAmountDTO  `json:"salvage"`
	Sell        contextAmountDTO  `json:"sell"`
	MergeWith   string            `json:"mergeWith,omitempty"`
	MergeRepair float64           `json:"mergeRepair"`
}
type contextItemDTO struct {
	ownedItemDTO
	Offers      *contextOffersDTO `json:"offers,omitempty"`
	Status      string            `json:"status"`
	OperationID string            `json:"operationId,omitempty"`
}

func (s *Server) contextItem(x iv1.Item, o *iv1.Offers) contextItemDTO {
	r := contextItemDTO{
		ownedItemDTO: ownedItemDTO{
			ID:     x.ID,
			Item:   rulebookItemDTO(s.rulebook(), x.Definition, 0),
			State:  x.Condition,
			Origin: x.Origin,
		},
		Status:      x.Status,
		OperationID: x.OperationID,
	}
	a := func(x iv1.Amount) contextAmountDTO { return contextAmountDTO{Resource: x.Asset, Value: x.Units} }
	if o != nil {
		r.Offers = &contextOffersDTO{
			Salvage:     a(o.Salvage),
			Sell:        a(o.Sell),
			MergeWith:   o.MergeWith,
			MergeRepair: percent(o.MergeRepair, 1),
		}
		if o.Repair != nil {
			v := a(*o.Repair)
			r.Offers.Repair = &v
		}
	}
	return r
}

func (s *Server) contextItems(w http.ResponseWriter, r *http.Request) {
	items, err := s.contexts.Workshop.Items(r.Context(), userFrom(r.Context()).ID)
	if err != nil {
		contextError(w, err)
		return
	}
	result := []contextItemDTO{}
	for _, i := range items {
		result = append(result, s.contextItem(i.Item, i.Offers))
	}
	writeJSON(w, 200, map[string]any{"items": result})
}

func (s *Server) contextMergeItems(w http.ResponseWriter, r *http.Request) {
	key, ok := requestKey(w, r)
	if !ok {
		return
	}
	a, b, ok := pairBody(w, r)
	if !ok {
		return
	}
	item, err := s.contexts.Collection.MergeItems(
		r.Context(),
		iv1.PairRequest{Owner: userFrom(r.Context()).ID, RequestID: key, A: a, B: b},
	)
	if err != nil {
		contextError(w, err)
		return
	}
	writeJSON(w, 200, s.contextItem(item, nil))
}

func (s *Server) contextWork(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key, ok := requestKey(w, r)
		if !ok {
			return
		}
		o, err := s.contexts.Workshop.Start(
			r.Context(),
			userFrom(r.Context()).ID,
			key,
			r.PathValue("itemID"),
			action,
		)
		if err != nil {
			contextError(w, err)
			return
		}
		w.Header().Set("Location", "/api/v1/inventory/operations/"+o.ID)
		writeJSON(w, http.StatusAccepted, o)
	}
}

func (s *Server) contextOperation(w http.ResponseWriter, r *http.Request) {
	o, err := s.contexts.Workshop.Status(
		r.Context(),
		userFrom(r.Context()).ID,
		r.PathValue("operationID"),
	)
	if err != nil {
		contextError(w, err)
		return
	}
	writeJSON(w, 200, o)
}

func (s *Server) contextCancel(w http.ResponseWriter, r *http.Request) {
	o, err := s.contexts.Workshop.Cancel(
		r.Context(),
		userFrom(r.Context()).ID,
		r.PathValue("operationID"),
	)
	if err != nil {
		contextError(w, err)
		return
	}
	writeJSON(w, 202, o)
}

func (s *Server) contextWallet(w http.ResponseWriter, r *http.Request) {
	b, err := s.contexts.Wallet.Balances(r.Context(), userFrom(r.Context()).ID)
	if err != nil {
		contextError(w, err)
		return
	}
	id := userFrom(r.Context()).ID
	descriptor, err := s.contexts.Currency.List(r.Context(), id)
	if err != nil {
		contextError(w, err)
		return
	}
	type currency struct {
		Asset      string `json:"asset"`
		Name       string `json:"name"`
		Code       string `json:"code"`
		Precision  uint8  `json:"precision"`
		CanOperate bool   `json:"canOperate"`
	}
	metadata := []currency{}
	balances := []wv1.AssetBalance{}
	for _, d := range descriptor {
		access, e := s.contexts.Currency.Decide(r.Context(), id, d.ID)
		if e != nil {
			contextError(w, e)
			return
		}
		var balance *wv1.AssetBalance
		for i := range b {
			if b[i].Asset == d.ID {
				balance = &b[i]
				break
			}
		}
		if balance == nil {
			writeError(w, 503, "currency balance unavailable")
			return
		}
		visible := access.CanRead || balance.Posted != "0" || balance.Held != "0"
		if !visible {
			h, e := s.contexts.Wallet.History(r.Context(), id, d.ID, "", 1)
			if e != nil {
				contextError(w, e)
				return
			}
			visible = len(h.Entries) > 0
		}
		if !visible {
			continue
		}
		metadata = append(metadata, currency{d.ID, d.Name, d.Code, d.Precision, access.CanOperate})
		balances = append(balances, *balance)
	}
	writeJSON(w, 200, map[string]any{"balances": balances, "currencies": metadata})
}

func (s *Server) contextHistory(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	asset := q.Get("asset")
	if asset == "" {
		asset = "currency"
	}
	limit := 25
	if q.Get("limit") != "" {
		n, err := strconv.Atoi(q.Get("limit"))
		if err != nil || n < 1 || n > 100 {
			writeError(w, 400, "invalid limit")
			return
		}
		limit = n
	}
	h, err := s.contexts.Wallet.History(
		r.Context(),
		userFrom(r.Context()).ID,
		asset,
		q.Get("cursor"),
		limit,
	)
	if err != nil {
		contextError(w, err)
		return
	}
	if _, err := s.contexts.Currency.Describe(r.Context(), asset); err != nil {
		contextError(w, err)
		return
	}
	writeJSON(w, 200, h)
}

func (s *Server) contextGrant(w http.ResponseWriter, r *http.Request) {
	key, ok := requestKey(w, r)
	if !ok {
		return
	}
	var body struct {
		CaseID string `json:"caseId"`
		Count  int    `json:"count"`
	}
	if !decode(w, r, &body) {
		writeError(w, 400, "invalid grant")
		return
	}
	owner := r.PathValue("userID")
	exists, err := s.contexts.Subjects.Exists(r.Context(), owner)
	if err != nil {
		writeError(w, 503, "account unavailable")
		return
	}
	if !exists {
		writeError(w, 404, "user not found")
		return
	}
	_, err = s.contexts.Collection.Issue(
		r.Context(),
		iv1.IssueRequest{
			Owner:     owner,
			RequestID: key,
			Type:      body.CaseID,
			Source:    "admin",
			Count:     body.Count,
		},
	)
	if err != nil {
		contextError(w, err)
		return
	}
	writeJSON(w, 201, map[string]any{"userId": owner, "caseId": body.CaseID, "issued": body.Count})
}
