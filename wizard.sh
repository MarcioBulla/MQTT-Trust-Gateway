#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/broker.env"
WT_BACKTITLE="MQTT Trust Gateway Wizard"
WIZARD_PREVIEW="no"
export NEWT_COLORS="${NEWT_COLORS:-root=white,blue;window=white,blue;border=brightwhite,blue;title=brightwhite,blue;button=black,cyan;actbutton=white,red;checkbox=black,cyan;actcheckbox=white,red;entry=black,white;label=brightwhite,blue;listbox=black,white;actlistbox=white,red;textbox=black,white;emptyscale=white,blue;fullscale=white,red}"

REQUESTED_MODE="${1:-}"

has_command() {
  command -v "$1" >/dev/null 2>&1
}

detect_package_manager() {
  if has_command "apt-get"; then
    printf "apt\n"
  elif has_command "pacman"; then
    printf "pacman\n"
  elif has_command "dnf"; then
    printf "dnf\n"
  elif has_command "yum"; then
    printf "yum\n"
  elif has_command "apk"; then
    printf "apk\n"
  elif has_command "zypper"; then
    printf "zypper\n"
  else
    printf "unknown\n"
  fi
}

base_dependency_install_command() {
  case "$(detect_package_manager)" in
    apt)
      printf "sudo apt update\nsudo apt install -y whiptail bash ca-certificates curl gnupg openssl python3 dnsutils iproute2 lsof ufw iptables\n"
      ;;
    pacman)
      printf "sudo pacman -Syu --needed libnewt bash ca-certificates curl gnupg openssl python dnsutils iproute2 lsof ufw iptables\n"
      ;;
    dnf)
      printf "sudo dnf install -y newt bash ca-certificates curl gnupg2 openssl python3 bind-utils iproute lsof ufw iptables\n"
      ;;
    yum)
      printf "sudo yum install -y newt bash ca-certificates curl gnupg2 openssl python3 bind-utils iproute lsof ufw iptables\n"
      ;;
    apk)
      printf "sudo apk add newt bash ca-certificates curl gnupg openssl python3 bind-tools iproute2 lsof ufw iptables\n"
      ;;
    zypper)
      printf "sudo zypper install -y newt bash ca-certificates curl gpg2 openssl python3 bind-utils iproute2 lsof ufw iptables\n"
      ;;
    *)
      printf "Install whiptail, bash, ca-certificates, curl, gnupg, openssl, python3, dig, ip/ss, lsof, ufw, and iptables with your distribution package manager.\n"
      ;;
  esac
}

if [ "$(id -u)" -ne 0 ] && [ "${REQUESTED_MODE}" != "preview" ] && [ "${REQUESTED_MODE}" != "dry-run" ]; then
  echo "This wizard must be run as root. Use: sudo ./wizard.sh" >&2
  echo "Preview mode can be opened without root: ./wizard.sh preview" >&2
  exit 1
fi

if ! command -v whiptail >/dev/null 2>&1; then
  echo "whiptail is required. Install the base dependencies with:" >&2
  base_dependency_install_command >&2
  exit 1
fi

load_env_file() {
  [ -f "${ENV_FILE}" ] || return 0

  while IFS= read -r line || [ -n "${line}" ]; do
    case "${line}" in
      ''|\#*) continue ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"
    key="${key%%[[:space:]]*}"

    case "${value}" in
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
    esac

    case "${key}" in
      ''|*[!A-Za-z0-9_]*)
        continue
        ;;
    esac

    printf -v "${key}" "%s" "${value}"
  done < "${ENV_FILE}"
}

load_env_file

