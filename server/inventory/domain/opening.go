package domain

func ValidateItem(item Item) error {
	if !ValidID(item.ID) || !ValidID(item.Owner) || !ValidID(item.Definition) || rank(item.Condition) < 0 || (item.Origin != "" && !ValidID(item.Origin)) {
		return ErrInvalid
	}
	switch item.Status {
	case Available, Retired:
		if item.OperationID != "" {
			return ErrInvalid
		}
	case Locked, Consumed:
		if !ValidID(item.OperationID) {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	return nil
}

func ValidateOpeningItem(item Item) error {
	if err := ValidateItem(item); err != nil {
		return err
	}
	if item.Status != Available {
		return ErrInvalid
	}
	return nil
}
