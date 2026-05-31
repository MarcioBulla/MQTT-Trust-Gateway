export function setNotice(message, type = '') {
  const notice = document.getElementById('notice');
  notice.className = type;
  notice.textContent = message;
}
