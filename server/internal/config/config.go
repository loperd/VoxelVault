package config

import (
	"os"
	"strings"
)

type Config struct {
	Address        string
	FrontendURL    string
	AllowedOrigins []string
	DefaultRole    string
	// Chests every new player gets once, as "case:count,case:count".
	StarterChests        string
	InventoryDatabaseURL string
	WalletDatabaseURL    string
	WalletAssets         []string
	IdentityDatabaseURL  string
	GatewayInternalToken string
	IdentityGatewayID    string
	SecurityDatabaseURL  string
	IdentityProviders    []string
}

func Load() Config {
	return Config{
		Address:              env("HTTP_ADDRESS", ":8080"),
		FrontendURL:          env("FRONTEND_URL", "http://localhost:5173/"),
		AllowedOrigins:       split(env("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:4173")),
		DefaultRole:          env("DEFAULT_ROLE", "player"),
		StarterChests:        env("STARTER_CHESTS", "traveler:10,deep-mine:5,ender:5,dragon:3"),
		InventoryDatabaseURL: os.Getenv("INVENTORY_DATABASE_URL"),
		WalletDatabaseURL:    os.Getenv("WALLET_DATABASE_URL"),
		WalletAssets:         split(os.Getenv("WALLET_ASSETS")),
		IdentityDatabaseURL:  os.Getenv("IDENTITY_DATABASE_URL"),
		GatewayInternalToken: os.Getenv("GATEWAY_INTERNAL_TOKEN"),
		IdentityGatewayID:    env("IDENTITY_GATEWAY_ID", "project-gateway"),
		SecurityDatabaseURL:  os.Getenv("SECURITY_DATABASE_URL"),
		IdentityProviders:    split(env("IDENTITY_PROVIDERS", "telegram")),
	}
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func split(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if item := strings.TrimSpace(part); item != "" {
			result = append(result, item)
		}
	}
	return result
}
