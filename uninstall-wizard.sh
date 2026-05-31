#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/broker.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "This wizard must be run as root. Use: sudo ./uninstall-wizard.sh" >&2
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
}

ok() {
  printf "%s%s%s\n" "${C_GREEN}" "$1" "${C_RESET}"
}

warn() {
  printf "%s%s%s\n" "${C_YELLOW}" "$1" "${C_RESET}"
}

err() {
  printf "%s%s%s\n" "${C_RED}" "$1" "${C_RESET}"
}

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

read_line() {
  prompt_text="$1"
  input_value=""
  if [ -t 0 ]; then
    read -r -e -p "${prompt_text}" input_value || true
  else
    printf "%s" "${prompt_text}"
    read -r input_value || true
  fi
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
    answer="${input_value}"
    if [ -z "${answer}" ]; then
      case "${default_value}" in
        yes) answer="y" ;;
        no) answer="n" ;;
      esac
    fi

    case "${answer}" in
      y|Y) printf -v "${var_name}" "%s" "yes"; return 0 ;;
      n|N) printf -v "${var_name}" "%s" "no"; return 0 ;;
      *) warn "Please answer y or n." ;;
    esac
  done
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

prompt_container_engine() {
  default_engine="$1"
  while :; do
    prompt_value="$(printf "%s? %sContainer engine (docker/podman)%s [%s%s%s]: " "${C_BOLD}${C_CYAN}" "${C_RESET}" "${C_RESET}" "${C_YELLOW}" "${default_engine}" "${C_RESET}")"
    read_line "${prompt_value}"
    if [ -z "${input_value}" ]; then
      CONTAINER_ENGINE="${default_engine}"
    else
      CONTAINER_ENGINE="${input_value}"
    fi

    case "${CONTAINER_ENGINE}" in
      docker|podman) return 0 ;;
      *) warn "Choose docker or podman." ;;
    esac
  done
}

run_compose() {
  env \
    MQTT_DOMAIN="${MQTT_DOMAIN}" \
    MQTT_USE_PUBLIC_IP="${MQTT_USE_PUBLIC_IP}" \
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
    "${CONTAINER_ENGINE}" compose "$@"
}

remove_iptables_accept_rule() {
  port="$1"
  if ! has_command "iptables"; then
    warn "iptables not found; skipping port ${port}."
    return 0
  fi

  removed=0
  while iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT >/dev/null 2>&1; do
    iptables -D INPUT -p tcp --dport "${port}" -j ACCEPT
    removed=1
  done

  if [ "${removed}" -eq 1 ]; then
    ok "Removed iptables ACCEPT rule for ${port}/tcp."
  else
    warn "No matching iptables ACCEPT rule found for ${port}/tcp."
  fi
}

remove_images() {
  for image in \
    "${IMAGE_NAME}" \
    "${IMAGE_NAME}-admin-web" \
    "${IMAGE_NAME}-admin-nginx" \
    "${IMAGE_NAME}-certbot"
  do
    if "${CONTAINER_ENGINE}" image inspect "${image}" >/dev/null 2>&1; then
      "${CONTAINER_ENGINE}" image rm "${image}" >/dev/null 2>&1 || warn "Could not remove image ${image}."
    fi
  done
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
      "${CONTAINER_ENGINE}" rm -f "${container}" >/dev/null 2>&1 || warn "Could not remove container ${container}."
    fi
  done
}

