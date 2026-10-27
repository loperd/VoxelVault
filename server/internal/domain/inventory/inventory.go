// Package inventory is the items a player owns and the state each is in. A dropped item lands
// here intact or damaged; a damaged one cannot be used, but can be repaired, merged with its
// twin, salvaged for its collection's material or sold for currency.
package inventory

import (
	"errors"
	"fmt"
	"math"
	"slices"

	"github.com/voxel-vault/api/internal/domain/wallet"
	"github.com/voxel-vault/api/inventory/domain/dice"
	"github.com/voxel-vault/api/inventory/domain/rulebook"
)

var (
	ErrUnknownItem = errors.New("no such item in the inventory")
	ErrDuplicate   = errors.New("item is already in the inventory")
	ErrIntact      = errors.New("item is not damaged")
	ErrNotTwins    = errors.New("only two different damaged items of one kind merge")
)

// Item is one item a player owns. Origin is the chest it dropped from.
type Item struct {
	ID, Item, State, Origin string
}

type Inventory struct {
	owner string
	items []Item
}

func New(owner string) *Inventory { return &Inventory{owner: owner} }

// Restore brings back a stored inventory.
func Restore(owner string, items []Item) *Inventory {
	return &Inventory{owner: owner, items: slices.Clone(items)}
}

func (inv *Inventory) Owner() string { return inv.owner }
func (inv *Inventory) Items() []Item { return slices.Clone(inv.items) }

// Receive puts a drop into the inventory.
func (inv *Inventory) Receive(rb *rulebook.Rulebook, item Item) error {
	if _, _, ok := rb.Item(item.Item); !ok {
		return fmt.Errorf("%w: %q", ErrUnknownItem, item.Item)
	}
	if rb.StateRank(item.State) < 0 {
		return fmt.Errorf("unknown item state %q", item.State)
	}
	if inv.find(item.ID) >= 0 {
		return ErrDuplicate
	}
	inv.items = append(inv.items, item)
	return nil
}

func (inv *Inventory) find(id string) int {
	return slices.IndexFunc(inv.items, func(item Item) bool { return item.ID == id })
}

// get finds an item the rulebook still knows; one dropped from the rulebook cannot be valued.
func (inv *Inventory) get(rb *rulebook.Rulebook, id string) (int, error) {
	i := inv.find(id)
	if i < 0 {
		return -1, ErrUnknownItem
	}
	if _, _, ok := rb.Item(inv.items[i].Item); !ok || rb.StateRank(inv.items[i].State) < 0 {
		return -1, fmt.Errorf("%w in rulebook %s: %q", ErrUnknownItem, rb.Revision(), inv.items[i].Item)
	}
	return i, nil
}

func (inv *Inventory) remove(i int) { inv.items = slices.Delete(inv.items, i, i+1) }

// value is the worth of an item in its state: item.value.<rarity> × item.state.<state>.value.
func value(rb *rulebook.Rulebook, item Item, s rulebook.Situation) (float64, string, rulebook.Situation) {
	def, chestType, _ := rb.Item(item.Item)
	s = s.With(rulebook.Situation{
		"type": chestType.ID, "collection": chestType.Collection,
		"item.rarity": def.Rarity, "item.state": item.State,
	})
	return rb.Value("item.value."+def.Rarity, s) * rb.Value("item.state."+item.State+".value", s), rb.Material(chestType), s
}

// Offers is what each workshop action would cost or bring for an item now. Repair is absent for
// an intact item; MergeWith is the twin to merge it with (none: nothing to merge) and MergeRepair
// the chance that merge mends the item that stays.
type Offers struct {
	Repair        *wallet.Amount
	Salvage, Sell wallet.Amount
	MergeWith     string
	MergeRepair   float64
}

// Quote prices an item for every workshop action without changing anything.
func (inv *Inventory) Quote(rb *rulebook.Rulebook, id string, s rulebook.Situation) (Offers, error) {
	i, err := inv.get(rb, id)
	if err != nil {
		return Offers{}, err
	}
	item := inv.items[i]
	o := Offers{Salvage: salvageGain(rb, item, s), Sell: sellGain(rb, item, s)}
	if twin := inv.worstTwin(rb, i); twin >= 0 {
		_, _, o.MergeRepair = inv.planMerge(rb, i, twin, s)
		o.MergeWith = inv.items[twin].ID
	}
	if rb.StateRank(item.State) > 0 {
		cost := repairCost(rb, item, s)
		o.Repair = &cost
	}
	return o, nil
}

// repairCost is the item's base value in the material of its collection.
func repairCost(rb *rulebook.Rulebook, item Item, s rulebook.Situation) wallet.Amount {
	def, _, _ := rb.Item(item.Item)
	_, material, s := value(rb, item, s)
	return wallet.Amount{Resource: material, Value: whole(rb.Value("item.value."+def.Rarity, s))}
}

