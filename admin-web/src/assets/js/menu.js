export function closeSettingsMenu() {
  const menu = document.getElementById('settingsMenu');
  const button = document.getElementById('settingsMenuButton');
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
}

export function toggleSettingsMenu() {
  const menu = document.getElementById('settingsMenu');
  const button = document.getElementById('settingsMenuButton');
  menu.hidden = !menu.hidden;
  button.setAttribute('aria-expanded', String(!menu.hidden));
}

export function bindSettingsMenu() {
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.dropdown')) closeSettingsMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSettingsMenu();
  });
}
