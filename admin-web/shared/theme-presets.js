// Palette colors mapped onto the existing five editable Vuetify roles.
// UI role choices are adaptations; no upstream theme runtime is bundled.
const colors = (primary, background, surface, received, sent) => ({ primary, background, surface, received, sent });
const preset = (id, title, lightVariant, darkVariant, source, light, dark) => ({ id, title, lightVariant, darkVariant, source, themes: { light: colors(...light), dark: colors(...dark) } });
export const themePresets = [
  preset('dracula', 'Dracula', 'Alucard Classic', 'Dracula Classic', 'https://draculatheme.com/spec',
    ['#644AC9','#FFFBEB','#EFEDDC','#036A96','#14710A'], ['#BD93F9','#282A36','#343746','#8BE9FD','#50FA7B']),
  preset('catppuccin', 'Catppuccin', 'Latte', 'Mocha', 'https://catppuccin.com/palette/',
    ['#8839EF','#EFF1F5','#E6E9EF','#1E66F5','#40A02B'], ['#CBA6F7','#1E1E2E','#313244','#89B4FA','#A6E3A1']),
  preset('tokyo-night', 'Tokyo Night', 'Day', 'Night', 'https://github.com/folke/tokyonight.nvim',
    ['#2E7DE9','#E1E2E7','#D0D5E3','#2E7DE9','#587539'], ['#7AA2F7','#1A1B26','#24283B','#7DCFFF','#9ECE6A']),
  preset('gruvbox', 'Gruvbox', 'Light', 'Dark', 'https://github.com/morhetz/gruvbox',
    ['#076678','#FBF1C7','#EBDBB2','#458588','#79740E'], ['#83A598','#282828','#3C3836','#83A598','#B8BB26']),
  preset('kanagawa', 'Kanagawa', 'Lotus', 'Wave', 'https://github.com/rebelot/kanagawa.nvim',
    ['#4D699B','#F2ECBC','#E7DBA0','#4D699B','#6F894E'], ['#957FB8','#1F1F28','#2A2A37','#7E9CD8','#98BB6C']),
  preset('rose-pine', 'Rosé Pine', 'Dawn', 'Moon', 'https://rosepinetheme.com/palette/',
    ['#907AA9','#FAF4ED','#FFFAF3','#286983','#56949F'], ['#C4A7E7','#232136','#2A273F','#9CCFD8','#EA9A97']),
  preset('everforest', 'Everforest', 'Light', 'Dark', 'https://github.com/sainnhe/everforest',
    ['#3A94C5','#FDF6E3','#F4F0D9','#3A94C5','#8DA101'], ['#A7C080','#2D353B','#343F44','#7FBBB3','#A7C080']),
  preset('github', 'GitHub', 'Light', 'Dark', 'https://primer.style/primitives/colors',
    ['#0969DA','#FFFFFF','#F6F8FA','#0969DA','#1A7F37'], ['#58A6FF','#0D1117','#161B22','#58A6FF','#3FB950']),
  preset('nightfox', 'Nightfox', 'Dayfox', 'Nightfox', 'https://github.com/EdenEast/nightfox.nvim',
    ['#6E33CE','#F6F2EE','#E4DCD4','#2848A9','#396847'], ['#9D79D6','#192330','#212E3F','#719CD6','#81B29A']),
  preset('solarized', 'Solarized', 'Light', 'Dark', 'https://ethanschoonover.com/solarized/',
    ['#268BD2','#FDF6E3','#EEE8D5','#268BD2','#859900'], ['#268BD2','#002B36','#073642','#2AA198','#859900']),
  preset('one', 'One', 'One Light', 'One Dark', 'https://github.com/atom/one-dark-syntax',
    ['#4078F2','#FAFAFA','#F0F0F0','#4078F2','#50A14F'], ['#61AFEF','#282C34','#21252B','#61AFEF','#98C379']),
  preset('ayu', 'Ayu', 'Light', 'Mirage', 'https://github.com/ayu-theme/ayu-colors',
    ['#FF9940','#F8F9FA','#F3F4F5','#399EE6','#86B300'], ['#FFCC66','#1F2430','#232834','#73D0FF','#D5FF80']),
  preset('nord', 'Nord', 'Light (adapted)', 'Polar Night', 'https://www.nordtheme.com/docs/colors-and-palettes/',
    ['#5E81AC','#ECEFF4','#E5E9F0','#5E81AC','#8FBCBB'], ['#88C0D0','#2E3440','#3B4252','#81A1C1','#A3BE8C']),
  preset('tailwind-zinc', 'Tailwind Zinc', 'Light', 'Dark', 'https://v3.tailwindcss.com/docs/customizing-colors',
    ['#3F3F46','#FAFAFA','#F4F4F5','#2563EB','#16A34A'], ['#D4D4D8','#09090B','#18181B','#60A5FA','#4ADE80']),
];
export function effectiveThemeColors(preferences, mode) {
  const colors = preferences.themes[mode];
  const oled = mode === 'dark' && preferences.oled === true;
  return { primary: colors.primary, background: oled ? '#000000' : colors.background,
    surface: oled ? '#0D0D0D' : colors.surface,
    'chart-received': colors.received, 'chart-sent': colors.sent };
}