// salvageGain is the item's value in its state, in its collection's material.
func salvageGain(rb *rulebook.Rulebook, item Item, s rulebook.Situation) wallet.Amount {
	worth, material, _ := value(rb, item, s)
	return wallet.Amount{Resource: material, Value: whole(worth)}
}

// sellGain is the item's value in its state × item.sellRate, in currency.
func sellGain(rb *rulebook.Rulebook, item Item, s rulebook.Situation) wallet.Amount {
	worth, _, s := value(rb, item, s)
	return wallet.Amount{Resource: wallet.Currency, Value: whole(worth * rb.Value("item.sellRate", s))}
}

// Repair mends a damaged item by one step and charges its base value in the material of its
// collection.
func (inv *Inventory) Repair(rb *rulebook.Rulebook, w *wallet.Wallet, id string, s rulebook.Situation) (wallet.Amount, error) {
	i, err := inv.get(rb, id)
	if err != nil {
		return wallet.Amount{}, err
	}
	rank := rb.StateRank(inv.items[i].State)
	if rank <= 0 {
		return wallet.Amount{}, ErrIntact
	}
	cost := repairCost(rb, inv.items[i], s)
	if err := w.Debit(cost); err != nil {
		return wallet.Amount{}, err
	}
	inv.items[i].State = rb.States()[rank-1]
	return cost, nil
}

// Salvage destroys an item for its collection's material: its value in its state.
func (inv *Inventory) Salvage(rb *rulebook.Rulebook, w *wallet.Wallet, id string, s rulebook.Situation) (wallet.Amount, error) {
	i, err := inv.get(rb, id)
	if err != nil {
		return wallet.Amount{}, err
	}
	gain := salvageGain(rb, inv.items[i], s)
	if err := w.Credit(gain); err != nil {
		return wallet.Amount{}, err
	}
	inv.remove(i)
	return gain, nil
}

// Sell trades an item for currency: its value in its state × item.sellRate.
func (inv *Inventory) Sell(rb *rulebook.Rulebook, w *wallet.Wallet, id string, s rulebook.Situation) (wallet.Amount, error) {
	i, err := inv.get(rb, id)
	if err != nil {
		return wallet.Amount{}, err
	}
	gain := sellGain(rb, inv.items[i], s)
	if err := w.Credit(gain); err != nil {
		return wallet.Amount{}, err
	}
	inv.remove(i)
	return gain, nil
}

// Merge joins two damaged items of one kind by planMerge: the one that stays may be mended one
// step, the other is gone. It returns the item that stayed.
func (inv *Inventory) Merge(rb *rulebook.Rulebook, idA, idB string, seed uint64, s rulebook.Situation) (Item, error) {
	a, err := inv.get(rb, idA)
	if err != nil {
		return Item{}, err
	}
	b, err := inv.get(rb, idB)
	if err != nil {
		return Item{}, err
	}
	if err := inv.twins(rb, a, b); err != nil {
		return Item{}, err
	}
	kept, gone, repair := inv.planMerge(rb, a, b, s)
	if dice.New(seed, dice.StreamItemMerge).Chance(repair) {
		inv.items[kept].State = rb.States()[rb.StateRank(inv.items[kept].State)-1]
	}
	item := inv.items[kept]
	inv.remove(gone)
	return item, nil
}

// planMerge is all an item merge decides before the dice: the twin in the better state stays (a,
// on a tie), the other goes, and the one that stays is mended by item.merge.repair in its own
// situation.
func (inv *Inventory) planMerge(rb *rulebook.Rulebook, a, b int, s rulebook.Situation) (kept, gone int, repair float64) {
	if rb.StateRank(inv.items[b].State) < rb.StateRank(inv.items[a].State) {
		a, b = b, a
	}
	_, _, s = value(rb, inv.items[a], s)
	return a, b, rb.Value("item.merge.repair", s)
}

// twins says whether two items may merge: two damaged items of one kind.
func (inv *Inventory) twins(rb *rulebook.Rulebook, a, b int) error {
	if a == b || inv.items[a].Item != inv.items[b].Item {
		return ErrNotTwins
	}
	if rb.StateRank(inv.items[a].State) <= 0 || rb.StateRank(inv.items[b].State) <= 0 {
		return ErrIntact
	}
	return nil
}

// worstTwin is the twin of an item in the worst state, the one a merge costs least; -1 when
// there is none.
func (inv *Inventory) worstTwin(rb *rulebook.Rulebook, i int) int {
	worst := -1
	for j, other := range inv.items {
		if inv.twins(rb, i, j) == nil && (worst < 0 || rb.StateRank(other.State) > rb.StateRank(inv.items[worst].State)) {
			worst = j
		}
	}
	return worst
}

// whole rounds an amount to a whole number of units.
func whole(v float64) int64 { return int64(math.Round(v)) }
