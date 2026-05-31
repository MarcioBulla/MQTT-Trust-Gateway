export function authSections() {
  return `<section id="setup" hidden>
    <h2>Register Passkey</h2>
    <input id="setupToken" placeholder="Setup token">
    <input id="username" placeholder="Admin username" value="admin">
    <button id="registerPasskeyButton" type="button"><span class="nf">&#xf084;</span> Register passkey</button>
  </section>
  <section id="login" hidden>
    <h2>Login</h2>
    <input id="loginUsername" placeholder="Admin username" value="admin">
    <button id="loginPasskeyButton" type="button"><span class="nf">&#xf090;</span> Login with passkey</button>
  </section>`;
}