MQTT_DOMAIN="${MQTT_DOMAIN:-mqtt.example.com}"
MQTT_USE_PUBLIC_IP="${MQTT_USE_PUBLIC_IP:-no}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@example.com}"
CERTBOT_ARGS="${CERTBOT_ARGS:-}"
CONTAINER_NAME="${CONTAINER_NAME:-mqtt-trust-gateway}"
IMAGE_NAME="${IMAGE_NAME:-mqtt-trust-gateway}"
ACME_HTTP_PORT="${ACME_HTTP_PORT:-80}"
MQTT_TLS_PORT="${MQTT_TLS_PORT:-8883}"
MQTT_WS_TLS_PORT="${MQTT_WS_TLS_PORT:-8443}"
ADMIN_HTTPS_PORT="${ADMIN_HTTPS_PORT:-443}"
ADMIN_APP_PORT="${ADMIN_APP_PORT:-8080}"
BASE_DIR="$(absolute_path "${BASE_DIR:-./runtime}")"
MQTT_TOPIC_PREFIX="${MQTT_TOPIC_PREFIX:-devices}"
STEP_CA_DOMAIN="${STEP_CA_DOMAIN:-${MQTT_DOMAIN}}"
STEP_CA_PORT="${STEP_CA_PORT:-9000}"
STEP_CA_URL="${STEP_CA_URL:-https://${STEP_CA_DOMAIN}:${STEP_CA_PORT}}"
STEP_CA_PROVISIONER="${STEP_CA_PROVISIONER:-mqtt-devices}"
STEP_CA_FINGERPRINT="${STEP_CA_FINGERPRINT:-}"
STEP_CA_DEVICE_CERT_TTL="${STEP_CA_DEVICE_CERT_TTL:-17520h}"
ADMIN_RP_NAME="${ADMIN_RP_NAME:-MQTT Trust Gateway}"
ADMIN_RP_ID="${ADMIN_RP_ID:-${MQTT_DOMAIN}}"
ADMIN_ORIGIN="${ADMIN_ORIGIN:-https://${MQTT_DOMAIN}}"
ADMIN_SETUP_TOKEN="${ADMIN_SETUP_TOKEN:-}"
ADMIN_SESSION_SECRET="${ADMIN_SESSION_SECRET:-}"

title "=== MQTT Trust Gateway Uninstall Wizard ==="
warn "This removes the running stack. Runtime data removal is optional and asked separately."

DEFAULT_CONTAINER_ENGINE="$(preferred_container_engine)"
prompt_container_engine "${DEFAULT_CONTAINER_ENGINE}"
if ! compose_command_available "${CONTAINER_ENGINE}"; then
  err "${CONTAINER_ENGINE} compose is not available."
  exit 1
fi

printf "\nCurrent target:\n"
printf "  Domain/IP: %s\n" "${MQTT_DOMAIN}"
printf "  Container prefix: %s\n" "${CONTAINER_NAME}"
printf "  Runtime directory: %s\n" "${BASE_DIR}"
printf "  Admin Web: %s\n" "${ADMIN_ORIGIN}"
printf "  step-ca: %s\n" "${STEP_CA_URL}"
printf "\n"

prompt_yes_no CONFIRM_STOP "Stop and remove MQTT Trust Gateway containers?" "yes"
if [ "${CONFIRM_STOP}" != "yes" ]; then
  warn "Uninstall cancelled."
  exit 0
fi

cd "${SCRIPT_DIR}"

ok "Stopping main stack..."
run_compose --env-file broker.env down --remove-orphans || warn "Main stack compose down reported a problem."

ok "Stopping step-ca stack..."
run_compose --env-file broker.env -f step-ca/compose.step-ca.yaml down --remove-orphans || warn "step-ca compose down reported a problem."

ok "Removing named containers if any remain..."
remove_named_containers

prompt_yes_no REMOVE_IMAGES "Remove locally built container images?" "no"
if [ "${REMOVE_IMAGES}" = "yes" ]; then
  remove_images
  ok "Image cleanup finished."
fi

prompt_yes_no REMOVE_RUNTIME "Delete runtime data, certificates, CA, admin DB, and Mosquitto data at ${BASE_DIR}?" "no"
if [ "${REMOVE_RUNTIME}" = "yes" ]; then
  if [ -d "${BASE_DIR}" ]; then
    rm -rf "${BASE_DIR}"
    ok "Removed ${BASE_DIR}."
  else
    warn "Runtime directory does not exist: ${BASE_DIR}"
  fi
else
  warn "Kept runtime data at ${BASE_DIR}."
fi

prompt_yes_no REMOVE_IPTABLES "Remove local iptables ACCEPT rules added by the setup wizard?" "no"
if [ "${REMOVE_IPTABLES}" = "yes" ]; then
  remove_iptables_accept_rule "${ACME_HTTP_PORT}"
  remove_iptables_accept_rule "${ADMIN_HTTPS_PORT}"
  remove_iptables_accept_rule "${MQTT_TLS_PORT}"
  remove_iptables_accept_rule "${MQTT_WS_TLS_PORT}"
  remove_iptables_accept_rule "${STEP_CA_PORT}"
fi

prompt_yes_no REMOVE_ENV "Delete broker.env from this repository?" "no"
if [ "${REMOVE_ENV}" = "yes" ]; then
  if [ -f "${ENV_FILE}" ]; then
    rm -f "${ENV_FILE}"
    ok "Removed ${ENV_FILE}."
  else
    warn "broker.env already missing."
  fi
else
  warn "Kept ${ENV_FILE}."
fi

ok "Uninstall wizard finished."
