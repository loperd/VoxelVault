package migrations

import (
	"context"
	"database/sql"
	"fmt"
)

func oldTable(ctx context.Context, tx *sql.Tx, name string) (bool, error) {
	var exists bool
	err := tx.QueryRowContext(ctx, `SELECT to_regclass($1) IS NOT NULL`, "public."+name).Scan(&exists)
	return exists, err
}

// Import immutable identifiers before adding local session foreign keys. This is
// offline schema evolution; no runtime read or dual-write path survives it.
func importAccounts(ctx context.Context, tx *sql.Tx) error {
	exists, err := oldTable(ctx, tx, "users")
	if err != nil || !exists {
		return err
	}
	_, err = tx.ExecContext(ctx, `LOCK TABLE public.users IN EXCLUSIVE MODE;
 INSERT INTO identity.accounts(id,handle,display_name,created_at,updated_at) SELECT id,handle,display_name,created_at,updated_at FROM public.users ON CONFLICT(id) DO NOTHING;
 INSERT INTO identity.registrations(id,subject,created_at,completed_at,receipt,state,next_attempt_at)
 SELECT 'migration:'||id,id,now(),now(),jsonb_build_object('CommandID','migration:'||id,'Subject',id,'Role','imported','PolicyVersion','identity-retirement-v1'),'completed',now() FROM public.users ON CONFLICT(subject) DO NOTHING;
 INSERT INTO identity.events(subject,kind,provider,external_id,actor,policy_version,at,detail)
 SELECT id,'created','','','identity-retirement','identity-retirement-v1',now(),'{"source":"public.users"}'::jsonb FROM public.users u WHERE NOT EXISTS(SELECT 1 FROM identity.events e WHERE e.subject=u.id AND e.actor='identity-retirement');`)
	return err
}
func retire(ctx context.Context, tx *sql.Tx) error {
	if err := importAccounts(ctx, tx); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `CREATE TABLE identity.passkeys(credential_id text PRIMARY KEY,account_id text NOT NULL REFERENCES identity.accounts(id),data jsonb NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
 CREATE TABLE identity.retirement(id text PRIMARY KEY,at timestamptz NOT NULL,details jsonb NOT NULL);
 `)
	if err != nil {
		return err
	}
	exists, err := oldTable(ctx, tx, "users")
	if err != nil {
		return err
	}
	if exists {
		_, err = tx.ExecContext(ctx, `LOCK TABLE public.users IN EXCLUSIVE MODE;
 CREATE TABLE IF NOT EXISTS public.economy_owners(id text PRIMARY KEY,starter_granted_at timestamptz);
   INSERT INTO public.economy_owners(id,starter_granted_at) SELECT id,starter_granted_at FROM public.users ON CONFLICT(id) DO UPDATE SET starter_granted_at=excluded.starter_granted_at;`)
		if err != nil {
			return err
		}
		var lost int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM public.users u LEFT JOIN identity.accounts a ON a.id=u.id WHERE a.id IS NULL OR (a.handle,a.display_name) IS DISTINCT FROM (u.handle,u.display_name)`).Scan(&lost); err != nil {
			return err
		}
		if lost != 0 {
			return fmt.Errorf("Identity retirement would lose account data")
		}
	}
	if exists, err = oldTable(ctx, tx, "identities"); err != nil {
		return err
	} else if exists {
		_, err = tx.ExecContext(ctx, `LOCK TABLE public.identities IN EXCLUSIVE MODE; INSERT INTO identity.provider_links(account_id,provider,external_id,created_at) SELECT user_id,provider,subject,created_at FROM public.identities;`)
		if err != nil {
			return err
		}
	}
	if exists, err = oldTable(ctx, tx, "credentials"); err != nil {
		return err
	} else if exists {
		_, err = tx.ExecContext(ctx, `LOCK TABLE public.credentials IN EXCLUSIVE MODE; INSERT INTO identity.passkeys(credential_id,account_id,data,created_at,updated_at) SELECT credential_id,user_id,data,created_at,updated_at FROM public.credentials;`)
		if err != nil {
			return err
		}
	}
	// Security must have imported the existing assignments before retiring its old
	// storage. Unknown roles are retained and denied by the new versioned policy.
	if exists, err = oldTable(ctx, tx, "casbin_rule"); err != nil {
		return err
	} else if exists {
		var securityReady bool
		if err = tx.QueryRowContext(ctx, `SELECT to_regclass('security.role_bindings') IS NOT NULL`).Scan(&securityReady); err != nil {
			return err
		}
		if !securityReady {
			return fmt.Errorf("run Security migrations in the source database before Identity retirement")
		}
		var missing int
		if exists, err = oldTable(ctx, tx, "users"); err != nil {
			return err
		} else if exists {
			if _, err = tx.ExecContext(ctx, `LOCK TABLE public.casbin_rule IN EXCLUSIVE MODE`); err != nil {
				return err
			}
			err = tx.QueryRowContext(ctx, `SELECT count(*) FROM public.casbin_rule c JOIN public.users u ON u.id=c.v0 WHERE c.ptype='g' AND NOT EXISTS(SELECT 1 FROM security.role_bindings b WHERE b.subject=c.v0 AND b.role=c.v1)`).Scan(&missing)
			if err != nil {
				return err
			}
			if missing != 0 {
				return fmt.Errorf("Security assignments were not fully migrated")
			}
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO identity.retirement(id,at,details) VALUES('public-identity-v1',now(),jsonb_build_object('accounts',(SELECT count(*) FROM identity.accounts),'links',(SELECT count(*) FROM identity.provider_links),'passkeys',(SELECT count(*) FROM identity.passkeys),'sessions','old browser sessions invalidated; reauthentication required'));
 DROP TABLE IF EXISTS public.credentials,public.identities,public.ceremonies,public.o_auth_flows,public.sessions;
 DROP TABLE IF EXISTS public.users;
 DROP TABLE IF EXISTS public.casbin_rule;`)
	return err
}
