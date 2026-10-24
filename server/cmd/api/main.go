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

	"github.com/voxel-vault/api/internal/config"
	"github.com/voxel-vault/api/internal/economyruntime"
	"github.com/voxel-vault/api/internal/httpapi"
	identityhttp "github.com/voxel-vault/api/internal/identity/adapters/inbound/gatewayhttp"
	"github.com/voxel-vault/api/internal/identityruntime"
	"github.com/voxel-vault/api/internal/platform/gatewayhttp"
	"github.com/voxel-vault/api/internal/rulebookjson"
	"github.com/voxel-vault/api/internal/store"
)

func run() error {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := store.OpenRuntime(cfg.DatabaseURL)
	if err != nil {
		return err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	rb, err := rulebookjson.Load(cfg.EconomyPath)
	if err != nil {
		return err
	}
	log.Printf("Economy rulebook %s loaded", rb.Revision())
	if cfg.IdentityDatabaseURL == "" || cfg.SecurityDatabaseURL == "" || cfg.GatewayInternalToken == "" {
		return fmt.Errorf("Identity, Security and the gateway peer credential are required")
	}
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	identity, err := identityruntime.Open(startup, cfg.IdentityDatabaseURL, cfg.IdentityGatewayID)
	cancel()
	if err != nil {
		return err
	}
	defer identity.Close()
	startup, cancel = context.WithTimeout(ctx, 10*time.Second)
	err = identity.EnableAccounts(startup, cfg.SecurityDatabaseURL, cfg.DefaultRole, cfg.IdentityProviders, cfg.SecurityPolicyPath)
	cancel()
	if err != nil {
		return err
	}
	peer, err := gatewayhttp.New(cfg.GatewayInternalToken)
	if err != nil {
		return err
	}
	identityPorts := &httpapi.IdentityPorts{Peer: peer, Profiles: identity.Profiles, Sessions: identity.Sessions, Security: identity.Security}
	startup, cancel = context.WithTimeout(ctx, 15*time.Second)
	runtime, err := economyruntime.New(startup, sqlDB, cfg.InventoryDatabaseURL, cfg.WalletDatabaseURL, cfg.WalletAssets, rb, economyruntime.Options{StarterChests: cfg.StarterChests, SecurityDB: identity.SecurityDB})
	cancel()
	if err != nil {
		return err
	}
	defer runtime.Close()
	ports := &httpapi.ContextPorts{Collection: runtime.Collection, Workshop: runtime.Workshop, Wallet: runtime.Wallet, Subjects: identity.Profiles, UserContext: runtime.UserContext}
	economyDone := make(chan struct{})
	go func() { defer close(economyDone); runtime.Run(ctx) }()
	defer func() { stop(); <-economyDone }()
	api, err := httpapi.New(db, cfg, identityPorts, rb, ports, runtime.Guard.Check)
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
	server := &http.Server{Addr: cfg.Address, Handler: handler, ReadHeaderTimeout: 5 * time.Second}
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
