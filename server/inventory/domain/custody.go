package domain

type Custody struct {
	Location    string `json:"location"`
	Custodian   string `json:"custodian,omitempty"`
	Operation   string `json:"operation,omitempty"`
	Session     string `json:"session,omitempty"`
	Disposition string `json:"disposition,omitempty"`
}

func ItemCustody(item Item, op *Operation) Custody {
	switch item.Status {
	case Available:
		return Custody{Location: "player", Custodian: item.Owner}
	case Retired:
		return Custody{Location: "archive", Disposition: "merged"}
	case Consumed:
		if op != nil && op.Stage == Completed && op.WalletOutcome == AwardRecorded && op.ItemID == item.ID && op.Owner == item.Owner {
			if op.Action == Sell {
				return Custody{Location: "stock", Custodian: "system/main", Operation: op.ID}
			}
			if op.Action == Salvage {
				return Custody{Location: "archive", Disposition: "burned", Operation: op.ID}
			}
		}
	}
	return Custody{Location: "escrow", Custodian: item.Owner, Operation: item.OperationID}
}

func CheckCustodyTransition(before, after Custody, changed bool) error {
	if before.Disposition == "burned" && (changed || before != after) {
		return ErrConflict
	}
	if before.Disposition == "destroyed" && before != after {
		return ErrConflict
	}
	return nil
}
