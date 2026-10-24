package httpapi

import (
	"fmt"
	"github.com/voxel-vault/api/internal/store"
	"html"
)

// Object silhouettes on transparent surfaces, shared by inventory, catalog and roulette.
var itemShapes = map[string]string{
	"compass": `<path d="M48 20h32v8h12v12h8v40h-8v12H80v8H48v-8H36V80h-8V48h8V36h12z" fill="#b98d48"/><path d="M48 36h32v8h8v32h-8v12H48V76H36V48h12z" fill="#1b3542"/><path d="m64 40 12 24-12 24-12-24z" fill="#e7e5c1"/><path d="m64 40 12 24H64z" fill="#53ded1"/>`,
	"map":     `<path d="m20 28 28 8 32-12 28 8v72l-28-8-32 12-28-8z" fill="#d9c596"/><path d="M48 36v72m32-84v72" stroke="#96815f" stroke-width="4"/><path d="m34 80 20-20 16 8 20-20" stroke="#537e65" stroke-width="7" fill="none"/><path d="m82 42 16 16m0-16L82 58" stroke="#aa5039" stroke-width="5"/>`,
	"lantern": `<path d="M52 12h24v8h8v16H72V24H56v12H44V20h8zM36 36h56v12H36zm0 64h56v12H36z" fill="#8fa7aa"/><path d="M40 48h48v52H40z" fill="#355052"/><path d="M48 52h32v40H48z" fill="#e3bc61"/><path d="M56 60h16v24H56z" fill="#fff2b3"/>`,
	"eye":     `<path d="m12 64 24-28h56l24 28-24 28H36z" fill="#8a7597"/><path d="m28 64 16-16h40l16 16-16 16H44z" fill="#ded9bd"/><path d="M52 44h24v40H52z" fill="#4eafad"/><path d="M60 48h12v32H60z" fill="#182c34"/><path d="M56 48h8v12h-8z" fill="#d1ffff"/>`,
	"sword":   `<path d="M84 12h28v28L60 92 36 68z" fill="#91d7d5"/><path d="m40 72 52-52h12L52 80z" fill="#d4ffff"/><path d="m32 60 36 36-12 12-36-36z" fill="#c3a05b"/><path d="m32 84 12 12-24 24H8v-12z" fill="#725140"/>`,
	"pickaxe": `<path d="m24 20 40-8 28 16 20 32-16 8-24-28-28 4z" fill="#8fc5d0"/><path d="m60 36 16 12-40 68H16z" fill="#9c7346"/><path d="m26 24 36-8 26 16-8 8-20-12-28 8z" fill="#d7edf0"/>`,
	"crystal": `<path d="m64 12 32 28-8 52-24 24-24-24-8-52z" fill="#4aaebc"/><path d="m64 12 4 44-28 36-8-52z" fill="#a0eee2"/><path d="m68 56 28-16-8 52-24 24z" fill="#365b95"/><path d="m64 12 32 28-28 16z" fill="#d6fff2"/>`,
	"cloak":   `<path d="M44 16h40l16 32 12 60-32 8-16-12-16 12-32-8 12-60z" fill="#3a7670"/><path d="M44 16 64 40 84 16v28L64 60 44 44z" fill="#77b49d"/><path d="m44 44 12 16-8 56-32-8z" fill="#234b4a"/><path d="M60 44h8v12h-8z" fill="#edce85"/>`,
	"crown":   `<path d="m16 28 28 20 20-32 20 32 28-20-12 68H28z" fill="#c79e48"/><path d="M28 76h72v20H28z" fill="#edcd7d"/><path d="M56 56h16v20H56z" fill="#5bc7c8"/>`,
	"heart":   `<path d="M20 32h32l12 12 12-12h32v36l-44 44-44-44z" fill="#b66586"/><path d="M28 40h20l12 12-8 12H28z" fill="#f1b5c0"/><path d="m64 56 36-16v24l-36 36z" fill="#7d4d85"/>`,
	"egg":     `<path d="M52 16h24l16 20 12 36-8 28-20 12H52l-20-12-8-28 12-36z" fill="#6b5386"/><path d="M52 24h16L52 64 36 76l-4-12 12-28z" fill="#ab8fc0"/><path d="M68 72h20v16H68zM44 88h12v12H44z" fill="#b0a5d7"/>`,
	"helmet":  `<path d="M40 16h48l12 12v56l-12 16v12H40v-12L28 84V28z" fill="#9aa3ad"/><path d="M44 20h20v84H44z" fill="#c9d0d6"/><path d="M36 48h56v8H36zm24 8h8v36h-8z" fill="#1d2329"/><path d="M60 4h8v12h-8z" fill="#d9b24a"/><path d="M52 100h24v12H52z" fill="#d9b24a"/>`,
	"scale":   `<path d="m64 16 40 24-8 44-32 32-32-32-8-44z" fill="#5d917c"/><path d="m24 40 40 24 40-24M32 64l32 24 32-24" fill="none" stroke="#a3c4a0" stroke-width="6"/>`,
}

func itemSVG(item store.LootItem) string {
	shape, ok := itemShapes[item.Glyph]
	if !ok {
		shape = itemShapes["crystal"]
	}
	return fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img"><title>%s</title><g stroke-linejoin="miter">%s</g></svg>`, html.EscapeString(item.Title), shape)
}
