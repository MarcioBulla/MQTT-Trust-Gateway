import { requestJson } from './api.js';
import { loginPasskey, logout, registerPasskey } from './auth.js';
import { bindCertificateList, downloadCaCertificate, downloadCertificate, loadCertificates, loadCsrFile, scheduleProvisionerPasswordClear, signCsr, toggleCsrHelp, unlockProvisionerPassword, updateCsrHelpCommands } from './certificates.js';
import { bindSettingsMenu, closeSettingsMenu, toggleSettingsMenu } from './menu.js';
import { bindTopicTools, loadStatus, loadTopics, publishMessage } from './mqtt-manager.js';
import { setNotice } from './notice.js';
import { showAuth, showView } from './navigation.js';
import { getCurrentUser } from './state.js';
import { applyTheme, toggleTheme } from './theme.js';
import { addPasskey, loadMe, renderUser, saveUsername } from './user.js';

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    setNotice(error.message || String(error), 'error');
  }
}

async function init() {
  try {
    const data = await requestJson('/api/bootstrap');
    if (data.user) {
      renderUser(data.user);
      showView('mqttManagerView');
      await loadStatus();
      await loadTopics();
    } else {
      showAuth(data.hasAdmin ? 'login' : 'setup');
    }
  } catch (error) {
    showAuth('login');
    setNotice(error.message || String(error), 'error');
  }
}

window.addEventListener('error', (event) => setNotice(event.message || 'Browser script error.', 'error'));
window.addEventListener('unhandledrejection', (event) => setNotice(event.reason?.message || String(event.reason || 'Unhandled browser error.'), 'error'));
document.getElementById('registerPasskeyButton').addEventListener('click', () => runAction(registerPasskey));
document.getElementById('loginPasskeyButton').addEventListener('click', () => runAction(() => loginPasskey()));
document.getElementById('mqttManagerTab').addEventListener('click', () => runAction(async () => { showView('mqttManagerView'); await loadStatus(); await loadTopics(); }));
document.getElementById('signaturesTab').addEventListener('click', () => runAction(async () => { showView('signaturesView'); updateCsrHelpCommands(); await loadCertificates(); }));
document.getElementById('settingsMenuButton').addEventListener('click', (event) => { event.stopPropagation(); toggleSettingsMenu(); });
document.getElementById('settingsTab').addEventListener('click', () => { closeSettingsMenu(); showView('settingsView'); if (getCurrentUser()) renderUser(getCurrentUser()); });
document.getElementById('themeToggleButton').addEventListener('click', () => { toggleTheme(); closeSettingsMenu(); });
document.getElementById('refreshStatusButton').addEventListener('click', () => runAction(async () => { await loadStatus(); await loadTopics(); }));
document.getElementById('refreshTopicsButton').addEventListener('click', () => runAction(loadTopics));
document.getElementById('publishButton').addEventListener('click', () => runAction(publishMessage));
document.getElementById('logoutButton').addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const button = event.currentTarget;
  button.disabled = true;
  closeSettingsMenu();
  runAction(logout).finally(() => { button.disabled = false; });
});
document.getElementById('signCsrButton').addEventListener('click', () => runAction(signCsr));
document.getElementById('downloadCertButton').addEventListener('click', () => runAction(downloadCertificate));
document.getElementById('downloadCaButton').addEventListener('click', downloadCaCertificate);
document.getElementById('csrFile').addEventListener('change', (event) => runAction(() => loadCsrFile(event.target.files[0])));
document.getElementById('deviceId').addEventListener('input', updateCsrHelpCommands);
document.getElementById('provisionerPassword').addEventListener('input', scheduleProvisionerPasswordClear);
document.getElementById('submitProvisionerPasswordButton').addEventListener('click', () => runAction(unlockProvisionerPassword));
document.getElementById('refreshCertificatesButton').addEventListener('click', () => runAction(loadCertificates));
document.getElementById('csrHelpToggle').addEventListener('click', toggleCsrHelp);
document.getElementById('saveUsernameButton').addEventListener('click', () => runAction(saveUsername));
document.getElementById('addPasskeyButton').addEventListener('click', () => runAction(addPasskey));
applyTheme();
bindSettingsMenu();
bindTopicTools();
bindCertificateList();
updateCsrHelpCommands();
init();
