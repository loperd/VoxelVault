package postgres

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/voxel-vault/api/ledger/application"
	"github.com/voxel-vault/api/ledger/domain"
)

// AdminParties is how many distinct parties must sign before a request runs. It is a code
// constant on purpose: lowering it needs a release, not a database write.
const AdminParties = 3

const allocationProducer = "admin-allocation"

// Allocation is the payload of the "allocate" action: move Units of Asset between two open
// treasury accounts. Nonce makes two identical allocations distinct requests.
type Allocation struct {
	From, To, Asset, Nonce string
	Units                  int64
}

// AdminRequestID is the request identity: the same action and payload is the same request.
func AdminRequestID(action, payload string) string { return domain.Identity(action, payload) }

// AdminMessage is what every party signs: the request id, action and payload digest.
func AdminMessage(action, payload string) []byte {
	sum := sha256.Sum256([]byte(payload))
	return []byte("ledger-admin-v1\n" + AdminRequestID(action, payload) + "\n" + action + "\n" + hex.EncodeToString(sum[:]))
}

func parseAllocation(payload string) (a Allocation, err error) {
	dec := json.NewDecoder(bytes.NewReader([]byte(payload)))
	dec.DisallowUnknownFields()
	if err = dec.Decode(&a); err != nil || dec.More() {
		return a, domain.ErrInvalid
	}
	if a.From == a.To || a.Units <= 0 || !domain.ValidID(a.From) || !domain.ValidID(a.To) || !domain.ValidID(a.Asset) || !domain.ValidID(a.Nonce) {
		return a, domain.ErrInvalid
	}
	return a, nil
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func adminKey(ctx context.Context, q queryer, keyID string) (party string, pub ed25519.PublicKey, err error) {
	err = q.QueryRowContext(ctx, `SELECT party,public_key FROM ledger.admin_keys WHERE key_id=$1`, keyID).Scan(&party, &pub)
	if errors.Is(err, sql.ErrNoRows) {
		err = application.ErrForbidden
	}
	return
}

func verifyAdmin(ctx context.Context, q queryer, keyID, action, payload string, sig []byte) (string, error) {
	party, pub, err := adminKey(ctx, q, keyID)
	if err != nil {
		return "", err
	}
	if len(sig) != ed25519.SignatureSize || !ed25519.Verify(pub, AdminMessage(action, payload), sig) {
		return "", application.ErrForbidden
	}
	return party, nil
}

// adminAudit appends to the hash chain: hash = sha256(prev || event || request || key).
func adminAudit(ctx context.Context, tx *sql.Tx, event, requestID, keyID string) error {
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('ledger.admin_audit'))`); err != nil {
		return err
	}
	prev := make([]byte, sha256.Size)
	if err := tx.QueryRowContext(ctx, `SELECT hash FROM ledger.admin_audit ORDER BY seq DESC LIMIT 1`).Scan(&prev); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO ledger.admin_audit(event,request_id,key_id,prev_hash,hash) VALUES($1,$2,$3,$4,$5)`,
		event, requestID, keyID, prev, auditHash(prev, event, requestID, keyID))
	return err
}

func auditHash(prev []byte, event, requestID, keyID string) []byte {
	b, _ := json.Marshal([]string{hex.EncodeToString(prev), event, requestID, keyID})
	sum := sha256.Sum256(b)
	return sum[:]
}

// VerifyAdminAudit walks the audit chain and fails on the first broken link.
func (s *Store) VerifyAdminAudit(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `SELECT event,request_id,key_id,prev_hash,hash FROM ledger.admin_audit ORDER BY seq`)
	if err != nil {
		return err
	}
	defer rows.Close()
	prev := make([]byte, sha256.Size)
	for rows.Next() {
		var event, request, key string
		var p, h []byte
		if err = rows.Scan(&event, &request, &key, &p, &h); err != nil {
			return err
		}
		if !bytes.Equal(p, prev) || !bytes.Equal(h, auditHash(p, event, request, key)) {
			return domain.ErrInvariant
		}
		prev = h
	}
	return rows.Err()
}

