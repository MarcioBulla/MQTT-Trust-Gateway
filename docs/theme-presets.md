# Theme presets and OLED

Settings → General → Theme colors extends the existing editable Vuetify colors. No additional theme engine, dependency, external asset or network request is used at runtime.

Choose a preset to populate both Light and Dark colors. All five existing color roles remain editable. Selecting a preset, toggling OLED, or editing a color previews immediately. Save preferences persists the existing presentation object together with `preset` and `oled` on the current account. Leaving Settings discards unsaved previews. Editing a preset palette changes the selector to Custom. Existing accounts keep their custom colors; OLED defaults off.

OLED is an independent override: Dark background becomes `#000000`, Dark surface becomes `#0D0D0D`. Accent and chart colors remain unchanged. Light mode ignores the override without clearing it. Disabling OLED restores the stored palette, including manual edits. Restore default colors does not change the independent OLED preference.

These are adaptations of palette colors to the gateway's existing five roles, not complete upstream editor themes. Nord Light is explicitly adapted. No upstream runtime or assets are bundled.

| Preset | Light | Dark | Palette reference |
| --- | --- | --- | --- |
| Dracula | Alucard Classic | Dracula Classic | [Specification](https://draculatheme.com/spec) |
| Catppuccin | Latte | Mocha | [Palette](https://catppuccin.com/palette/) |
| Tokyo Night | Day | Night | [Source](https://github.com/folke/tokyonight.nvim) |
| Gruvbox | Light | Dark | [Source](https://github.com/morhetz/gruvbox) |
| Kanagawa | Lotus | Wave | [Source](https://github.com/rebelot/kanagawa.nvim) |
| Rosé Pine | Dawn | Moon | [Palette](https://rosepinetheme.com/palette/) |
| Everforest | Light | Dark | [Source](https://github.com/sainnhe/everforest) |
| GitHub | Light | Dark | [Primer](https://primer.style/primitives/colors) |
| Nightfox | Dayfox | Nightfox | [Source](https://github.com/EdenEast/nightfox.nvim) |
| Solarized | Light | Dark | [Palette](https://ethanschoonover.com/solarized/) |
| One | One Light | One Dark | [Light](https://github.com/atom/one-light-syntax), [Dark](https://github.com/atom/one-dark-syntax) |
| Ayu | Light | Mirage | [Palette](https://github.com/ayu-theme/ayu-colors) |
| Nord | Light (adapted) | Polar Night | [Palette](https://www.nordtheme.com/docs/colors-and-palettes/) |
| Tailwind Zinc | Light | Dark | [Palette](https://v3.tailwindcss.com/docs/customizing-colors) |

Tests cover all 14 pairs, legacy preferences, invalid inputs, OLED isolation/non-mutation, backend preference persistence, live preview, Light/Dark switching and manual edits after preset selection. Custom colors may reduce contrast; restore defaults when needed.
