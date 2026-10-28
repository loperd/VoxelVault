package economyruntime

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	flocal "github.com/voxel-vault/api/commissions/adapters/local"
	fapp "github.com/voxel-vault/api/commissions/application"
	fdomain "github.com/voxel-vault/api/commissions/domain"
	clocal "github.com/voxel-vault/api/currency/adapters/local"
	capp "github.com/voxel-vault/api/currency/application"
	cv1 "github.com/voxel-vault/api/currency/contracts/v1"
	iv1 "github.com/voxel-vault/api/identity/contracts/v1"
	bridge "github.com/voxel-vault/api/internal/integrations/ledgertransfer"
	llocal "github.com/voxel-vault/api/ledger/adapters/inbound/local"
	lpg "github.com/voxel-vault/api/ledger/adapters/postgres"
	lapp "github.com/voxel-vault/api/ledger/application"
	lv1 "github.com/voxel-vault/api/ledger/contracts/v1"
	ldomain "github.com/voxel-vault/api/ledger/domain"
	"github.com/voxel-vault/api/security/adapters/policyconfig"
	securitypg "github.com/voxel-vault/api/security/adapters/postgres"
	security "github.com/voxel-vault/api/security/application"
	sv1 "github.com/voxel-vault/api/security/contracts/v1"
)

type TransferCurrencyConfig struct {
	ID, Code, Name, Revision string
	Precision                uint8
	Active, Everyone         bool
	User, Group              []string
}
type TransferDestinationConfig struct {
	Subject string
	Weight  int64
	Burn    bool
}
type TransferRuleConfig struct {
	ID, Version, Currency, Imposition string
	GeneralTax                        bool
	Numerator, Denominator            int64
	Destination                       []TransferDestinationConfig
}
type TransferConfig struct {
	Version  string
	Currency []TransferCurrencyConfig
	Rule     []TransferRuleConfig
	Limits   TransferLimits
	// Account lists the treasury subjects opened for every configured currency.
	Account []string
}

// RequiredAccounts are the treasury accounts that must be open: the listed subjects for every
// currency, and every commission destination.
func (c TransferConfig) RequiredAccounts() map[string]ldomain.Account {
	account := map[string]ldomain.Account{}
	add := func(subject, currency string) {
		if ldomain.ValidID(subject) {
			a := ldomain.TreasuryAccount(subject, currency)
			account[a.ID] = a
		}
	}
	for _, cur := range c.Currency {
		for _, subject := range c.Account {
			add(subject, cur.ID)
		}
	}
	for _, r := range c.Rule {
		for _, d := range r.Destination {
			if !d.Burn {
				add(d.Subject, r.Currency)
			}
		}
	}
	return account
}

// ParseTransferConfig reads one strict transfer configuration document.
func ParseTransferConfig(doc []byte) (TransferConfig, error) {
	var spec TransferConfig
	d := json.NewDecoder(bytes.NewReader(doc))
	d.DisallowUnknownFields()
	if err := d.Decode(&spec); err != nil || d.More() {
		return TransferConfig{}, fmt.Errorf("transfer configuration is invalid: %v", err)
	}
	return spec, nil
}

// TransferLimits has no code defaults: every field must be set in the config file.
type TransferLimits struct {
	QuotesPerSecond, QuotesPerDay, TransfersPerMinute, SuspendMinutes int
	// HTTP requests per user per minute, per route (retries and probing count too).
	RecipientRequestsPerMinute, QuoteRequestsPerMinute, TransferRequestsPerMinute int
}

func (l TransferLimits) validate() error {
	if l.QuotesPerSecond < 1 || l.QuotesPerDay < 1 || l.TransfersPerMinute < 1 || l.SuspendMinutes < 1 ||
		l.RecipientRequestsPerMinute < 1 || l.QuoteRequestsPerMinute < 1 || l.TransferRequestsPerMinute < 1 {
		return fmt.Errorf("transfer limits must all be positive")
	}
	return nil
}

type userPermission struct {
	Client              sv1.Client
	Context, Permission string
}

func (a userPermission) check(ctx context.Context, subject string) error {
	p, ok := lapp.AuthenticatedPrincipal(ctx)
	if !ok || p.ID != subject {
		return lapp.ErrForbidden
	}
	d, err := a.Client.Decide(
		ctx,
		sv1.Request{
			Context:      a.Context,
			ActorKind:    "user",
			ActorID:      p.ID,
			Permission:   a.Permission,
			ResourceKind: "owner",
			ResourceID:   subject,
			Owner:        subject,
			Source:       "player-transfer",
		},
	)
	if err != nil {
		return err
	}
	if !d.Allowed || d.PolicyVersion == "" {
		return lapp.ErrForbidden
	}
	return nil
}

func (a userPermission) AuthorizeTransfer(ctx context.Context, subject, asset string) error {
	if !ldomain.ValidID(asset) {
		return lapp.ErrForbidden
	}
	return a.check(ctx, subject)
}

type currencyPermission struct{ userPermission }

func (a currencyPermission) Authorize(ctx context.Context, producer string) error {
	p, ok := lapp.AuthenticatedPrincipal(ctx)
	if !ok || producer != "wallet-api" {
		return capp.ErrForbidden
	}
	err := a.check(ctx, p.ID)
	if errors.Is(err, lapp.ErrForbidden) {
		return capp.ErrForbidden
	}
	return err
}

type commissionPermission struct{ userPermission }

func (a commissionPermission) Authorize(
	ctx context.Context,
	producer string,
	f fapp.TransferFact,
) error {
	if producer != "ledger-transfer" {
		return fapp.ErrForbidden
	}
	err := a.check(ctx, f.SenderID)
	if errors.Is(err, lapp.ErrForbidden) {
		return fapp.ErrForbidden
	}
	return err
}

