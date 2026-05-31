export function settingsSection() {
  return `<div id="settingsView" hidden>
    <h2>Settings</h2>
    <section class="panel">
      <label>Username<input id="settingsUsername" placeholder="Username"></label>
      <button id="saveUsernameButton" type="button"><span class="nf">&#xf0c7;</span> Save username</button>
    </section>
    <section class="panel">
      <h3>Passkeys</h3>
      <button id="addPasskeyButton" type="button"><span class="nf">&#xf084;</span> Add passkey</button>
      <div id="passkeyList"></div>
    </section>
  </div>`;
}