// AdminCreate records a request. The creator's signature proves who asked; it does not count
// toward the three, who must sign explicitly. Creating the same request twice is a no-op.
func (s *Store) AdminCreate(ctx context.Context, keyID, action, payload string, sig []byte) (string, error) {
	if action != "allocate" {
		return "", domain.ErrInvalid
	}
	if _, err := parseAllocation(payload); err != nil {
		return "", err
	}
	if _, err := verifyAdmin(ctx, s.db, keyID, action, payload, sig); err != nil {
		return "", err
	}
	id := AdminRequestID(action, payload)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `INSERT INTO ledger.admin_requests(id,action,payload,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, id, action, payload, keyID)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 1 {
		if err = adminAudit(ctx, tx, "requested", id, keyID); err != nil {
			return "", err
		}
	}
	return id, tx.Commit()
}

// AdminSign adds one party's signature to an open request; a repeated key changes nothing.
func (s *Store) AdminSign(ctx context.Context, id, keyID string, sig []byte) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var action, payload string
	var done sql.NullTime
	if err = tx.QueryRowContext(ctx, `SELECT action,payload,executed_at FROM ledger.admin_requests WHERE id=$1`, id).Scan(&action, &payload, &done); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = domain.ErrInvalid
		}
		return err
	}
	if done.Valid {
		return domain.ErrConflict
	}
	if _, err = verifyAdmin(ctx, tx, keyID, action, payload, sig); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO ledger.admin_signatures(request_id,key_id,signature) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, id, keyID, sig)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 1 {
		if err = adminAudit(ctx, tx, "signed", id, keyID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AdminExecute runs a request once it carries valid signatures from AdminParties distinct
// parties. Signatures are verified again here, so a row planted in the table does not count.
func (s *Store) AdminExecute(ctx context.Context, id string, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var action, payload string
	var done sql.NullTime
	if err = tx.QueryRowContext(ctx, `SELECT action,payload,executed_at FROM ledger.admin_requests WHERE id=$1 FOR UPDATE`, id).Scan(&action, &payload, &done); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = domain.ErrInvalid
		}
		return err
	}
	if done.Valid {
		return domain.ErrConflict
	}
	rows, err := tx.QueryContext(ctx, `SELECT s.key_id,s.signature FROM ledger.admin_signatures s WHERE s.request_id=$1`, id)
	if err != nil {
		return err
	}
	type signed struct {
		key string
		sig []byte
	}
	var all []signed
	for rows.Next() {
		var x signed
		if err = rows.Scan(&x.key, &x.sig); err != nil {
			rows.Close()
			return err
		}
		all = append(all, x)
	}
	if err = rows.Close(); err != nil {
		return err
	}
	parties := map[string]bool{}
	for _, x := range all {
		if party, err := verifyAdmin(ctx, tx, x.key, action, payload, x.sig); err == nil {
			parties[party] = true
		}
	}
	if len(parties) < AdminParties {
		return application.ErrForbidden
	}
	a, err := parseAllocation(payload)
	if err != nil {
		return err
	}
	u := unit{ctx: ctx, tx: tx}
	moved, err := moveFunds(&u, allocationProducer, id, domain.Allocation, a.From, a.To, a.Asset, a.Units, at)
	if err != nil {
		return err
	}
	if moved != a.Units {
		return domain.ErrConflict
	}
	if _, err = tx.ExecContext(ctx, `UPDATE ledger.admin_requests SET executed_at=$2 WHERE id=$1`, id, at); err != nil {
		return err
	}
	if err = adminAudit(ctx, tx, "executed", id, ""); err != nil {
		return err
	}
	return tx.Commit()
}

// RegisterAdminKey adds a public key for a party. It never replaces: a different key under an
// existing id is ErrConflict. Run it with operator credentials (economy-seed), not as the runtime.
func (s *Store) RegisterAdminKey(ctx context.Context, keyID, party string, pub ed25519.PublicKey) error {
	if !domain.ValidID(keyID) || !domain.ValidID(party) || len(pub) != ed25519.PublicKeySize {
		return domain.ErrInvalid
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO ledger.admin_keys(key_id,party,public_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, keyID, party, []byte(pub)); err != nil {
		return err
	}
	var same bool
	if err := s.db.QueryRowContext(ctx, `SELECT party=$2 AND public_key=$3 FROM ledger.admin_keys WHERE key_id=$1`, keyID, party, []byte(pub)).Scan(&same); err != nil || !same {
		if err == nil {
			err = domain.ErrConflict
		}
		return err
	}
	return nil
}

// AdminRequest is what a party reads before signing: the action, the exact payload, the keys
// that already signed and whether it ran.
func (s *Store) AdminRequest(ctx context.Context, id string) (action, payload string, signers []string, executed bool, err error) {
	var done sql.NullTime
	if err = s.db.QueryRowContext(ctx, `SELECT action,payload,executed_at FROM ledger.admin_requests WHERE id=$1`, id).Scan(&action, &payload, &done); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = domain.ErrInvalid
		}
		return
	}
	rows, err := s.db.QueryContext(ctx, `SELECT key_id FROM ledger.admin_signatures WHERE request_id=$1 ORDER BY key_id`, id)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		if err = rows.Scan(&k); err != nil {
			return
		}
		signers = append(signers, k)
	}
	return action, payload, signers, done.Valid, rows.Err()
}
