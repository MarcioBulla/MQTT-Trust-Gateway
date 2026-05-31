#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/broker.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "This wizard must be run as root. Use: sudo ./setup-wizard.sh" >&2
  exit 1
fi

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

if [ -t 1 ]; then
  C_RESET="$(printf '\033[0m')"
  C_BOLD="$(printf '\033[1m')"
  C_BLUE="$(printf '\033[34m')"
  C_CYAN="$(printf '\033[36m')"
  C_GREEN="$(printf '\033[32m')"
  C_YELLOW="$(printf '\033[33m')"
  C_RED="$(printf '\033[31m')"
else
  C_RESET=""
  C_BOLD=""
  C_BLUE=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
fi

title() {
  printf "%s%s%s\n" "${C_BOLD}${C_BLUE}" "$1" "${C_RESET}"
  pace
}

ok() {
  printf "%s%s%s\n" "${C_GREEN}" "$1" "${C_RESET}"
  pace
}

warn() {
  printf "%s%s%s\n" "${C_YELLOW}" "$1" "${C_RESET}"
  pace
}

info() {
  printf "%s%s%s\n" "${C_CYAN}" "$1" "${C_RESET}"
  pace
}

err() {
  printf "%s%s%s\n" "${C_RED}" "$1" "${C_RESET}"
  pace
}

pace() {
  if [ -t 1 ]; then
    sleep "${WIZARD_DELAY_SECONDS:-0.15}" 2>/dev/null || true
  fi
}

run_compose() {
  env \
    MQTT_DOMAIN="${MQTT_DOMAIN}" \
    CERTBOT_EMAIL="${CERTBOT_EMAIL}" \
    CERTBOT_ARGS="${CERTBOT_ARGS}" \
    CONTAINER_NAME="${CONTAINER_NAME}" \
    IMAGE_NAME="${IMAGE_NAME}" \
    ACME_HTTP_PORT="${ACME_HTTP_PORT}" \
    MQTT_TLS_PORT="${MQTT_TLS_PORT}" \
    MQTT_WS_TLS_PORT="${MQTT_WS_TLS_PORT}" \
    ADMIN_HTTPS_PORT="${ADMIN_HTTPS_PORT}" \
    ADMIN_APP_PORT="${ADMIN_APP_PORT}" \
    BASE_DIR="${BASE_DIR}" \
    MQTT_TOPIC_PREFIX="${MQTT_TOPIC_PREFIX}" \
    STEP_CA_DOMAIN="${STEP_CA_DOMAIN}" \
    STEP_CA_PORT="${STEP_CA_PORT}" \
    STEP_CA_URL="${STEP_CA_URL}" \
    STEP_CA_PROVISIONER="${STEP_CA_PROVISIONER}" \
    STEP_CA_FINGERPRINT="${STEP_CA_FINGERPRINT}" \
    STEP_CA_DEVICE_CERT_TTL="${STEP_CA_DEVICE_CERT_TTL}" \
    ADMIN_RP_NAME="${ADMIN_RP_NAME}" \
    ADMIN_RP_ID="${ADMIN_RP_ID}" \
    ADMIN_ORIGIN="${ADMIN_ORIGIN}" \
    ADMIN_SETUP_TOKEN="${ADMIN_SETUP_TOKEN}" \
    ADMIN_SESSION_SECRET="${ADMIN_SESSION_SECRET}" \
    MQTT_USE_PUBLIC_IP="${MQTT_USE_PUBLIC_IP}" \
    "${CONTAINER_ENGINE}" compose "$@"
}

derive_public_endpoints() {
  STEP_CA_DOMAIN="${MQTT_DOMAIN}"
  STEP_CA_URL="https://${MQTT_DOMAIN}:${STEP_CA_PORT}"
  ADMIN_RP_ID="${MQTT_DOMAIN}"
  ADMIN_ORIGIN="https://${MQTT_DOMAIN}"
}

compose_available() {
  "${CONTAINER_ENGINE}" compose version >/dev/null 2>&1
}

