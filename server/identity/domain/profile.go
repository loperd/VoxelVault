package domain

import (
	"unicode"
	"unicode/utf8"
)

// SafeProfileText excludes controls and invisible formatting that can disguise
// the recipient on a financial confirmation. Empty provider names are allowed
// here; account creation applies its explicit default before persistence.
func SafeProfileText(value string, maxBytes int) bool {
	if !utf8.ValidString(value) || len(value) > maxBytes {
		return false
	}
	for _, r := range value {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) {
			return false
		}
	}
	return true
}

// LegacyTelegramHandle identifies the old provider-derived handle namespace.
func LegacyTelegramHandle(value string) bool {
	if len(value) <= 3 || value[:3] != "tg_" {
		return false
	}
	for _, r := range value[3:] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
