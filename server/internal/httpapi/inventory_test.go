package httpapi

import (
	"net/http"
	"reflect"
	"testing"

	iv1 "github.com/voxel-vault/api/internal/inventory/contracts/v1"
	"github.com/voxel-vault/api/internal/rulebookjson"
)

func TestParseGrantsReadsTheStarterChests(t *testing.T) {
	rb, err := rulebookjson.Load("../../config/economy.json")
	if err != nil {
		t.Fatal(err)
	}
	grants, err := parseGrants(rb, " traveler:10, deep-mine:5 ,ender:5,dragon:3,")
	if err != nil {
		t.Fatal(err)
	}
	want := []iv1.Grant{{Type: "traveler", Count: 10}, {Type: "deep-mine", Count: 5}, {Type: "ender", Count: 5}, {Type: "dragon", Count: 3}}
	if !reflect.DeepEqual(grants, want) {
		t.Fatalf("got %v, want %v", grants, want)
	}
	for _, value := range []string{"nether:3", "traveler", "traveler:0", "traveler:-1", "traveler:x"} {
		if _, err := parseGrants(rb, value); err == nil {
			t.Errorf("%q: expected an error", value)
		}
	}
	if grants, err := parseGrants(rb, ""); err != nil || len(grants) != 0 {
		t.Errorf("empty: got %v, %v", grants, err)
	}
}

func TestRoutesDoNotConflict(t *testing.T) {
	(&Server{mux: http.NewServeMux()}).routes()
}
