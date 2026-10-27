package contract

import (
	"github.com/voxel-vault/api/internal/ledger/application"
	v1 "github.com/voxel-vault/api/internal/ledger/contracts/v1"
	"strconv"
)

func Receipt(r application.Receipt) v1.Receipt {
	result := v1.Receipt{IntentID: r.Intent.ID, State: string(r.Intent.State), Version: r.Intent.Version, JournalID: r.JournalID, Reason: r.Intent.Reason}
	result.Kind = string(r.Intent.Kind)
	if t := r.Intent.Terms; t != nil {
		result.Terms = &v1.Terms{Subject: t.Subject, Asset: t.Asset, Units: strconv.FormatInt(t.Units, 10), Purpose: string(t.Purpose), Evidence: t.Evidence, Treasury: t.Treasury}
	}
	return result
}