// ConfigureTransfer is startup composition, never an HTTP administration action.
// It opens no accounts: every account the configuration names must already exist.
func ConfigureTransfer(
	ctx context.Context,
	db, rolesDB *sql.DB,
	recipient iv1.RecipientResolver,
	spec TransferConfig,
	membership capp.GroupMembership,
) (lv1.TransferClient, cv1.Provider, error) {
	if db == nil || rolesDB == nil || recipient == nil || spec.Version == "" {
		return nil, nil, fmt.Errorf("complete transfer configuration is required")
	}
	var rules []security.Rule
	for _, role := range []string{"player", "admin"} {
		for _, entry := range []struct{ context, permission string }{{"ledger", "ledger.transfer"}, {"currency", "currency.read"}} {
			rules = append(
				rules,
				security.Rule{
					Context:      entry.context,
					Permission:   entry.permission,
					Role:         role,
					ActorKind:    "user",
					ResourceKind: "owner",
					Scope:        security.Self,
				},
			)
		}
	}
	account := spec.RequiredAccounts()
	feeRule := []fdomain.Rule{}
	for _, r := range spec.Rule {
		rule := fdomain.Rule{
			ID:          r.ID,
			Version:     r.Version,
			Currency:    r.Currency,
			Imposition:  r.Imposition,
			GeneralTax:  r.GeneralTax,
			Numerator:   r.Numerator,
			Denominator: r.Denominator,
		}
		for _, d := range r.Destination {
			ref := ""
			if !d.Burn {
				if !ldomain.ValidID(d.Subject) {
					return nil, nil, fmt.Errorf("invalid commission account")
				}
				a := ldomain.TreasuryAccount(d.Subject, r.Currency)
				ref = a.ID
			}
			rule.Destination = append(
				rule.Destination,
				fdomain.Destination{Account: ref, Burn: d.Burn, Weight: d.Weight},
			)
		}
		feeRule = append(feeRule, rule)
	}
	client, err := policyconfig.New(
		policyconfig.Policy{
			Version: "ledger-transfer-v1",
			Rules:   rules,
		},
		securitypg.Roles{DB: rolesDB},
	)
	if err != nil {
		return nil, nil, err
	}
	definition := []capp.Definition{}
	currencyIDs := map[string]bool{}
	for _, c := range spec.Currency {
		definition = append(
			definition,
			capp.Definition{
				Descriptor: capp.Descriptor{
					ID:        c.ID,
					Code:      c.Code,
					Name:      c.Name,
					Revision:  c.Revision,
					Precision: c.Precision,
					Active:    c.Active,
				},
				Everyone: c.Everyone,
				User:     c.User,
				Group:    c.Group,
			},
		)
		currencyIDs[c.ID] = true
	}
	for _, r := range feeRule {
		if !currencyIDs[r.Currency] {
			return nil, nil, fmt.Errorf("commission currency is not defined")
		}
	}
	catalog, err := capp.New(
		definition,
		currencyPermission{userPermission{client, "currency", "currency.read"}},
		membership,
	)
	if err != nil {
		return nil, nil, err
	}
	currency := clocal.Provider{Catalog: catalog, Producer: "wallet-api"}
	calculator, err := fapp.New(
		spec.Version,
		feeRule,
		commissionPermission{userPermission{client, "ledger", "ledger.transfer"}},
	)
	if err != nil {
		return nil, nil, err
	}
	if err = spec.Limits.validate(); err != nil {
		return nil, nil, err
	}
	store := lpg.New(db).LimitQuotes(spec.Limits.QuotesPerSecond, spec.Limits.QuotesPerDay).
		LimitTransfers(spec.Limits.TransfersPerMinute, spec.Limits.SuspendMinutes)
	for _, a := range account {
		ok, err := store.HasAccount(ctx, a)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nil, nil, fmt.Errorf("account %s is not open; run economy-seed", a.ID)
		}
	}
	transfer, err := lapp.NewTransfer(
		store,
		bridge.Currency{Client: currency},
		bridge.RecipientResolver{Client: recipient},
		bridge.Calculator{
			Client: flocal.Calculator{Service: calculator, Producer: "ledger-transfer"},
		},
		userPermission{client, "ledger", "ledger.transfer"},
		time.Now,
		func() (string, error) {
			var b [16]byte
			if _, e := rand.Read(b[:]); e != nil {
				return "", e
			}
			return hex.EncodeToString(b[:]), nil
		},
	)
	if err != nil {
		return nil, nil, err
	}
	return llocal.TransferClient{Service: transfer}, currency, nil
}

func (r *Runtime) EnableTransfer(
	ctx context.Context,
	recipient iv1.RecipientResolver,
) error {
	doc, err := lpg.New(r.ledgerDB).ActiveTransferConfig(ctx)
	if err != nil {
		return err
	}
	spec, err := ParseTransferConfig(doc)
	if err != nil {
		return err
	}
	for _, c := range spec.Currency {
		allowed := false
		for _, asset := range r.assets {
			allowed = allowed || asset == c.ID
		}
		if !allowed {
			return fmt.Errorf("currency %s must be included in ledger read assets", c.ID)
		}
	}
	transfer, currency, err := ConfigureTransfer(
		ctx,
		r.ledgerDB,
		r.securityDB,
		recipient,
		spec,
		nil,
	)
	if err != nil {
		return err
	}
	r.Transfer, r.Currency, r.Limits = transfer, currency, spec.Limits
	r.Wallet = bridge.HistoryReader{Ledger: r.Ledger, Currency: currency}
	return nil
}