absolute_path() {
  path_value="$1"
  case "${path_value}" in
    /*) printf "%s\n" "${path_value}" ;;
    ./*) printf "%s/%s\n" "${SCRIPT_DIR}" "${path_value#./}" ;;
    *) printf "%s/%s\n" "${SCRIPT_DIR}" "${path_value}" ;;
  esac
}

fix_step_ca_permissions() {
  if [ -d "${BASE_DIR}/step-ca" ]; then
    chown -R 1000:1000 "${BASE_DIR}/step-ca"
    chmod 700 "${BASE_DIR}/step-ca/secrets"
    [ ! -f "${BASE_DIR}/step-ca/secrets/password" ] || chmod 600 "${BASE_DIR}/step-ca/secrets/password"
  fi
}

normalize_step_ca_container_paths() {
  step_ca_dir="${BASE_DIR}/step-ca"
  if [ -f "${step_ca_dir}/config/ca.json" ]; then
    sed -i "s#${step_ca_dir}#/home/step#g" "${step_ca_dir}/config/ca.json"
  fi
  if [ -f "${step_ca_dir}/config/defaults.json" ]; then
    sed -i "s#${step_ca_dir}#/home/step#g" "${step_ca_dir}/config/defaults.json"
  fi
}

configure_step_ca_provisioner_claims() {
  config_file="${BASE_DIR}/step-ca/config/ca.json"
  if [ ! -f "${config_file}" ]; then
    err "step-ca config not found: ${config_file}"
    exit 1
  fi

  python3 - "${config_file}" "${STEP_CA_PROVISIONER}" "${STEP_CA_DEVICE_CERT_TTL}" <<'PY'
import json
import sys

config_file, provisioner_name, ttl = sys.argv[1:4]
with open(config_file, "r", encoding="utf-8") as fh:
    config = json.load(fh)

for provisioner in config.get("authority", {}).get("provisioners", []):
    if provisioner.get("name") == provisioner_name:
        provisioner["claims"] = {
            "minTLSCertDuration": "5m",
            "maxTLSCertDuration": ttl,
            "defaultTLSCertDuration": ttl,
            "disableRenewal": False,
        }
        break
else:
    print(f"Provisioner {provisioner_name!r} not found", file=sys.stderr)
    sys.exit(1)

with open(config_file, "w", encoding="utf-8") as fh:
    json.dump(config, fh, indent="\t")
    fh.write("\n")
PY
  ok "Provisioner '${STEP_CA_PROVISIONER}' duration claims set to ${STEP_CA_DEVICE_CERT_TTL}."
}

bootstrap_step_ca() {
  step_ca_dir="${BASE_DIR}/step-ca"
  config_file="${step_ca_dir}/config/ca.json"
  password_file="${step_ca_dir}/secrets/password"
  step_ca_addr=":${STEP_CA_PORT}"

  mkdir -p "${step_ca_dir}/certs" "${step_ca_dir}/config" "${step_ca_dir}/db" "${step_ca_dir}/secrets"
  chmod 700 "${step_ca_dir}/secrets"

  if [ -f "${config_file}" ]; then
    ok "step-ca already initialized at ${step_ca_dir}"
  else
    if [ ! -f "${password_file}" ]; then
      err "Missing password file: ${password_file}"
      exit 1
    fi

    STEPPATH="${step_ca_dir}" step ca init \
      --name "MQTT Trust Gateway Device CA" \
      --dns "${STEP_CA_DOMAIN}" \
      --address "${step_ca_addr}" \
      --provisioner "${STEP_CA_PROVISIONER}" \
      --password-file "${password_file}" \
      --provisioner-password-file "${password_file}" \
      --deployment-type standalone \
      --with-ca-url "${STEP_CA_URL}"

    ok "step-ca initialized at ${step_ca_dir}"
  fi

  normalize_step_ca_container_paths
  configure_step_ca_provisioner_claims

  if ! grep -q "\"name\"[[:space:]]*:[[:space:]]*\"${STEP_CA_PROVISIONER}\"" "${config_file}"; then
    err "Provisioner '${STEP_CA_PROVISIONER}' was not found in ${config_file}."
    exit 1
  fi

  STEP_CA_FINGERPRINT="$(step certificate fingerprint "${step_ca_dir}/certs/root_ca.crt")"
  ok "Root CA fingerprint: ${STEP_CA_FINGERPRINT}"
}

export_step_ca_client_ca() {
  source_ca="${BASE_DIR}/step-ca/certs/root_ca.crt"
  target_dir="${BASE_DIR}/pki/step-ca"
  target_ca="${target_dir}/ca.crt"

  if [ ! -f "${source_ca}" ]; then
    err "step-ca root CA not found: ${source_ca}"
    exit 1
  fi

  mkdir -p "${target_dir}"
  cp "${source_ca}" "${target_ca}"
  chmod 644 "${target_ca}"
  ok "Exported client CA to ${target_ca}"
}

set_env_value() {
  env_key="$1"
  env_value="$2"
  if grep -q "^${env_key}=" "${ENV_FILE}"; then
    sed -i "s#^${env_key}=.*#${env_key}=${env_value}#" "${ENV_FILE}"
  else
    printf "%s=%s\n" "${env_key}" "${env_value}" >> "${ENV_FILE}"
  fi
}

env_value() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/"
}

env_file_has_key() {
  env_key="$1"
  [ -f "${ENV_FILE}" ] && grep -q "^${env_key}=" "${ENV_FILE}"
}

read_line() {
  prompt_text="$1"
  default_value="${2:-}"
  input_value=""

  if [ -t 0 ]; then
    if [ -n "${default_value}" ]; then
      read -r -e -i "${default_value}" -p "${prompt_text}" input_value || true
    else
      read -r -e -p "${prompt_text}" input_value || true
    fi
  else
    printf "%s" "${prompt_text}"
    read -r input_value || true
  fi
}

prompt_default() {
  var_name="$1"
  prompt_text="$2"
  default_value="$3"
  prompt_value="$(printf "%s? %s%s%s [%s%s%s]: " "${C_BOLD}${C_CYAN}" "${C_RESET}" "$prompt_text" "${C_YELLOW}" "${default_value}" "${C_RESET}")"
  if env_file_has_key "${var_name}" && [ -n "${default_value}" ]; then
    read_line "${prompt_value}" "${default_value}"
  else
    read_line "${prompt_value}"
  fi
  if [ -z "${input_value}" ]; then
    printf -v "${var_name}" "%s" "${default_value}"
  else
    printf -v "${var_name}" "%s" "${input_value}"
  fi
  pace
}

prompt_required() {
  var_name="$1"
  prompt_text="$2"
  while :; do
    prompt_value="$(printf "%s? %s%s%s: " "${C_BOLD}${C_CYAN}" "${C_RESET}" "$prompt_text" "${C_RESET}")"
    read_line "${prompt_value}"
    if [ -n "${input_value}" ]; then
      printf -v "${var_name}" "%s" "${input_value}"
      pace
      return 0
    fi
    err "This field is required."
  done
}

prompt_domain_or_public_ip() {
  current_domain="${MQTT_DOMAIN:-}"
  case "${current_domain}" in
    ""|mqtt.example.com) current_domain="" ;;
  esac

  if [ -n "${current_domain}" ]; then
    prompt_value="$(printf "%s? %sDomain%s [%s%s%s, empty = public IP]: " "${C_BOLD}${C_CYAN}" "${C_RESET}" "${C_RESET}" "${C_YELLOW}" "${current_domain}" "${C_RESET}")"
  else
    prompt_value="$(printf "%s? %sDomain%s [%spublic IP%s]: " "${C_BOLD}${C_CYAN}" "${C_RESET}" "${C_RESET}" "${C_YELLOW}" "${C_RESET}")"
  fi

  if env_file_has_key "MQTT_DOMAIN" && [ -n "${current_domain}" ]; then
    read_line "${prompt_value}" "${current_domain}"
  else
    read_line "${prompt_value}"
  fi
  if [ -n "${input_value}" ]; then
    MQTT_DOMAIN="${input_value}"
    MQTT_USE_PUBLIC_IP="no"
    return 0
  fi

  MQTT_USE_PUBLIC_IP="yes"
  if [ -n "${PUBLIC_IP:-}" ]; then
    MQTT_DOMAIN="${PUBLIC_IP}"
    return 0
  fi

  prompt_required MQTT_DOMAIN "Public IP"
}

has_step_cli() {
  command -v step >/dev/null 2>&1
}

read_secret() {
  secret_prompt_text="$1"
  while :; do
    prompt_value="$(printf "%s? %s%s%s: " "${C_BOLD}${C_CYAN}" "${C_RESET}" "${secret_prompt_text}" "${C_RESET}")"
    if [ -t 0 ]; then
      read -r -s -e -p "${prompt_value}" SECRET_VALUE || true
      printf "\n"
    else
      printf "%s" "${prompt_value}"
      read -r SECRET_VALUE || true
    fi
    if [ -n "${SECRET_VALUE}" ]; then
      pace
      return 0
    fi
    err "This field is required."
  done
}

prompt_secret_confirmed() {
  prompt_text="$1"
  while :; do
    read_secret "${prompt_text}"
    first_secret="${SECRET_VALUE}"
    read_secret "Repeat ${prompt_text}"
    second_secret="${SECRET_VALUE}"
    if [ "${first_secret}" = "${second_secret}" ]; then
      STEP_CA_PASSWORD="${first_secret}"
      return 0
    fi
    err "Passwords do not match. Try again."
  done
}

prompt_yes_no() {
  var_name="$1"
  prompt_text="$2"
  default_value="$3"
  case "${default_value}" in
    yes) prompt_suffix="Y/n" ;;
    no) prompt_suffix="y/N" ;;
    *) err "Invalid yes/no default: ${default_value}"; exit 1 ;;
  esac
  while :; do
    prompt_value="$(printf "%s? %s%s%s [%s%s%s]: " "${C_BOLD}${C_CYAN}" "${C_RESET}" "$prompt_text" "${C_YELLOW}" "${prompt_suffix}" "${C_RESET}")"
    read_line "${prompt_value}"
    yn="${input_value}"
    if [ -z "${yn}" ]; then
      case "${default_value}" in
        yes) yn="y" ;;
        no) yn="n" ;;
      esac
    fi
    case "${yn}" in
      y|Y)
        printf -v "${var_name}" "%s" "yes"
        pace
        return 0
        ;;
      n|N)
        printf -v "${var_name}" "%s" "no"
        pace
        return 0
        ;;
      *)
        warn "Please answer y or n."
        ;;
    esac
  done
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

report_command() {
  command_name="$1"
  required="$2"
  if has_command "${command_name}"; then
    ok "  - ${command_name}: found"
    return 0
  fi

  if [ "${required}" = "required" ]; then
    err "  - ${command_name}: missing"
  else
    warn "  - ${command_name}: missing"
  fi
  return 1
}

check_selected_engine() {
  title "=== Container Engine Check ==="
  if ! report_command "${CONTAINER_ENGINE}" "required"; then
    prompt_yes_no CONTINUE_WITH_MISSING "Continue anyway?" "no"
    if [ "${CONTINUE_WITH_MISSING}" != "yes" ]; then
      warn "Execution interrupted by user."
      exit 0
    fi
    return 0
  fi

  if ! compose_available; then
    err "  - ${CONTAINER_ENGINE} compose: missing or not working"
    prompt_yes_no CONTINUE_WITH_MISSING "Continue anyway?" "no"
    if [ "${CONTINUE_WITH_MISSING}" != "yes" ]; then
      warn "Execution interrupted by user."
      exit 0
    fi
  else
    ok "  - ${CONTAINER_ENGINE} compose: available"
  fi
}

compose_command_available() {
  engine="$1"
  if ! has_command "${engine}"; then
    return 1
  fi
  "${engine}" compose version >/dev/null 2>&1
}

preferred_container_engine() {
  if compose_command_available "podman"; then
    printf "podman\n"
    return 0
  fi
  if compose_command_available "docker"; then
    printf "docker\n"
    return 0
  fi
  printf "podman\n"
}

prompt_container_engine() {
  default_engine="$1"
  while :; do
    prompt_default CONTAINER_ENGINE "Container engine (docker/podman)" "${default_engine}"
    case "${CONTAINER_ENGINE}" in
      docker|podman) return 0 ;;
      *) warn "Choose docker or podman." ;;
    esac
  done
}

initial_prerequisite_check() {
  missing_required=0
  missing_optional=0
  engine_available=0

  title "=== Prerequisite Check ==="

  if compose_command_available "podman"; then
    ok "  - podman compose: available"
    engine_available=1
  else
    warn "  - podman compose: missing or not working"
  fi

  if compose_command_available "docker"; then
    ok "  - docker compose: available"
    engine_available=1
  else
    warn "  - docker compose: missing or not working"
  fi

  if [ "${engine_available}" -ne 1 ]; then
    err "  - container engine: no working podman/docker compose found"
    missing_required=1
  fi

  if ! report_command "openssl" "required"; then
    missing_required=1
  fi

  if ! report_command "step" "required"; then
    missing_required=1
  fi

  if ! report_command "python3" "required"; then
    missing_required=1
  fi

  if ! report_command "ss" "optional"; then
    missing_optional=1
  fi

  if ! report_command "dig" "optional"; then
    missing_optional=1
  fi

  if ! has_command "ufw" && ! has_command "firewall-cmd"; then
    warn "  - firewall checker: ufw/firewalld not found"
    missing_optional=1
  else
    ok "  - firewall checker: available"
  fi

  if [ "${missing_required}" -eq 0 ] && [ "${missing_optional}" -eq 0 ]; then
    ok "All checked prerequisites are available."
    return 0
  fi

  if [ "${missing_required}" -eq 1 ]; then
    warn "Required dependencies are missing. The setup will probably fail."
  else
    warn "Only optional dependencies are missing. Some checks may be less informative."
  fi

  prompt_yes_no CONTINUE_WITH_MISSING "Continue anyway?" "no"
  if [ "${CONTINUE_WITH_MISSING}" != "yes" ]; then
    warn "Execution interrupted by user."
    exit 0
  fi
}

port_in_use() {
  port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss -lnt 2>/dev/null | awk '{print $4}' | grep -E -q "(^|:)${port}$"; then
      return 0
    fi
    return 1
  fi

  if command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi

  return 2
}

check_firewall_port() {
  port="$1"

  if command -v ufw >/dev/null 2>&1; then
    ufw_out="$(ufw status 2>/dev/null || true)"
    if printf "%s\n" "${ufw_out}" | grep -qi "Status: active"; then
      if printf "%s\n" "${ufw_out}" | grep -E -q "(^|[[:space:]])${port}(/tcp)?([[:space:]]|$).*ALLOW"; then
        ok "  - firewall (ufw): port ${port} allowed"
      else
        warn "  - firewall (ufw): port ${port} may be blocked"
      fi
      return 0
    fi
  fi

  if command -v firewall-cmd >/dev/null 2>&1; then
    if firewall-cmd --state >/dev/null 2>&1; then
      if firewall-cmd --quiet --query-port="${port}/tcp"; then
        ok "  - firewall (firewalld): port ${port}/tcp allowed"
      else
        warn "  - firewall (firewalld): port ${port}/tcp may be blocked"
      fi
      return 0
    fi
  fi

  warn "  - firewall: could not validate automatically (ufw/firewalld missing or inactive)"
}

check_iptables_input_port() {
  port="$1"
  if ! has_command "iptables"; then
    return 2
  fi

  if iptables -S INPUT 2>/dev/null | grep -q -- "--dport ${port} .* -j ACCEPT"; then
    return 0
  fi

  if iptables -S INPUT 2>/dev/null | grep -q -- "-A INPUT -j REJECT"; then
    return 1
  fi

  return 2
}

detect_public_ip() {
  if has_command "curl"; then
    public_ip="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
    if [ -n "${public_ip}" ]; then
      printf "%s\n" "${public_ip}"
      return 0
    fi
  fi

  if has_command "dig"; then
    public_ip="$(dig +short myip.opendns.com @resolver1.opendns.com 2>/dev/null | tail -n 1 || true)"
    if [ -n "${public_ip}" ]; then
      printf "%s\n" "${public_ip}"
      return 0
    fi
  fi

  return 1
}

is_ipv4_address() {
  printf "%s\n" "$1" | grep -E -q '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
}

check_dns_domain() {
  domain="$1"
  expected_ip="$2"

  if ! has_command "dig"; then
    warn "  - ${domain}: dig not available, DNS check skipped"
    return 0
  fi

  resolved_ips="$(dig +short "${domain}" A 2>/dev/null | grep -E '^[0-9.]+$' || true)"
  if [ -z "${resolved_ips}" ]; then
    warn "  - ${domain}: no A record found"
    return 1
  fi

  if [ -z "${expected_ip}" ]; then
    warn "  - ${domain}: resolves to $(printf "%s" "${resolved_ips}" | tr '\n' ' '), public VPS IP unknown"
    return 0
  fi

  if printf "%s\n" "${resolved_ips}" | grep -qx "${expected_ip}"; then
    ok "  - ${domain}: resolves to ${expected_ip}"
  else
    warn "  - ${domain}: resolves to $(printf "%s" "${resolved_ips}" | tr '\n' ' '), expected ${expected_ip}"
    return 1
  fi
}

print_iptables_fix() {
  cat <<EOF
Suggested local firewall fix:
  sudo iptables -I INPUT 4 -p tcp --dport ${ACME_HTTP_PORT} -j ACCEPT
  sudo iptables -I INPUT 4 -p tcp --dport ${ADMIN_HTTPS_PORT} -j ACCEPT
  sudo iptables -I INPUT 4 -p tcp --dport ${MQTT_TLS_PORT} -j ACCEPT
  sudo iptables -I INPUT 4 -p tcp --dport ${MQTT_WS_TLS_PORT} -j ACCEPT
  sudo iptables -I INPUT 4 -p tcp --dport ${STEP_CA_PORT} -j ACCEPT

These rules may not persist after reboot. Configure persistent firewall rules for your VPS image.
EOF
}

allow_iptables_input_port() {
  port="$1"
  if iptables -S INPUT 2>/dev/null | grep -q -- "--dport ${port} .* -j ACCEPT"; then
    return 0
  fi
  iptables -I INPUT 4 -p tcp --dport "${port}" -j ACCEPT
}

apply_iptables_fix() {
  allow_iptables_input_port "${ACME_HTTP_PORT}"
  allow_iptables_input_port "${ADMIN_HTTPS_PORT}"
  allow_iptables_input_port "${MQTT_TLS_PORT}"
  allow_iptables_input_port "${MQTT_WS_TLS_PORT}"
  allow_iptables_input_port "${STEP_CA_PORT}"
  ok "Local iptables rules applied for required ports."
  warn "These rules may not persist after reboot. Configure persistent firewall rules for your VPS image."
}

persist_iptables_rules() {
  if has_command "netfilter-persistent"; then
    netfilter-persistent save
    ok "iptables rules saved with netfilter-persistent."
    return 0
  fi

  warn "netfilter-persistent is not installed."
  if has_command "apt"; then
    warn "To persist rules on Ubuntu/Debian, install it with:"
    echo "  sudo apt update"
    echo "  sudo apt install -y iptables-persistent"
    echo "  sudo netfilter-persistent save"
  else
    warn "Install your distribution's persistent firewall package before rebooting."
  fi
}

random_secret() {
  if has_command "openssl"; then
    openssl rand -hex 32
    return 0
  fi
  date +%s | sha256sum | awk '{print $1}'
}

title "=== MQTT Trust Gateway Setup Wizard (step-ca) ==="
initial_prerequisite_check
title "=== Configuration ==="

PUBLIC_IP="$(detect_public_ip || true)"
if [ -n "${PUBLIC_IP}" ]; then
  info "Detected public VPS IP: ${PUBLIC_IP}"
else
  warn "Could not detect public VPS IP automatically."
fi

prompt_domain_or_public_ip
if [ "${MQTT_USE_PUBLIC_IP}" = "yes" ]; then
  info "No domain selected. Using public IP: ${MQTT_DOMAIN}"
  warn "IP-only mode requires a Certbot version with Let's Encrypt IP certificate support."
  warn "IP certificates require the Let's Encrypt shortlived profile; adding it to CERTBOT_ARGS when missing."
  case " ${CERTBOT_ARGS:-} " in
    *" --preferred-profile "*) ;;
    *) CERTBOT_ARGS="${CERTBOT_ARGS:+${CERTBOT_ARGS} }--preferred-profile shortlived" ;;
  esac
else
  info "Using domain: ${MQTT_DOMAIN}"
fi

prompt_default CERTBOT_EMAIL "Contact email (Let's Encrypt)" "${CERTBOT_EMAIL:-admin@example.com}"
prompt_default BASE_DIR "Host runtime directory" "${BASE_DIR:-./runtime}"
BASE_DIR="$(absolute_path "${BASE_DIR}")"

DEFAULT_CONTAINER_ENGINE="$(preferred_container_engine)"
prompt_container_engine "${CONTAINER_ENGINE:-${DEFAULT_CONTAINER_ENGINE}}"

CERTBOT_ARGS="${CERTBOT_ARGS:-}"
CONTAINER_NAME="${CONTAINER_NAME:-mqtt-trust-gateway}"
IMAGE_NAME="${IMAGE_NAME:-mqtt-trust-gateway}"
ACME_HTTP_PORT="${ACME_HTTP_PORT:-80}"
MQTT_TLS_PORT="${MQTT_TLS_PORT:-8883}"
MQTT_WS_TLS_PORT="${MQTT_WS_TLS_PORT:-8443}"
ADMIN_HTTPS_PORT="${ADMIN_HTTPS_PORT:-443}"
ADMIN_APP_PORT="${ADMIN_APP_PORT:-8080}"
MQTT_TOPIC_PREFIX="${MQTT_TOPIC_PREFIX:-devices}"
ADMIN_RP_NAME="${ADMIN_RP_NAME:-MQTT Trust Gateway}"
ADMIN_SETUP_TOKEN="${ADMIN_SETUP_TOKEN:-$(random_secret)}"
ADMIN_SESSION_SECRET="${ADMIN_SESSION_SECRET:-$(random_secret)}"

STEP_CA_PORT="${STEP_CA_PORT:-9000}"
derive_public_endpoints
STEP_CA_PROVISIONER="${STEP_CA_PROVISIONER:-mqtt-devices}"
STEP_CA_DEVICE_CERT_TTL="${STEP_CA_DEVICE_CERT_TTL:-17520h}"
STEP_CA_FINGERPRINT="${STEP_CA_FINGERPRINT:-}"

info "Admin Web URL: ${ADMIN_ORIGIN}"
info "MQTT TLS endpoint: ${MQTT_DOMAIN}:${MQTT_TLS_PORT}"
info "MQTT WSS endpoint: ${MQTT_DOMAIN}:${MQTT_WS_TLS_PORT}"
info "step-ca URL: ${STEP_CA_URL}"

prompt_yes_no ADVANCED_CONFIG "Edit advanced settings?" "no"
if [ "${ADVANCED_CONFIG}" = "yes" ]; then
  title "=== Advanced Settings ==="
  prompt_default CERTBOT_ARGS "Extra certbot args (example: --staging)" "${CERTBOT_ARGS}"
  prompt_default CONTAINER_NAME "Broker container name" "${CONTAINER_NAME}"
  prompt_default IMAGE_NAME "Broker image name" "${IMAGE_NAME}"
  prompt_default ACME_HTTP_PORT "ACME HTTP port" "${ACME_HTTP_PORT}"
  prompt_default MQTT_TLS_PORT "MQTT TLS port" "${MQTT_TLS_PORT}"
  prompt_default MQTT_WS_TLS_PORT "MQTT over WSS port" "${MQTT_WS_TLS_PORT}"
  prompt_default ADMIN_HTTPS_PORT "Admin HTTPS port" "${ADMIN_HTTPS_PORT}"
  prompt_default ADMIN_APP_PORT "Admin internal app port" "${ADMIN_APP_PORT}"
  prompt_default MQTT_TOPIC_PREFIX "MQTT topic prefix" "${MQTT_TOPIC_PREFIX}"
  prompt_default ADMIN_RP_NAME "Admin passkey display name" "${ADMIN_RP_NAME}"
  prompt_default STEP_CA_PORT "step-ca external port" "${STEP_CA_PORT}"
  derive_public_endpoints
  prompt_default STEP_CA_PROVISIONER "step-ca provisioner name" "${STEP_CA_PROVISIONER}"
  prompt_default STEP_CA_DEVICE_CERT_TTL "Device certificate TTL" "${STEP_CA_DEVICE_CERT_TTL}"
  prompt_default STEP_CA_FINGERPRINT "Root CA fingerprint (can be empty for now)" "${STEP_CA_FINGERPRINT}"
else
  info "Using default ports: HTTPS ${ADMIN_HTTPS_PORT}, MQTT ${MQTT_TLS_PORT}, WSS ${MQTT_WS_TLS_PORT}, step-ca ${STEP_CA_PORT}."
fi
title "=== DNS Check ==="
dns_mismatch=0
if [ "${MQTT_USE_PUBLIC_IP}" = "yes" ]; then
  info "DNS check skipped because this setup is using the public IP directly."
  if ! is_ipv4_address "${MQTT_DOMAIN}"; then
    warn "The selected public IP does not look like IPv4. Verify Certbot support for this address format before continuing."
  fi
else
  check_dns_domain "${MQTT_DOMAIN}" "${PUBLIC_IP}" || dns_mismatch=1
fi
if [ "${dns_mismatch}" -eq 1 ]; then
  warn "DNS does not appear to match this VPS. Certbot or step-ca clients may fail."
  prompt_yes_no CONTINUE_WITH_DNS_MISMATCH "Continue anyway?" "no"
  if [ "${CONTINUE_WITH_DNS_MISMATCH}" != "yes" ]; then
    warn "Execution interrupted by user."
    exit 0
  fi
fi

check_selected_engine

if has_step_cli; then
  prompt_yes_no SHOULD_BOOTSTRAP_CA "Run step-ca bootstrap now?" "yes"
else
  warn "step CLI not found. Bootstrap will be skipped for now."
  SHOULD_BOOTSTRAP_CA="no"
fi
if [ "${SHOULD_BOOTSTRAP_CA}" = "yes" ]; then
  prompt_secret_confirmed "Password for runtime/step-ca/secrets/password"
else
  STEP_CA_PASSWORD=""
fi

cat > "${ENV_FILE}" <<EOF
# Domain
MQTT_DOMAIN=$(env_value "${MQTT_DOMAIN}")
MQTT_USE_PUBLIC_IP=$(env_value "${MQTT_USE_PUBLIC_IP}")

# Certbot
CERTBOT_EMAIL=$(env_value "${CERTBOT_EMAIL}")
CERTBOT_ARGS=$(env_value "${CERTBOT_ARGS}")

# Container
CONTAINER_NAME=$(env_value "${CONTAINER_NAME}")
IMAGE_NAME=$(env_value "${IMAGE_NAME}")

# Ports
ACME_HTTP_PORT=$(env_value "${ACME_HTTP_PORT}")
MQTT_TLS_PORT=$(env_value "${MQTT_TLS_PORT}")
MQTT_WS_TLS_PORT=$(env_value "${MQTT_WS_TLS_PORT}")
ADMIN_HTTPS_PORT=$(env_value "${ADMIN_HTTPS_PORT}")
ADMIN_APP_PORT=$(env_value "${ADMIN_APP_PORT}")

# Paths on host
BASE_DIR=$(env_value "${BASE_DIR}")

# Client certificate authentication (step-ca)
MQTT_TOPIC_PREFIX=$(env_value "${MQTT_TOPIC_PREFIX}")

# step-ca
STEP_CA_DOMAIN=$(env_value "${STEP_CA_DOMAIN}")
STEP_CA_PORT=$(env_value "${STEP_CA_PORT}")
STEP_CA_URL=$(env_value "${STEP_CA_URL}")
STEP_CA_PROVISIONER=$(env_value "${STEP_CA_PROVISIONER}")
STEP_CA_FINGERPRINT=$(env_value "${STEP_CA_FINGERPRINT}")
STEP_CA_DEVICE_CERT_TTL=$(env_value "${STEP_CA_DEVICE_CERT_TTL}")

# Admin Web
ADMIN_RP_NAME=$(env_value "${ADMIN_RP_NAME}")
ADMIN_RP_ID=$(env_value "${ADMIN_RP_ID}")
ADMIN_ORIGIN=$(env_value "${ADMIN_ORIGIN}")
ADMIN_SETUP_TOKEN=$(env_value "${ADMIN_SETUP_TOKEN}")
ADMIN_SESSION_SECRET=$(env_value "${ADMIN_SESSION_SECRET}")
EOF

ok "Generated file: ${ENV_FILE}"
warn "Admin first-registration setup token: ${ADMIN_SETUP_TOKEN}"
warn "Use this token once at https://${MQTT_DOMAIN} to register the first passkey."

set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a

if [ "${SHOULD_BOOTSTRAP_CA}" = "yes" ]; then
  mkdir -p "${BASE_DIR}/step-ca/secrets"
  chmod 700 "${BASE_DIR}/step-ca/secrets"
  printf "%s\n" "${STEP_CA_PASSWORD}" > "${BASE_DIR}/step-ca/secrets/password"
  chmod 600 "${BASE_DIR}/step-ca/secrets/password"
ok "step-ca password saved to ${BASE_DIR}/step-ca/secrets/password"
fi

title "=== Port Check ==="
iptables_blocked=0
for p in "${ACME_HTTP_PORT}" "${ADMIN_HTTPS_PORT}" "${MQTT_TLS_PORT}" "${MQTT_WS_TLS_PORT}" "${STEP_CA_PORT}"; do
  printf "Port %s:\n" "${p}"
  port_state=2
  if port_in_use "${p}"; then
    port_state=0
  else
    port_state=$?
  fi

  case "${port_state}" in
    0) warn "  - local listener: IN USE (may conflict)" ;;
    1) ok "  - local listener: free" ;;
    *) warn "  - local listener: unable to verify (missing ss/lsof)" ;;
  esac

  check_firewall_port "${p}"

  iptables_state=2
  if check_iptables_input_port "${p}"; then
    iptables_state=0
  else
    iptables_state=$?
  fi

  case "${iptables_state}" in
    0) ok "  - iptables INPUT: port ${p} explicitly allowed" ;;
    1)
      warn "  - iptables INPUT: port ${p} may be rejected before it reaches the service"
      iptables_blocked=1
      ;;
    *) warn "  - iptables INPUT: no explicit allow detected" ;;
  esac
done

title "=== VPS Notice ==="
warn "- The stack requires inbound ${ACME_HTTP_PORT}/tcp, ${ADMIN_HTTPS_PORT}/tcp, ${MQTT_TLS_PORT}/tcp, and ${MQTT_WS_TLS_PORT}/tcp on the VPS."
warn "- step-ca requires ${STEP_CA_PORT}/tcp open only for authorized issuers (do not expose it to all sources)."
warn "- If your provider uses Security Groups/external firewall rules, open the same ports there too."
warn "- If any port above appears as 'may be blocked', fix firewall rules before continuing."
if [ "${iptables_blocked}" -eq 1 ]; then
  warn "- Local iptables appears to reject at least one required port."
  print_iptables_fix
  prompt_yes_no APPLY_IPTABLES_FIX "Apply these local iptables rules now?" "yes"
  if [ "${APPLY_IPTABLES_FIX}" = "yes" ]; then
    apply_iptables_fix
    prompt_yes_no SAVE_IPTABLES_FIX "Persist these iptables rules after reboot?" "no"
    if [ "${SAVE_IPTABLES_FIX}" = "yes" ]; then
      persist_iptables_rules
    fi
  fi
fi

prompt_yes_no SHOULD_CONTINUE "Continue anyway?" "yes"
if [ "${SHOULD_CONTINUE}" != "yes" ]; then
  warn "Execution interrupted by user."
  exit 0
fi

prompt_yes_no SHOULD_RUN_NOW "Start containers now?" "yes"

if [ "${SHOULD_RUN_NOW}" = "yes" ]; then
  cd "${SCRIPT_DIR}"

  if [ "${SHOULD_BOOTSTRAP_CA}" = "yes" ]; then
    bootstrap_step_ca
    export_step_ca_client_ca
    set_env_value "STEP_CA_FINGERPRINT" "${STEP_CA_FINGERPRINT}"
    fix_step_ca_permissions
    ok "STEP_CA_FINGERPRINT saved to ${ENV_FILE}."
  else
    warn "Bootstrap skipped. Existing ${BASE_DIR}/pki/step-ca/ca.crt is required before starting the broker."
    fix_step_ca_permissions
  fi

  run_compose --env-file broker.env -f step-ca/compose.step-ca.yaml up -d

  if [ ! -f "${BASE_DIR}/pki/step-ca/ca.crt" ]; then
    warn "Broker was not started because ${BASE_DIR}/pki/step-ca/ca.crt does not exist yet."
    warn "Run the wizard again with bootstrap enabled, then start the broker:"
    echo "  ${CONTAINER_ENGINE} compose --env-file broker.env up -d --build"
    exit 0
  fi

  run_compose --env-file broker.env up -d --build
  ok "Stack started with ${CONTAINER_ENGINE}."
else
  warn "Setup completed without starting containers."
  warn "When you are ready to start:"
  echo "  ${CONTAINER_ENGINE} compose --env-file broker.env -f step-ca/compose.step-ca.yaml up -d"
  echo "  ${CONTAINER_ENGINE} compose --env-file broker.env up -d --build"
fi
