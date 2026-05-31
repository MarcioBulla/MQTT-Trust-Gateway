const storageKey = 'mqtt-trust-gateway-theme';

function preferredTheme() {
  const saved = localStorage.getItem(storageKey);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(theme = preferredTheme()) {
  document.documentElement.dataset.theme = theme;
  const button = document.getElementById('themeToggleButton');
  if (button) button.innerHTML = theme === 'dark'
    ? '<span class="nf">&#xf185;</span> Light mode'
    : '<span class="nf">&#xf186;</span> Dark mode';
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(storageKey, next);
  applyTheme(next);
}
