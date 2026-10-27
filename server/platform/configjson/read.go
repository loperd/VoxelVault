// Package configjson reads bounded, strict JSON configuration independently of
// any domain, transport or deployment environment.
package configjson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
)

func Read(path string, maximum int64, target any) error {
	if maximum < 1 || maximum == math.MaxInt64 {
		return fmt.Errorf("invalid configuration size limit")
	}
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("read configuration: %w", err)
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maximum+1))
	if err != nil {
		return fmt.Errorf("read configuration: %w", err)
	}
	if int64(len(raw)) > maximum {
		return fmt.Errorf("configuration exceeds size limit")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err = d.Decode(target); err != nil {
		return fmt.Errorf("decode configuration: %w", err)
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("configuration contains trailing data")
	}
	return nil
}
