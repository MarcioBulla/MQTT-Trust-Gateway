export function appHeader() {
  return `<header id="appHeader" hidden>
    <div class="brand">
      <span class="nf icon">&#xf1de;</span>
      <div>
        <strong>MQTT Trust Gateway</strong>
        <div class="muted" id="headerUsername"></div>
      </div>
    </div>
    <nav class="main-nav">
      <button id="mqttManagerTab" class="secondary" type="button"><span class="nf">&#xf233;</span> MQTT Manager</button>
      <button id="signaturesTab" class="secondary" type="button"><span class="nf">&#xf0e3;</span> Assinaturas</button>
    </nav>
    <div class="header-actions">
      <div class="dropdown">
        <button id="settingsMenuButton" class="icon-button secondary" type="button" aria-haspopup="true" aria-expanded="false" title="Settings">
          <span class="nf">&#xf013;</span>
        </button>
        <div id="settingsMenu" class="dropdown-menu" hidden>
          <button id="settingsTab" class="menu-item" type="button"><span class="nf">&#xf013;</span> Settings</button>
          <button id="themeToggleButton" class="menu-item" type="button"><span class="nf">&#xf186;</span> Light mode</button>
          <button id="logoutButton" class="menu-item danger" type="button"><span class="nf">&#xf08b;</span> Logout</button>
        </div>
      </div>
    </div>
  </header>`;
}
