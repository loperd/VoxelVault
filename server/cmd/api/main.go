package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	identityhttp "github.com/voxel-vault/api/identity/adapters/inbound/gatewayhttp"
	"github.com/voxel-vault/api/internal/config"
	"github.com/voxel-vault/api/internal/economyruntime"
	"github.com/voxel-vault/api/internal/httpapi"
	"github.com/voxel-vault/api/internal/identityruntime"
	"github.com/voxel-vault/api/platform/gatewayhttp"
)

func run() error {
	cfg := config.Load()
	if cfg.IdentityDatabaseURL == "" || cfg.SecurityDatabaseURL == "" || cfg.GatewayInternalToken == "" {
		return fmt.Errorf("Identity, Security and gateway peer credentials are required")
	}
	peer, err := gatewayhttp.New(cfg.GatewayInternalToken)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	rb, err := economyruntime.LoadRulebook(startup, cfg.InventoryDatabaseURL)
	cancel()
	if err != nil {
		return err
	}
	log.Printf("Economy rulebook %s loaded", rb.Revision())
	startup, cancel = context.WithTimeout(ctx, 10*time.Second)
	identity, err := identityruntime.Open(startup, cfg.IdentityDatabaseURL, cfg.IdentityGatewayID)
	cancel()
	if err != nil {
		return err
	}
	defer identity.Close()
	startup, cancel = context.WithTimeout(ctx, 10*time.Second)
	err = identity.EnableAccounts(startup, cfg.SecurityDatabaseURL, cfg.DefaultRole, cfg.IdentityProviders)
	cancel()
	if err != nil {
		return err
	}
	identityPorts := &httpapi.IdentityPorts{Peer: peer, Profiles: identity.Profiles, Sessions: identity.Sessions, Security: identity.Security}
	startup, cancel = context.WithTimeout(ctx, 15*time.Second)
	runtime, err := economyruntime.New(startup, cfg.InventoryDatabaseURL, cfg.WalletDatabaseURL, cfg.WalletAssets, rb, economyruntime.Options{StarterChests: cfg.StarterChests, SecurityDB: identity.SecurityDB})
	cancel()
	if err != nil {
		return err
	}
	defer runtime.Close()
	startup, cancel = context.WithTimeout(ctx, 10*time.Second)
	err = runtime.EnableTransfer(startup, identity.Recipient)
	cancel()
	if err != nil {
		return fmt.Errorf("transfer configuration: %w", err)
	}
	ports := &httpapi.ContextPorts{Collection: runtime.Collection, Workshop: runtime.Workshop, Wallet: runtime.Wallet, Transfer: runtime.Transfer, Currency: runtime.Currency, Subjects: identity.Profiles, UserContext: runtime.UserContext,
		RecipientPerMinute: runtime.Limits.RecipientRequestsPerMinute, QuotePerMinute: runtime.Limits.QuoteRequestsPerMinute, TransferPerMinute: runtime.Limits.TransferRequestsPerMinute}
	economyDone := make(chan struct{})
	go func() { defer close(economyDone); runtime.Run(ctx) }()
	defer func() { stop(); <-economyDone }()
	api, err := httpapi.New(cfg, identityPorts, rb, ports, runtime.Guard.Check)
	if err != nil {
		return err
	}
	handler := api.Handler()
	internal, err := identityhttp.New(identity.Sessions, cfg.GatewayInternalToken, identity.Accounts)
	if err != nil {
		return err
	}
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); identity.Run(ctx) }()
	defer func() { stop(); <-workerDone }()
	mux := http.NewServeMux()
	downstream := handler
	mux.Handle("/internal/sessions/", internal)
	mux.Handle("/internal/auth/", internal)
	mux.Handle("/", downstream)
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := identity.Ready(r.Context()); err != nil {
			http.Error(w, "Identity unavailable", 503)
			return
		}
		downstream.ServeHTTP(w, r)
	})
	handler = mux
	// https://pkg.go.dev/net/http@go1.26.0#Server
	server := &http.Server{
		Addr: cfg.Address, Handler: handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	log.Printf("Voxel Vault API listening on %s", cfg.Address)
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
