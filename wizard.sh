#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/broker.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "This wizard must be run as root. Use: sudo ./wizard.sh" >&2
  exit 1
fi

if ! command -v whiptail >/dev/null 2>&1; then
  echo "whiptail is required. Install it with: sudo apt install -y whiptail" >&2
  exit 1
fi

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

has_command() {
  command -v "$1" >/dev/null 2>&1
}

absolute_path() {
  path_value="$1"
  case "${path_value}" in
    /*) printf "%s\n" "${path_value}" ;;
    ./*) printf "%s/%s\n" "${SCRIPT_DIR}" "${path_value#./}" ;;
    *) printf "%s/%s\n" "${SCRIPT_DIR}" "${path_value}" ;;
  esac
}

env_value() {
  printf "%s" "$1" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/"
}

random_secret() {
  if has_command "openssl"; then
    openssl rand -hex 32
    return 0
  fi
  date +%s | sha256sum | awk '{print $1}'
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

compose_command_available() {
  engine="$1"
  if ! has_command "${engine}"; then
    return 1
  fi
  "${engine}" compose version >/dev/null 2>&1
}

preferred_container_engine() {
  if [ -n "${CONTAINER_ENGINE:-}" ] && compose_command_available "${CONTAINER_ENGINE}"; then
    printf "%s\n" "${CONTAINER_ENGINE}"
    return 0
  fi
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

derive_public_endpoints() {
  STEP_CA_DOMAIN="${MQTT_DOMAIN}"
  STEP_CA_URL="https://${MQTT_DOMAIN}:${STEP_CA_PORT}"
  ADMIN_RP_ID="${MQTT_DOMAIN}"
  ADMIN_ORIGIN="https://${MQTT_DOMAIN}"
}

defaults() {
  MQTT_DOMAIN="${MQTT_DOMAIN:-}"
  MQTT_USE_PUBLIC_IP="${MQTT_USE_PUBLIC_IP:-}"
  CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
  CERTBOT_ARGS="${CERTBOT_ARGS:-}"
  CONTAINER_ENGINE="${CONTAINER_ENGINE:-}"
  CONTAINER_NAME="${CONTAINER_NAME:-mqtt-trust-gateway}"
  IMAGE_NAME="${IMAGE_NAME:-mqtt-trust-gateway}"
  ACME_HTTP_PORT="${ACME_HTTP_PORT:-80}"
  MQTT_TLS_PORT="${MQTT_TLS_PORT:-8883}"
  MQTT_WS_TLS_PORT="${MQTT_WS_TLS_PORT:-8443}"
  ADMIN_HTTPS_PORT="${ADMIN_HTTPS_PORT:-443}"
  ADMIN_APP_PORT="${ADMIN_APP_PORT:-8080}"
  BASE_DIR="${BASE_DIR:-./runtime}"
  MQTT_TOPIC_PREFIX="${MQTT_TOPIC_PREFIX:-devices}"
  STEP_CA_PORT="${STEP_CA_PORT:-9000}"
  STEP_CA_PROVISIONER="${STEP_CA_PROVISIONER:-mqtt-devices}"
  STEP_CA_FINGERPRINT="${STEP_CA_FINGERPRINT:-}"
  STEP_CA_DEVICE_CERT_TTL="${STEP_CA_DEVICE_CERT_TTL:-17520h}"
  ADMIN_RP_NAME="${ADMIN_RP_NAME:-MQTT Trust Gateway}"
  ADMIN_SETUP_TOKEN="${ADMIN_SETUP_TOKEN:-$(random_secret)}"
  ADMIN_SESSION_SECRET="${ADMIN_SESSION_SECRET:-$(random_secret)}"
}

wt_msg() {
  whiptail --title "MQTT Trust Gateway" --msgbox "$1" 18 78
}

wt_yesno() {
  whiptail --title "MQTT Trust Gateway" --yesno "$1" 14 78
}

wt_input() {
  title="$1"
  text="$2"
  value="$3"
  whiptail --title "${title}" --inputbox "${text}" 12 78 "${value}" 3>&1 1>&2 2>&3
}

wt_password() {
  title="$1"
  text="$2"
  whiptail --title "${title}" --passwordbox "${text}" 12 78 3>&1 1>&2 2>&3
}

wt_menu() {
  title="$1"
  text="$2"
  shift 2
  whiptail --title "${title}" --menu "${text}" 18 78 8 "$@" 3>&1 1>&2 2>&3
}

run_compose() {
  env \
    MQTT_DOMAIN="${MQTT_DOMAIN}" \
    MQTT_USE_PUBLIC_IP="${MQTT_USE_PUBLIC_IP}" \
    CERTBOT_EMAIL="${CERTBOT_EMAIL}" \
    CERTBOT_ARGS="${CERTBOT_ARGS}" \
    CONTAINER_ENGINE="${CONTAINER_ENGINE}" \
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
    "${CONTAINER_ENGINE}" compose "$@"
}

write_env() {
  cat > "${ENV_FILE}" <<EOF
# Domain
MQTT_DOMAIN=$(env_value "${MQTT_DOMAIN}")
MQTT_USE_PUBLIC_IP=$(env_value "${MQTT_USE_PUBLIC_IP}")

# Certbot
CERTBOT_EMAIL=$(env_value "${CERTBOT_EMAIL}")
CERTBOT_ARGS=$(env_value "${CERTBOT_ARGS}")

# Container
CONTAINER_ENGINE=$(env_value "${CONTAINER_ENGINE}")
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
    raise SystemExit(f"Provisioner {provisioner_name!r} not found")

with open(config_file, "w", encoding="utf-8") as fh:
    json.dump(config, fh, indent="\t")
    fh.write("\n")
PY
}

fix_step_ca_permissions() {
  if [ -d "${BASE_DIR}/step-ca" ]; then
    chown -R 1000:1000 "${BASE_DIR}/step-ca"
    chmod 700 "${BASE_DIR}/step-ca/secrets"
    [ ! -f "${BASE_DIR}/step-ca/secrets/password" ] || chmod 600 "${BASE_DIR}/step-ca/secrets/password"
  fi
}

bootstrap_step_ca() {
  password="$1"
  step_ca_dir="${BASE_DIR}/step-ca"
  config_file="${step_ca_dir}/config/ca.json"
  password_file="${step_ca_dir}/secrets/password"

  mkdir -p "${step_ca_dir}/certs" "${step_ca_dir}/config" "${step_ca_dir}/db" "${step_ca_dir}/secrets"
  chmod 700 "${step_ca_dir}/secrets"
  printf "%s\n" "${password}" > "${password_file}"
  chmod 600 "${password_file}"

  if [ ! -f "${config_file}" ]; then
    STEPPATH="${step_ca_dir}" step ca init \
      --name "MQTT Trust Gateway Device CA" \
      --dns "${STEP_CA_DOMAIN}" \
      --address ":${STEP_CA_PORT}" \
      --provisioner "${STEP_CA_PROVISIONER}" \
      --password-file "${password_file}" \
      --provisioner-password-file "${password_file}" \
      --deployment-type standalone \
      --with-ca-url "${STEP_CA_URL}"
  fi

  normalize_step_ca_container_paths
  configure_step_ca_provisioner_claims
  STEP_CA_FINGERPRINT="$(step certificate fingerprint "${step_ca_dir}/certs/root_ca.crt")"
  mkdir -p "${BASE_DIR}/pki/step-ca"
  cp "${step_ca_dir}/certs/root_ca.crt" "${BASE_DIR}/pki/step-ca/ca.crt"
  chmod 644 "${BASE_DIR}/pki/step-ca/ca.crt"
  fix_step_ca_permissions
}

choose_engine() {
  default_engine="$(preferred_container_engine)"
  if [ "${default_engine}" = "docker" ]; then
    selected="$(wt_menu "Container Engine" "Choose the container engine." \
      "docker" "Docker Compose" \
      "podman" "Podman Compose")" || return 1
  else
    selected="$(wt_menu "Container Engine" "Choose the container engine." \
      "podman" "Podman Compose" \
      "docker" "Docker Compose")" || return 1
  fi
  CONTAINER_ENGINE="${selected:-${default_engine}}"
}

configure_basic() {
  PUBLIC_IP="$(detect_public_ip || true)"
  domain_help="Leave empty to use the detected public IP directly."
  if [ -n "${PUBLIC_IP}" ]; then
    domain_help="${domain_help}\nDetected public IP: ${PUBLIC_IP}"
  fi

  MQTT_DOMAIN="$(wt_input "Domain" "${domain_help}" "${MQTT_DOMAIN}")" || return 1
  if [ -z "${MQTT_DOMAIN}" ]; then
    MQTT_USE_PUBLIC_IP="yes"
    MQTT_DOMAIN="${PUBLIC_IP}"
    if [ -z "${MQTT_DOMAIN}" ]; then
      MQTT_DOMAIN="$(wt_input "Public IP" "Public IP could not be detected. Enter it manually." "")" || return 1
    fi
    case " ${CERTBOT_ARGS:-} " in
      *" --preferred-profile "*) ;;
      *) CERTBOT_ARGS="${CERTBOT_ARGS:+${CERTBOT_ARGS} }--preferred-profile shortlived" ;;
    esac
  else
    MQTT_USE_PUBLIC_IP="no"
  fi

  CERTBOT_EMAIL="$(wt_input "Let's Encrypt" "Contact email for Let's Encrypt. Leave empty to skip email registration." "${CERTBOT_EMAIL}")" || return 1
  BASE_DIR="$(wt_input "Runtime Directory" "Host directory for runtime data." "${BASE_DIR:-./runtime}")" || return 1
  BASE_DIR="$(absolute_path "${BASE_DIR}")"
  choose_engine || return 1

  CONTAINER_NAME="${CONTAINER_NAME:-mqtt-trust-gateway}"
  IMAGE_NAME="${IMAGE_NAME:-mqtt-trust-gateway}"
  ACME_HTTP_PORT="${ACME_HTTP_PORT:-80}"
  MQTT_TLS_PORT="${MQTT_TLS_PORT:-8883}"
  MQTT_WS_TLS_PORT="${MQTT_WS_TLS_PORT:-8443}"
  ADMIN_HTTPS_PORT="${ADMIN_HTTPS_PORT:-443}"
  ADMIN_APP_PORT="${ADMIN_APP_PORT:-8080}"
  MQTT_TOPIC_PREFIX="${MQTT_TOPIC_PREFIX:-devices}"
  STEP_CA_PORT="${STEP_CA_PORT:-9000}"
  STEP_CA_PROVISIONER="${STEP_CA_PROVISIONER:-mqtt-devices}"
  STEP_CA_DEVICE_CERT_TTL="${STEP_CA_DEVICE_CERT_TTL:-17520h}"
  ADMIN_RP_NAME="${ADMIN_RP_NAME:-MQTT Trust Gateway}"
  derive_public_endpoints
}

configure_advanced() {
  if ! wt_yesno "Edit advanced settings?"; then
    return 0
  fi

  CERTBOT_ARGS="$(wt_input "Advanced" "Extra Certbot arguments." "${CERTBOT_ARGS}")" || return 1
  CONTAINER_NAME="$(wt_input "Advanced" "Container name prefix." "${CONTAINER_NAME}")" || return 1
  IMAGE_NAME="$(wt_input "Advanced" "Image name prefix." "${IMAGE_NAME}")" || return 1
  ACME_HTTP_PORT="$(wt_input "Advanced" "ACME HTTP port." "${ACME_HTTP_PORT}")" || return 1
  MQTT_TLS_PORT="$(wt_input "Advanced" "MQTT TLS port." "${MQTT_TLS_PORT}")" || return 1
  MQTT_WS_TLS_PORT="$(wt_input "Advanced" "MQTT WSS port." "${MQTT_WS_TLS_PORT}")" || return 1
  ADMIN_HTTPS_PORT="$(wt_input "Advanced" "Admin HTTPS port." "${ADMIN_HTTPS_PORT}")" || return 1
  ADMIN_APP_PORT="$(wt_input "Advanced" "Internal Admin Web port." "${ADMIN_APP_PORT}")" || return 1
  MQTT_TOPIC_PREFIX="$(wt_input "Advanced" "MQTT topic prefix." "${MQTT_TOPIC_PREFIX}")" || return 1
  ADMIN_RP_NAME="$(wt_input "Advanced" "Admin passkey display name." "${ADMIN_RP_NAME}")" || return 1
  STEP_CA_PORT="$(wt_input "Advanced" "step-ca external port." "${STEP_CA_PORT}")" || return 1
  STEP_CA_PROVISIONER="$(wt_input "Advanced" "step-ca provisioner name." "${STEP_CA_PROVISIONER}")" || return 1
  STEP_CA_DEVICE_CERT_TTL="$(wt_input "Advanced" "Device certificate TTL." "${STEP_CA_DEVICE_CERT_TTL}")" || return 1
  derive_public_endpoints
}

run_install() {
  defaults
  configure_basic || return 0
  configure_advanced || return 0
  derive_public_endpoints
  write_env

  summary="Admin Web: ${ADMIN_ORIGIN}\nMQTT TLS: ${MQTT_DOMAIN}:${MQTT_TLS_PORT}\nMQTT WSS: ${MQTT_DOMAIN}:${MQTT_WS_TLS_PORT}\nstep-ca: ${STEP_CA_URL}\nRuntime: ${BASE_DIR}\nEngine: ${CONTAINER_ENGINE}"
  wt_msg "${summary}"

  if ! compose_command_available "${CONTAINER_ENGINE}"; then
    wt_msg "${CONTAINER_ENGINE} compose is not available."
    return 1
  fi

  if wt_yesno "Initialize or update step-ca now?"; then
    password="$(wt_password "step-ca Password" "Password for ${BASE_DIR}/step-ca/secrets/password.")" || return 0
    bootstrap_step_ca "${password}"
    write_env
  fi

  if wt_yesno "Start containers now?"; then
    cd "${SCRIPT_DIR}"
    run_compose --env-file broker.env -f step-ca/compose.step-ca.yaml up -d
    if [ ! -f "${BASE_DIR}/pki/step-ca/ca.crt" ]; then
      wt_msg "step-ca was started, but the MQTT client CA was not found at:\n\n${BASE_DIR}/pki/step-ca/ca.crt\n\nRun install again and initialize step-ca before starting the broker."
      return 0
    fi
    run_compose --env-file broker.env up -d --build
    wt_msg "Stack started.\n\nUse setup token:\n${ADMIN_SETUP_TOKEN}"
  else
    wt_msg "Configuration saved to broker.env."
  fi
}

remove_named_containers() {
  for container in \
    "${CONTAINER_NAME}-certbot-init" \
    "${CONTAINER_NAME}-certbot-renew" \
    "${CONTAINER_NAME}" \
    "${CONTAINER_NAME}-admin-web" \
    "${CONTAINER_NAME}-admin-nginx" \
    "${CONTAINER_NAME}-step-ca"
  do
    if "${CONTAINER_ENGINE}" container inspect "${container}" >/dev/null 2>&1; then
      "${CONTAINER_ENGINE}" rm -f "${container}" >/dev/null 2>&1 || true
    fi
  done
}

remove_images() {
  for image in "${IMAGE_NAME}" "${IMAGE_NAME}-admin-web" "${IMAGE_NAME}-admin-nginx" "${IMAGE_NAME}-certbot"; do
    if "${CONTAINER_ENGINE}" image inspect "${image}" >/dev/null 2>&1; then
      "${CONTAINER_ENGINE}" image rm "${image}" >/dev/null 2>&1 || true
    fi
  done
}

remove_iptables_accept_rule() {
  port="$1"
  if ! has_command "iptables"; then
    return 0
  fi
  while iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1; do
    iptables -D INPUT -p tcp --dport "${port}" -j ACCEPT
  done
}

run_uninstall() {
  defaults
  BASE_DIR="$(absolute_path "${BASE_DIR}")"
  CONTAINER_ENGINE="${CONTAINER_ENGINE:-$(preferred_container_engine)}"
  derive_public_endpoints

  choose_engine || return 0
  if ! compose_command_available "${CONTAINER_ENGINE}"; then
    wt_msg "${CONTAINER_ENGINE} compose is not available."
    return 1
  fi

  if ! wt_yesno "Stop and remove MQTT Trust Gateway containers?\n\nRepository files will not be deleted."; then
    return 0
  fi

  cd "${SCRIPT_DIR}"
  run_compose --env-file broker.env down --remove-orphans || true
  run_compose --env-file broker.env -f step-ca/compose.step-ca.yaml down --remove-orphans || true
  remove_named_containers

  if wt_yesno "Remove locally built images?"; then
    remove_images
  fi

  if wt_yesno "Delete runtime data at ${BASE_DIR}?\n\nThis removes certificates, CA files, admin DB, and Mosquitto data."; then
    rm -rf "${BASE_DIR}"
  fi

  if wt_yesno "Remove local iptables ACCEPT rules for configured ports?"; then
    remove_iptables_accept_rule "${ACME_HTTP_PORT}"
    remove_iptables_accept_rule "${ADMIN_HTTPS_PORT}"
    remove_iptables_accept_rule "${MQTT_TLS_PORT}"
    remove_iptables_accept_rule "${MQTT_WS_TLS_PORT}"
    remove_iptables_accept_rule "${STEP_CA_PORT}"
  fi

  wt_msg "Uninstall actions finished.\n\nRepository files were kept."
}

main_menu() {
  case "${1:-}" in
    install|setup) run_install; return 0 ;;
    uninstall|remove) run_uninstall; return 0 ;;
  esac

  while :; do
    choice="$(wt_menu "MQTT Trust Gateway" "Choose an action." \
      "install" "Install or update the stack" \
      "uninstall" "Stop and clean the stack" \
      "exit" "Exit")" || exit 0
    case "${choice}" in
      install) run_install ;;
      uninstall) run_uninstall ;;
      exit) exit 0 ;;
    esac
  done
}

main_menu "${1:-}"