absolute_path() {
  path_value="$1"
  case "${path_value}" in
    /*) printf "%s\n" "${path_value}" ;;
    ./*) printf "%s/%s\n" "${SCRIPT_DIR}" "${path_value#./}" ;;
    *) printf "%s/%s\n" "${SCRIPT_DIR}" "${path_value}" ;;
  esac
}

normalize_admin_name() {
  printf "%s" "$1" | sed 's/[[:space:]]\+/_/g'
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
  if has_command "timeout"; then
    timeout 3 "${engine}" compose version >/dev/null 2>&1
  else
    "${engine}" compose version >/dev/null 2>&1
  fi
}

dependency_status() {
  if "$@"; then
    printf "[x]\n"
  else
    printf "[ ]\n"
  fi
}

has_ca_certificates() {
  [ -f /etc/ssl/certs/ca-certificates.crt ] || [ -d /etc/ssl/certs ]
}

has_iproute2() {
  has_command "ip" && has_command "ss"
}

domain_has_dns_record() {
  domain="$1"

  if has_command "dig"; then
    [ -n "$(dig +short A "${domain}" 2>/dev/null | head -n 1)" ] && return 0
    [ -n "$(dig +short AAAA "${domain}" 2>/dev/null | head -n 1)" ] && return 0
    return 1
  fi

  if has_command "getent"; then
    getent ahosts "${domain}" >/dev/null 2>&1
    return "$?"
  fi

  return 0
}

domain_resolved_ips() {
  domain="$1"

  if has_command "dig"; then
    {
      dig +short A "${domain}" 2>/dev/null
      dig +short AAAA "${domain}" 2>/dev/null
    } | sed '/^$/d' | sort -u
    return 0
  fi

  if has_command "getent"; then
    getent ahosts "${domain}" 2>/dev/null | awk '{print $1}' | sed '/^$/d' | sort -u
    return 0
  fi

  return 1
}

domain_matches_public_ip() {
  domain="$1"
  public_ip="$2"

  [ -n "${public_ip}" ] || return 2
  domain_resolved_ips "${domain}" | grep -Fxq "${public_ip}"
}

valid_email_or_empty() {
  email="$1"

  [ -z "${email}" ] && return 0
  case "${email}" in
    *@*.*) return 0 ;;
    *) return 1 ;;
  esac
}

show_dependency_checklist() {
  podman_status="$(dependency_status compose_command_available podman)"
  docker_status="$(dependency_status compose_command_available docker)"
  package_manager="$(detect_package_manager)"
  install_command="$(base_dependency_install_command)"

  wt_textbox_text "Dependency check" "$(printf "%s\n" \
    "Installed items are marked with [x]. Missing items are marked with [ ]." \
    "Detected package manager: ${package_manager}" \
    "" \
    "$(dependency_status has_command whiptail) whiptail          interactive wizard UI" \
    "$(dependency_status has_command bash) bash              wizard shell" \
    "$(dependency_status has_ca_certificates) ca-certificates   trusted CA bundle" \
    "$(dependency_status has_command curl) curl              public IP detection and downloads" \
    "$(dependency_status has_command gpg) gnupg             package repository keys" \
    "$(dependency_status has_command openssl) openssl           random secrets" \
    "$(dependency_status has_command python3) python3           step-ca JSON configuration" \
    "$(dependency_status has_command dig) dnsutils          dig DNS checks" \
    "$(dependency_status has_iproute2) iproute2          ip and ss network tools" \
    "$(dependency_status has_command lsof) lsof              port diagnostics" \
    "$(dependency_status has_command ufw) ufw               firewall management" \
    "$(dependency_status has_command iptables) iptables          firewall rules" \
    "$(dependency_status has_command step) step-cli          Smallstep CLI" \
    "${podman_status} podman-compose    Podman with compose support" \
    "${docker_status} docker-compose    Docker with compose support" \
    "" \
    "Base dependency install command:" \
    "${install_command}")"
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

available_container_engines() {
  if compose_command_available "podman"; then
    printf "podman\n"
  fi
  if compose_command_available "docker"; then
    printf "docker\n"
  fi
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
  ADMIN_RP_NAME="${ADMIN_RP_NAME:-MQTT_Trust_Gateway}"
  ADMIN_SETUP_TOKEN="${ADMIN_SETUP_TOKEN:-$(random_secret)}"
  ADMIN_SESSION_SECRET="${ADMIN_SESSION_SECRET:-$(random_secret)}"
}

wt_msg() {
  whiptail --backtitle "${WT_BACKTITLE}" --title "MQTT Trust Gateway" --msgbox "$1" 18 78
}

wt_textbox_text() {
  title="$1"
  text="$2"
  text_file="$(mktemp)"
  printf "%s\n" "${text}" > "${text_file}"
  whiptail --backtitle "${WT_BACKTITLE}" --title "${title}" --textbox "${text_file}" 22 90
  rm -f "${text_file}"
}

wt_yesno() {
  wt_yesno_default "$1" "yes"
}

wt_yesno_default() {
  text="$1"
  default="${2:-yes}"
  if [ "${default}" = "no" ]; then
    whiptail --backtitle "${WT_BACKTITLE}" --title "MQTT Trust Gateway" --defaultno --yesno "${text}" 14 78
  else
    whiptail --backtitle "${WT_BACKTITLE}" --title "MQTT Trust Gateway" --yesno "${text}" 14 78
  fi
}

wt_input() {
  title="$1"
  text="$2"
  value="$3"
  whiptail --backtitle "${WT_BACKTITLE}" --title "${title}" --inputbox "${text}" 12 78 "${value}" 3>&1 1>&2 2>&3
}

wt_password() {
  title="$1"
  text="$2"
  whiptail --backtitle "${WT_BACKTITLE}" --title "${title}" --passwordbox "${text}" 12 78 3>&1 1>&2 2>&3
}

wt_confirmed_password() {
  title="$1"
  text="$2"
  CONFIRMED_PASSWORD=""

  while :; do
    password="$(wt_password "${title}" "Step 1 of 2\n\n${text}")" || return 1
    confirm_password="$(wt_password "${title}" "Step 2 of 2\n\nRepeat the same password to confirm it.")" || return 1

    if [ "${password}" = "${confirm_password}" ]; then
      CONFIRMED_PASSWORD="${password}"
      return 0
    fi

    wt_msg "The two passwords did not match.\n\nNo password was saved. Try again."
  done
}

wt_menu() {
  title="$1"
  text="$2"
  default="$3"
  shift 3
  whiptail --backtitle "${WT_BACKTITLE}" --title "${title}" --default-item "${default}" --menu "${text}" 18 78 8 "$@" 3>&1 1>&2 2>&3
}

wt_menu_nocancel() {
  title="$1"
  text="$2"
  default="$3"
  shift 3
  whiptail --backtitle "${WT_BACKTITLE}" --title "${title}" --nocancel --default-item "${default}" --menu "${text}" 18 78 8 "$@" 3>&1 1>&2 2>&3
}

strip_ansi_log() {
  source_file="$1"
  target_file="$2"
  esc="$(printf '\033')"
  sed "s/${esc}\\[[0-9;?]*[ -/]*[@-~]//g; s/${esc}][^\a]*\a//g; s/\r//g" "${source_file}" > "${target_file}"
}

wt_progress_command() {
  title="$1"
  shift
  log_file="$(mktemp)"
  clean_log_file="$(mktemp)"
  status_file="$(mktemp)"

  (
    set +e
    printf "Running: %s\n" "${title}"
    printf "\n\n"
    NO_COLOR=1 CLICOLOR=0 FORCE_COLOR=0 TERM=dumb "$@"
    command_status="$?"
    printf "\nExit code: %s\n" "${command_status}"
    printf "%s" "${command_status}" > "${status_file}"
  ) >"${log_file}" 2>&1 &
  command_pid="$!"

  (
    progress=0
    while kill -0 "${command_pid}" >/dev/null 2>&1; do
      cat <<EOF
XXX
${progress}
${title}

The command is running. Output is being captured and will open inside this wizard.
XXX
EOF
      if [ "${progress}" -lt 99 ]; then
        progress=$((progress + 1))
        if [ "${progress}" -gt 99 ]; then
          progress=99
        fi
      fi
      sleep 1
    done
    cat <<EOF
XXX
100
${title}

Command finished. Opening the captured output.
XXX
EOF
  ) | whiptail --backtitle "${WT_BACKTITLE}" --title "${title}" --gauge "Starting..." 10 78 0 || true

  set +e
  wait "${command_pid}"
  wait_status="$?"
  set -e

  if [ -s "${status_file}" ]; then
    status="$(cat "${status_file}")"
  else
    status="${wait_status}"
  fi

  if [ "${status}" != "0" ]; then
    strip_ansi_log "${log_file}" "${clean_log_file}"
    whiptail --backtitle "${WT_BACKTITLE}" --title "${title} output" --textbox "${clean_log_file}" 22 90
  fi
  rm -f "${log_file}" "${clean_log_file}" "${status_file}"
  return "${status}"
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
  if [ "${WIZARD_PREVIEW}" = "yes" ]; then
    return 0
  fi

  cat > "${ENV_FILE}" <<EOF
# Domain
MQTT_DOMAIN=${MQTT_DOMAIN}
MQTT_USE_PUBLIC_IP=${MQTT_USE_PUBLIC_IP}

# Certbot
CERTBOT_EMAIL=${CERTBOT_EMAIL}
CERTBOT_ARGS=${CERTBOT_ARGS}

# Container
CONTAINER_ENGINE=${CONTAINER_ENGINE}
CONTAINER_NAME=${CONTAINER_NAME}
IMAGE_NAME=${IMAGE_NAME}

# Ports
ACME_HTTP_PORT=${ACME_HTTP_PORT}
MQTT_TLS_PORT=${MQTT_TLS_PORT}
MQTT_WS_TLS_PORT=${MQTT_WS_TLS_PORT}
ADMIN_HTTPS_PORT=${ADMIN_HTTPS_PORT}
ADMIN_APP_PORT=${ADMIN_APP_PORT}

# Paths on host
BASE_DIR=${BASE_DIR}

# Client certificate authentication (step-ca)
MQTT_TOPIC_PREFIX=${MQTT_TOPIC_PREFIX}

# step-ca
STEP_CA_DOMAIN=${STEP_CA_DOMAIN}
STEP_CA_PORT=${STEP_CA_PORT}
STEP_CA_URL=${STEP_CA_URL}
STEP_CA_PROVISIONER=${STEP_CA_PROVISIONER}
STEP_CA_FINGERPRINT=${STEP_CA_FINGERPRINT}
STEP_CA_DEVICE_CERT_TTL=${STEP_CA_DEVICE_CERT_TTL}

# Admin Web
ADMIN_RP_NAME=${ADMIN_RP_NAME}
ADMIN_RP_ID=${ADMIN_RP_ID}
ADMIN_ORIGIN=${ADMIN_ORIGIN}
ADMIN_SETUP_TOKEN=${ADMIN_SETUP_TOKEN}
ADMIN_SESSION_SECRET=${ADMIN_SESSION_SECRET}
EOF
}

install_summary() {
  step_ca_status="not initialized"
  if [ -f "${BASE_DIR}/pki/step-ca/ca.crt" ]; then
    step_ca_status="initialized, root CA exported"
  fi

  summary_fingerprint="${STEP_CA_FINGERPRINT:-}"
  if [ -z "${summary_fingerprint}" ] && [ -f "${BASE_DIR}/step-ca/certs/root_ca.crt" ] && has_command "step"; then
    summary_fingerprint="$(step certificate fingerprint "${BASE_DIR}/step-ca/certs/root_ca.crt" 2>/dev/null || true)"
  fi
  if [ -z "${summary_fingerprint}" ] && [ -f "${BASE_DIR}/pki/step-ca/ca.crt" ] && has_command "step"; then
    summary_fingerprint="$(step certificate fingerprint "${BASE_DIR}/pki/step-ca/ca.crt" 2>/dev/null || true)"
  fi

  mode="DNS domain"
  if [ "${MQTT_USE_PUBLIC_IP}" = "yes" ]; then
    mode="public IP"
  fi

  printf "%s\n" \
    "Install summary" \
    "" \
    "Mode: ${mode}" \
    "Public endpoint: ${MQTT_DOMAIN}" \
    "Admin Web: ${ADMIN_ORIGIN}" \
    "MQTT TLS: ${MQTT_DOMAIN}:${MQTT_TLS_PORT}" \
    "MQTT WSS: ${MQTT_DOMAIN}:${MQTT_WS_TLS_PORT}" \
    "step-ca API: ${STEP_CA_URL}" \
    "" \
    "Runtime directory: ${BASE_DIR}" \
    "Environment file: ${ENV_FILE}" \
    "Container engine: ${CONTAINER_ENGINE}" \
    "Container prefix: ${CONTAINER_NAME}" \
    "Image prefix: ${IMAGE_NAME}" \
    "" \
    "Let's Encrypt email: ${CERTBOT_EMAIL:-not configured}" \
    "Extra Certbot args: ${CERTBOT_ARGS:-none}" \
    "step-ca status: ${step_ca_status}" \
    "step-ca provisioner: ${STEP_CA_PROVISIONER}" \
    "Device certificate TTL: ${STEP_CA_DEVICE_CERT_TTL}" \
    "step-ca fingerprint: ${summary_fingerprint:-not available}" \
    "" \
    "Admin passkey RP name: ${ADMIN_RP_NAME}" \
    "Admin passkey RP id: ${ADMIN_RP_ID}" \
    "" \
    "Use this token once to register the first admin passkey:" \
    "Admin setup token: ${ADMIN_SETUP_TOKEN}"
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
  engines="$(available_container_engines)"
  if [ -z "${engines}" ]; then
    if [ "${WIZARD_PREVIEW}" = "yes" ]; then
      CONTAINER_ENGINE="${CONTAINER_ENGINE:-podman}"
      return 0
    fi
    wt_msg "No supported container engine was found.\n\nInstall Docker with Docker Compose or Podman with Podman Compose before continuing."
    return 1
  fi

  if [ -n "${CONTAINER_ENGINE:-}" ] && compose_command_available "${CONTAINER_ENGINE}"; then
    return 0
  fi

  if printf "%s\n" "${engines}" | grep -qx "podman"; then
    CONTAINER_ENGINE="podman"
    return 0
  fi

  CONTAINER_ENGINE="docker"
}

configure_basic() {
  PUBLIC_IP="$(detect_public_ip || true)"

  has_domain_default="no"
  if [ -n "${MQTT_DOMAIN}" ] && [ "${MQTT_USE_PUBLIC_IP:-no}" != "yes" ]; then
    has_domain_default="yes"
  fi

  if wt_yesno_default "Do you have a DNS domain for this gateway?" "${has_domain_default}"; then
    while :; do
      MQTT_DOMAIN="$(wt_input "Domain" "Enter the public DNS domain for Admin, MQTT, and step-ca." "${MQTT_DOMAIN}")" || return 1
      if [ -z "${MQTT_DOMAIN}" ]; then
        wt_msg "Domain is required when DNS domain mode is selected."
        continue
      fi
      if [ "${WIZARD_PREVIEW}" = "yes" ]; then
        break
      fi
      if ! domain_has_dns_record "${MQTT_DOMAIN}"; then
        wt_msg "DNS lookup failed for:\n\n${MQTT_DOMAIN}\n\nCreate an A or AAAA record pointing to this VPS, or fix the typed domain before continuing."
        continue
      fi
      if domain_matches_public_ip "${MQTT_DOMAIN}" "${PUBLIC_IP}"; then
        break
      fi
      resolved_ips="$(domain_resolved_ips "${MQTT_DOMAIN}" | tr '\n' ' ')"
      wt_msg "DNS does not match this VPS public IP.\n\nDomain: ${MQTT_DOMAIN}\nDetected VPS public IP: ${PUBLIC_IP:-not detected}\nDomain resolves to: ${resolved_ips:-not detected}\n\nFix the DNS A/AAAA record or enter the correct domain before continuing."
    done
    MQTT_USE_PUBLIC_IP="no"
  else
    previous_use_public_ip="${MQTT_USE_PUBLIC_IP:-}"
    MQTT_USE_PUBLIC_IP="yes"
    ip_default="${PUBLIC_IP}"
    if [ "${previous_use_public_ip}" = "yes" ] && [ -n "${MQTT_DOMAIN}" ]; then
      ip_default="${MQTT_DOMAIN}"
    fi
    MQTT_DOMAIN="${ip_default}"
    if [ -z "${MQTT_DOMAIN}" ]; then
      MQTT_DOMAIN="$(wt_input "Public IP" "Public IP could not be detected. Enter it manually." "")" || return 1
    fi
    if [ -z "${MQTT_DOMAIN}" ]; then
      wt_msg "Public IP is required when DNS domain mode is not selected."
      return 1
    fi
    case " ${CERTBOT_ARGS:-} " in
      *" --preferred-profile "*) ;;
      *) CERTBOT_ARGS="${CERTBOT_ARGS:+${CERTBOT_ARGS} }--preferred-profile shortlived" ;;
    esac
  fi

  while :; do
    CERTBOT_EMAIL="$(wt_input "Let's Encrypt" "Contact email for Let's Encrypt. Leave empty to skip email registration.\n\nThis must be an email address, not the domain." "${CERTBOT_EMAIL}")" || return 1
    if valid_email_or_empty "${CERTBOT_EMAIL}"; then
      break
    fi
    wt_msg "Invalid Let's Encrypt email:\n\n${CERTBOT_EMAIL}\n\nEnter a valid email address like contato@example.com, or leave this field empty."
  done
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
  ADMIN_RP_NAME="$(normalize_admin_name "${ADMIN_RP_NAME:-MQTT_Trust_Gateway}")"
  derive_public_endpoints
}

configure_advanced() {
  if ! wt_yesno_default "Edit advanced settings?" "no"; then
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
  admin_rp_input="$(wt_input "Advanced" "Admin passkey display name. Spaces are saved as underscores in broker.env." "${ADMIN_RP_NAME}")" || return 1
  ADMIN_RP_NAME="$(normalize_admin_name "${admin_rp_input}")"
  STEP_CA_PORT="$(wt_input "Advanced" "step-ca external port." "${STEP_CA_PORT}")" || return 1
  STEP_CA_PROVISIONER="$(wt_input "Advanced" "step-ca provisioner name." "${STEP_CA_PROVISIONER}")" || return 1
  STEP_CA_DEVICE_CERT_TTL="$(wt_input "Advanced" "Device certificate TTL." "${STEP_CA_DEVICE_CERT_TTL}")" || return 1
  derive_public_endpoints
}

run_install() {
  defaults
  if [ "${WIZARD_PREVIEW}" = "yes" ]; then
    wt_msg "Preview mode is active.\n\nYou can navigate the install wizard, but no files will be written and no containers or certificates will be changed."
  fi

  configure_basic || return 0
  configure_advanced || return 0
  derive_public_endpoints
  write_env

  summary="Admin Web: ${ADMIN_ORIGIN}\nMQTT TLS: ${MQTT_DOMAIN}:${MQTT_TLS_PORT}\nMQTT WSS: ${MQTT_DOMAIN}:${MQTT_WS_TLS_PORT}\nstep-ca: ${STEP_CA_URL}\nRuntime: ${BASE_DIR}\nEngine: ${CONTAINER_ENGINE}"
  wt_msg "${summary}"

  if [ "${WIZARD_PREVIEW}" = "yes" ]; then
    preview_step_ca="no"
    preview_start="no"
    if wt_yesno_default "Initialize or update step-ca now?" "yes"; then
      preview_step_ca="yes"
      wt_confirmed_password "step-ca Password" "Preview only. Entering a password here will not write any file or initialize step-ca." || return 0
    fi
    if wt_yesno_default "Start containers now?" "yes"; then
      preview_start="yes"
    fi

    wt_textbox_text "Install preview summary" "$(install_summary)

Preview selected step-ca initialization: ${preview_step_ca}
Preview selected container startup: ${preview_start}

Preview mode: no files were written, no certificates were initialized, and no containers were started."
    return 0
  fi

  if ! compose_command_available "${CONTAINER_ENGINE}"; then
    wt_msg "${CONTAINER_ENGINE} compose is not available."
    return 1
  fi

  if wt_yesno_default "Initialize or update step-ca now?" "yes"; then
    wt_confirmed_password "step-ca Password" "Password for ${BASE_DIR}/step-ca/secrets/password." || return 0
    password="${CONFIRMED_PASSWORD}"
    if ! wt_progress_command "step-ca setup" bootstrap_step_ca "${password}"; then
      wt_msg "step-ca setup failed. Review the log shown by the wizard before continuing."
      return 1
    fi
    if [ -f "${BASE_DIR}/step-ca/certs/root_ca.crt" ]; then
      STEP_CA_FINGERPRINT="$(step certificate fingerprint "${BASE_DIR}/step-ca/certs/root_ca.crt")"
    fi
    write_env
  fi

  if wt_yesno_default "Start containers now?" "yes"; then
    cd "${SCRIPT_DIR}"
    if ! wt_progress_command "Starting step-ca" run_compose --env-file broker.env -f step-ca/compose.step-ca.yaml up -d; then
      wt_msg "step-ca container startup failed. Review the log shown by the wizard."
      return 1
    fi
    if [ ! -f "${BASE_DIR}/pki/step-ca/ca.crt" ]; then
      wt_msg "step-ca was started, but the MQTT client CA was not found at:\n\n${BASE_DIR}/pki/step-ca/ca.crt\n\nRun install again and initialize step-ca before starting the broker."
      return 0
    fi
    if ! wt_progress_command "Starting gateway" run_compose --env-file broker.env up -d --build; then
      wt_msg "Gateway startup failed. Review the log shown by the wizard."
      return 1
    fi
    wt_textbox_text "Install summary" "$(install_summary)"
  else
    wt_textbox_text "Install summary" "$(install_summary)

Containers were not started."
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

remove_update_containers() {
  for container in \
    "${CONTAINER_NAME}-admin-nginx" \
    "${CONTAINER_NAME}-admin-web" \
    "${CONTAINER_NAME}"
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
  if [ "${WIZARD_PREVIEW}" = "yes" ]; then
    wt_msg "Preview mode is active.\n\nYou can navigate the uninstall wizard, but no containers, images, runtime data, repository files, broker.env, or iptables rules will be changed."
  fi

  choose_engine || return 0

  if ! wt_yesno_default "Stop and remove MQTT Trust Gateway containers?\n\nRepository files will not be deleted." "no"; then
    return 0
  fi

  if [ "${WIZARD_PREVIEW}" = "yes" ]; then
    if wt_yesno_default "Preview removing locally built images?" "no"; then
      :
    fi
    if wt_yesno_default "Preview deleting runtime data at ${BASE_DIR}?" "no"; then
      :
    fi
    if wt_yesno_default "Preview removing local iptables ACCEPT rules for configured ports?" "no"; then
      :
    fi
    wt_msg "Uninstall preview finished.\n\nNo containers, images, runtime data, repository files, broker.env, or iptables rules were changed."
    return 0
  fi

  if ! compose_command_available "${CONTAINER_ENGINE}"; then
    wt_msg "${CONTAINER_ENGINE} compose is not available."
    return 1
  fi

  cd "${SCRIPT_DIR}"
  wt_progress_command "Stopping gateway" run_compose --env-file broker.env down --remove-orphans || true
  wt_progress_command "Stopping step-ca" run_compose --env-file broker.env -f step-ca/compose.step-ca.yaml down --remove-orphans || true
  remove_named_containers

  if wt_yesno_default "Remove locally built images?" "no"; then
    remove_images
  fi

  if wt_yesno_default "Delete runtime data at ${BASE_DIR}?\n\nThis removes certificates, CA files, admin DB, and Mosquitto data.\n\nRepository files and broker.env will not be deleted." "no"; then
    rm -rf "${BASE_DIR}"
  fi

  if wt_yesno_default "Remove local iptables ACCEPT rules for configured ports?" "no"; then
    remove_iptables_accept_rule "${ACME_HTTP_PORT}"
    remove_iptables_accept_rule "${ADMIN_HTTPS_PORT}"
    remove_iptables_accept_rule "${MQTT_TLS_PORT}"
    remove_iptables_accept_rule "${MQTT_WS_TLS_PORT}"
    remove_iptables_accept_rule "${STEP_CA_PORT}"
  fi

  wt_msg "Uninstall actions finished.\n\nRepository files were kept."
}

run_update() {
  defaults
  BASE_DIR="$(absolute_path "${BASE_DIR}")"
  derive_public_endpoints
  choose_engine || return 0

  if [ "${WIZARD_PREVIEW}" = "yes" ]; then
    wt_textbox_text "Update preview summary" "$(install_summary)

Preview mode: would optionally run git pull, then rebuild and recreate:
- ${CONTAINER_NAME}
- ${CONTAINER_NAME}-admin-web
- ${CONTAINER_NAME}-admin-nginx"
    return 0
  fi

  if ! compose_command_available "${CONTAINER_ENGINE}"; then
    wt_msg "${CONTAINER_ENGINE} compose is not available."
    return 1
  fi

  cd "${SCRIPT_DIR}"

  if wt_yesno_default "Run git pull before updating containers?" "yes"; then
    if ! wt_progress_command "Updating repository" git -C "${SCRIPT_DIR}" pull --ff-only; then
      wt_msg "git pull failed. The containers were not updated."
      return 1
    fi
  fi

  if [ ! -f "${BASE_DIR}/pki/step-ca/ca.crt" ]; then
    wt_msg "MQTT client CA was not found at:\n\n${BASE_DIR}/pki/step-ca/ca.crt\n\nRun Install and initialize step-ca before updating the application containers."
    return 1
  fi

  remove_update_containers

  if ! wt_progress_command "Updating gateway" run_compose --env-file broker.env up -d --build broker admin-web admin-nginx; then
    wt_msg "Update failed. Review the log shown by the wizard."
    return 1
  fi

  wt_textbox_text "Update summary" "$(install_summary)

Updated containers:
- ${CONTAINER_NAME}
- ${CONTAINER_NAME}-admin-web
- ${CONTAINER_NAME}-admin-nginx"
}

run_preview() {
  previous_preview="${WIZARD_PREVIEW}"
  WIZARD_PREVIEW="yes"

  while :; do
    choice="$(wt_menu "Preview mode" "Navigate a wizard flow without applying changes." \
      "install" \
      "install" "Install" \
      "update" "Update" \
      "uninstall" "Uninstall" \
      "back" "Back")" || break
    case "${choice}" in
      install) run_install ;;
      update) run_update ;;
      uninstall) run_uninstall ;;
      back) break ;;
    esac
  done

  WIZARD_PREVIEW="${previous_preview}"
}

main_menu() {
  case "${REQUESTED_MODE}" in
    install|setup)
      show_dependency_checklist
      run_install
      return 0
      ;;
    update)
      show_dependency_checklist
      run_update
      return 0
      ;;
    uninstall|remove)
      show_dependency_checklist
      run_uninstall
      return 0
      ;;
    preview|dry-run)
      WIZARD_PREVIEW="yes"
      run_preview
      return 0
      ;;
  esac

  show_dependency_checklist

  while :; do
    choice="$(wt_menu_nocancel "MQTT Trust Gateway" "Choose an action." \
      "install" \
      "install" "Install" \
      "update" "Update" \
      "uninstall" "Uninstall" \
      "exit" "Exit")"
    case "${choice}" in
      install) run_install ;;
      update) run_update ;;
      uninstall) run_uninstall ;;
      exit) exit 0 ;;
    esac
  done
}

main_menu "${1:-}"
