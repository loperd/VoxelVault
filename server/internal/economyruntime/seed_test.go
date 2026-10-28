package economyruntime

import (
	"sort"
	"testing"
)

func TestTransferConfigNamesTheAccountsThatMustBeOpen(t *testing.T) {
	spec, err := ParseTransferConfig([]byte(`{"Version":"v","Currency":[{"ID":"currency"}],"Account":["treasury","platform-tax"],
 "Rule":[{"ID":"r","Currency":"currency","Destination":[{"Subject":"platform-tax","Weight":1},{"Subject":"fees","Weight":1},{"Burn":true,"Weight":1}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	var subjects []string
	for _, a := range spec.RequiredAccounts() {
		subjects = append(subjects, a.Subject)
	}
	sort.Strings(subjects)
	if len(subjects) != 3 || subjects[0] != "fees" || subjects[1] != "platform-tax" || subjects[2] != "treasury" {
		t.Fatalf("required accounts: %v", subjects)
	}
	if _, err = ParseTransferConfig([]byte(`{"Version":"v","Typo":1}`)); err == nil {
		t.Fatal("unknown fields must be rejected")
	}
}
