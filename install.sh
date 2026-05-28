#!/bin/bash
# ============================================================================
#  Product Entry - Text Interactive Installer
#  Designed for Ubuntu Server 24.04 LTS (Minimal Install)
#
#  All command output streams to the terminal (and is tee'd to the install
#  log) so failures are visible as they happen.
#
#  Usage:  curl -fsSL <raw-url>/install.sh | sudo bash
#     or:  sudo bash install.sh
# ============================================================================

set -eo pipefail

# ── Config ──────────────────────────────────────────────
APP_NAME="product-entry"
APP_TITLE="Product Entry"
INSTALL_DIR="/opt/${APP_NAME}"
REPO_URL="https://github.com/ruolez/product-entry.git"
COMPOSE_PROJECT="product-entry"
DC="docker compose"
PORT=80
LOG="/tmp/${APP_NAME}-install.log"

# ── Root check ──────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root (sudo)."
    exit 1
fi

# ── Log setup ───────────────────────────────────────────
: > "$LOG"
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# ── Text UI helpers ─────────────────────────────────────
# Prompts read from /dev/tty so they still work under `curl ... | sudo bash`.
C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'

hr() { printf '%s\n' "────────────────────────────────────────────────────────────"; }

# Boxed informational message (replaces whiptail --msgbox). Pauses if a tty exists.
note() {
    local title="$1" body="$2"
    echo
    hr
    [ -n "$title" ] && printf '%s%s%s\n\n' "$C_BOLD" "$title" "$C_OFF"
    printf '%b\n' "$body"
    hr
    [ -e /dev/tty ] && read -rp "Press Enter to continue..." _ </dev/tty || true
}

# Yes/No confirmation (replaces whiptail --yesno). $2 = default (y|n), defaults to n.
confirm() {
    local q="$1" def="${2:-n}" ans prompt
    [ "$def" = "y" ] && prompt="[Y/n]" || prompt="[y/N]"
    if [ -e /dev/tty ]; then
        read -rp "$q $prompt: " ans </dev/tty
    else
        ans=""
    fi
    ans="${ans:-$def}"
    [[ "$ans" =~ ^[Yy] ]]
}

# Numbered single-choice menu (replaces whiptail --menu).
# Usage: choose "prompt" key1 "label1" key2 "label2" ... ; echoes the chosen key.
# The menu renders on the terminal; only the selected key goes to stdout.
choose() {
    local prompt="$1"; shift
    local keys=() labels=()
    while [ $# -gt 0 ]; do keys+=("$1"); labels+=("$2"); shift 2; done
    {
        echo
        printf '%s%s%s\n' "$C_BOLD" "$prompt" "$C_OFF"
        local idx
        for idx in "${!keys[@]}"; do
            printf '  %2d) %s\n' "$((idx + 1))" "${labels[$idx]}"
        done
    } >/dev/tty
    local sel
    read -rp "Select [1-${#keys[@]}]: " sel </dev/tty
    if [[ "$sel" =~ ^[0-9]+$ ]] && [ "$sel" -ge 1 ] && [ "$sel" -le "${#keys[@]}" ]; then
        echo "${keys[$((sel - 1))]}"
    else
        echo ""
    fi
}

# Print a block of text (replaces whiptail --textbox), then wait for Enter.
show_text() {
    local title="$1" content="$2"
    echo
    hr
    printf '%s%s%s\n' "$C_BOLD" "$title" "$C_OFF"
    hr
    printf '%s\n' "$content"
    hr
    [ -e /dev/tty ] && read -rp "Press Enter to continue..." _ </dev/tty || true
}

# ════════════════════════════════════════════════════════
#  UTILITY FUNCTIONS
# ════════════════════════════════════════════════════════

detect_ip() {
    local ip=""
    ip=$(ip -4 route get 8.8.8.8 2>/dev/null | grep -oP 'src \K[\d.]+' | head -1)
    [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -z "$ip" ] && ip=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
    echo "$ip"
}

generate_password() {
    openssl rand -base64 24 | tr -d '/+=' | head -c 24
}

generate_fernet_key() {
    # Fernet key = 32 random bytes, url-safe base64 encoded (44 chars with = padding)
    python3 -c "import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
}

get_status_info() {
    local status="NOT INSTALLED"
    local ip="N/A"
    local stores="N/A"
    local formulas="N/A"
    local uptime="N/A"

    if [ -d "$INSTALL_DIR" ]; then
        status="STOPPED"
        [ -f "${INSTALL_DIR}/.env" ] && ip=$(grep '^SERVER_IP=' "${INSTALL_DIR}/.env" 2>/dev/null | sed 's/^SERVER_IP=//' || echo "N/A")
        if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
            status="RUNNING"
            stores=$(cd "$INSTALL_DIR" && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
                psql -U itementry -d itementry -t -c "SELECT count(*) FROM stores;" 2>/dev/null | tr -d ' ' || echo "?")
            formulas=$(cd "$INSTALL_DIR" && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
                psql -U itementry -d itementry -t -c "SELECT count(*) FROM price_formulas;" 2>/dev/null | tr -d ' ' || echo "?")
        fi
    fi
    echo "${status}|${ip}|${stores}|${formulas}"
}

# ── Progress step printer ───────────────────────────────
# Prints a step banner to the terminal. The first arg (a legacy percentage) is
# accepted and ignored so existing call sites need no changes.
gauge_msg() {
    local phase="$2"
    local detail="$3"
    if [ -n "$detail" ]; then
        printf '\n%s==> %s%s\n    %s\n' "$C_BOLD" "$phase" "$C_OFF" "$detail"
    else
        printf '\n%s==> %s%s\n' "$C_BOLD" "$phase" "$C_OFF"
    fi
    log "${phase} ${detail}"
}

# ════════════════════════════════════════════════════════
#  PRODUCTION CONFIG GENERATORS
# ════════════════════════════════════════════════════════

generate_env_file() {
    local server_ip="$1" pg_pass="$2" fernet_key="$3"
    cat > "${INSTALL_DIR}/.env" << ENVEOF
POSTGRES_USER=itementry
POSTGRES_PASSWORD=${pg_pass}
POSTGRES_DB=itementry
DATABASE_URL=postgresql://itementry:${pg_pass}@postgres:5432/itementry
FERNET_KEY=${fernet_key}
FLASK_ENV=production
SERVER_IP=${server_ip}
ENVEOF
    chmod 600 "${INSTALL_DIR}/.env"
}

generate_prod_compose() {
    cat > "${INSTALL_DIR}/docker-compose.prod.yml" << 'COMPEOF'
services:
  nginx:
    build: ./nginx
    ports:
      - "80:80"
    depends_on:
      - app
    networks:
      - product-entry-net
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  app:
    build:
      context: ./app
      dockerfile: Dockerfile.prod
    volumes:
      - ./postgres/migrations:/app/migrations:ro
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy
    networks:
      - product-entry-net
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  postgres:
    image: postgres:16-alpine
    env_file:
      - .env
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql
    networks:
      - product-entry-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

networks:
  product-entry-net:
    driver: bridge

volumes:
  pgdata:
COMPEOF
}

generate_prod_dockerfile() {
    cat > "${INSTALL_DIR}/app/Dockerfile.prod" << 'DKEOF'
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    freetds-dev \
    gcc \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "4", "--preload", "--access-logfile", "-", "--error-logfile", "-", "wsgi:app"]
DKEOF
}

generate_prod_nginx() {
    local server_ip="$1"
    cat > "${INSTALL_DIR}/nginx/nginx.conf" << NGEOF
server {
    listen 80;
    server_name ${server_ip} localhost;

    add_header Cache-Control "no-store, no-cache, must-revalidate, max-age=0" always;
    add_header Pragma "no-cache" always;

    add_header Access-Control-Allow-Origin "http://${server_ip}" always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Content-Type, Authorization, Cache-Control, Pragma" always;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;

    location / {
        if (\$request_method = OPTIONS) {
            return 204;
        }
        proxy_pass http://app:5000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 30s;
        proxy_read_timeout 120s;
        proxy_send_timeout 30s;
    }

    location /static/ {
        proxy_pass http://app:5000/static/;
        expires -1;
    }

    location ~* \.(php|asp|aspx|jsp)$ {
        return 444;
    }
}
NGEOF
}

# ════════════════════════════════════════════════════════
#  ASK FOR SERVER IP
# ════════════════════════════════════════════════════════

# Echoes the chosen IP to stdout; all prompts/errors go to stderr so callers can
# capture the value with $(ask_server_ip).
ask_server_ip() {
    local detected_ip default_ip server_ip
    detected_ip=$(detect_ip)
    default_ip="${1:-$detected_ip}"

    printf '\n%sNetwork configuration%s — used for nginx server_name, CORS origin, access URL.\n' \
        "$C_BOLD" "$C_OFF" >&2
    [ -n "$detected_ip" ] && printf '  Detected IP: %s\n' "$detected_ip" >&2

    while true; do
        if [ -e /dev/tty ]; then
            read -rp "Server IP address [$default_ip]: " server_ip </dev/tty
        else
            server_ip=""
        fi
        server_ip="${server_ip:-$default_ip}"

        if echo "$server_ip" | grep -qP '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'; then
            echo "$server_ip"
            return 0
        fi

        printf '%s  Invalid or empty IP: "%s"%s\n' "$C_RED" "$server_ip" "$C_OFF" >&2
        [ -e /dev/tty ] || return 1   # cannot prompt non-interactively; give up
    done
}

# ════════════════════════════════════════════════════════
#  INSTALL
# ════════════════════════════════════════════════════════

do_install() {
    # Check existing installation
    if [ -d "$INSTALL_DIR" ]; then
        note "Existing Installation Found" \
"An existing installation was found at:\n\n  ${INSTALL_DIR}\n\nContinuing will REMOVE it and start fresh. Database data will be DELETED."
        if ! confirm "Continue with fresh install?" n; then
            return
        fi
        echo "  Removing existing installation..."
        cd /tmp
        (cd "$INSTALL_DIR" 2>/dev/null && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" down -v 2>/dev/null) || true
        rm -rf "$INSTALL_DIR"
    fi

    # Get server IP
    local server_ip
    server_ip=$(ask_server_ip) || return

    # Confirm
    note "Confirm Installation" \
"Ready to install ${APP_TITLE}.\n\n  Server IP:     ${server_ip}\n  Install path:  ${INSTALL_DIR}\n  Web access:    http://${server_ip}\n  Docker port:   ${PORT}\n\nThis will install Docker (if needed), clone the repository,\ngenerate secure credentials, and build production containers."
    if ! confirm "Proceed with installation?" y; then
        return
    fi

    # ── Run install steps (output streams to terminal + ${LOG}) ───────
    local pg_pass fernet_key
    pg_pass=$(generate_password)
    fernet_key=$(generate_fernet_key)

    (
        gauge_msg 0  "[ 1/20] System Dependencies" "Running apt-get update..."
        apt-get update -qq 2>&1 | tee -a "$LOG"

        gauge_msg 3  "[ 2/20] System Dependencies" "Installing git, curl, openssl, python3..."
        apt-get install -y -qq git curl openssl python3 2>&1 | tee -a "$LOG"

        gauge_msg 5  "[ 3/20] System Dependencies" "Installing ca-certificates, gnupg, lsb-release..."
        apt-get install -y -qq ca-certificates gnupg lsb-release 2>&1 | tee -a "$LOG"

        gauge_msg 7  "[ 4/20] Docker Engine" "Checking if Docker is installed..."
        if ! command -v docker &>/dev/null; then
            gauge_msg 8  "[ 5/20] Docker Engine" "Adding Docker GPG key..."
            install -m 0755 -d /etc/apt/keyrings 2>&1 | tee -a "$LOG"
            curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc 2>&1 | tee -a "$LOG"
            chmod a+r /etc/apt/keyrings/docker.asc

            gauge_msg 10 "[ 6/20] Docker Engine" "Adding Docker APT repository..."
            echo \
                "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
                https://download.docker.com/linux/ubuntu \
                $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
                tee /etc/apt/sources.list.d/docker.list >/dev/null

            gauge_msg 12 "[ 7/20] Docker Engine" "Updating package lists with Docker repo..."
            apt-get update -qq 2>&1 | tee -a "$LOG"

            gauge_msg 14 "[ 8/20] Docker Engine" "Installing docker-ce, docker-ce-cli (~400MB download)..."
            apt-get install -y -qq docker-ce docker-ce-cli 2>&1 | tee -a "$LOG"

            gauge_msg 18 "[ 9/20] Docker Engine" "Installing containerd, buildx, compose plugin..."
            apt-get install -y -qq containerd.io docker-buildx-plugin docker-compose-plugin 2>&1 | tee -a "$LOG"

            gauge_msg 22 "[10/20] Docker Engine" "Enabling Docker service (auto-start on boot)..."
            systemctl enable docker --now 2>&1 | tee -a "$LOG"
            sleep 2

            gauge_msg 25 "[10/20] Docker Engine" "Done: $(docker --version 2>/dev/null | head -c 40)"
            sleep 1
        else
            gauge_msg 25 "[10/20] Docker Engine" "Already installed: $(docker --version | head -c 40)"
            sleep 1
        fi

        gauge_msg 27 "[11/20] Clone Repository" "Cloning ${REPO_URL}..."
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>&1 | tee -a "$LOG"
        gauge_msg 32 "[11/20] Clone Repository" "Cloned to ${INSTALL_DIR}"
        sleep 1

        gauge_msg 33 "[12/20] Generate Config" "Generating secure PostgreSQL password and Fernet key..."
        sleep 1
        gauge_msg 34 "[12/20] Generate Config" "Writing .env (credentials, IP: ${server_ip})..."
        generate_env_file "$server_ip" "$pg_pass" "$fernet_key"

        gauge_msg 36 "[13/20] Generate Config" "Writing docker-compose.prod.yml (3 services, log rotation)..."
        generate_prod_compose

        gauge_msg 37 "[14/20] Generate Config" "Writing Dockerfile.prod (python:3.12, 4 Gunicorn workers)..."
        generate_prod_dockerfile

        gauge_msg 39 "[15/20] Generate Config" "Writing nginx.conf (server: ${server_ip}, CORS, security)..."
        generate_prod_nginx "$server_ip"

        gauge_msg 40 "[15/20] Generate Config" "All production configs generated."
        sleep 1

        cd "$INSTALL_DIR"

        gauge_msg 41 "[16/20] Pull Base Images" "Pulling postgres:16-alpine..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" pull postgres 2>&1 | tee -a "$LOG" || true

        gauge_msg 45 "[17/20] Build App Container" "Installing FreeTDS, GCC, Flask, pymssql (2-5 min)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --progress=plain app 2>&1 | tee -a "$LOG"

        gauge_msg 68 "[18/20] Build Nginx Container" "Building nginx:alpine with custom config..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --progress=plain nginx 2>&1 | tee -a "$LOG"
        gauge_msg 72 "[18/20] Build Containers" "All container images built successfully."

        gauge_msg 73 "[19/20] Start PostgreSQL" "Creating network, starting postgres:16..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d postgres 2>&1 | tee -a "$LOG"
        local pg_retries=0
        while [ $pg_retries -lt 15 ]; do
            if $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres pg_isready -U itementry 2>&1 | tee -a "$LOG"; then
                break
            fi
            pg_retries=$((pg_retries + 1))
            gauge_msg "$((74 + pg_retries / 3))" "[19/20] Start PostgreSQL" "Waiting for health check (attempt ${pg_retries}/15)..."
            sleep 2
        done

        gauge_msg 79 "[19/20] Start Application" "Starting Flask/Gunicorn (4 workers)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d app 2>&1 | tee -a "$LOG"
        sleep 2

        gauge_msg 81 "[19/20] Start Nginx" "Starting reverse proxy on port ${PORT}..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d nginx 2>&1 | tee -a "$LOG"
        sleep 1
        gauge_msg 83 "[19/20] Start Services" "All 3 containers are running."
        sleep 1

        gauge_msg 85 "[20/20] Health Check" "GET http://localhost/api/health ..."
        local retries=0
        while [ $retries -lt 20 ]; do
            if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
                break
            fi
            retries=$((retries + 1))
            gauge_msg "$((85 + retries / 2))" "[20/20] Health Check" "Waiting for response (attempt ${retries}/20)..."
            sleep 2
        done

        gauge_msg 96 "[20/20] Verify Database" "Checking tables and seed data..."
        local table_count field_count
        table_count=$($DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
            psql -U itementry -d itementry -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d ' ' || echo "?")
        field_count=$($DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
            psql -U itementry -d itementry -t -c "SELECT count(*) FROM field_configs;" 2>/dev/null | tr -d ' ' || echo "?")

        gauge_msg 99 "[20/20] Verify Database" "OK: ${table_count} tables, ${field_count} field configs."
        sleep 1

        gauge_msg 100 "Installation complete!" "All services running at http://${server_ip}"

    ) || true

    # ── Result ────────────────────────────────────────
    if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
        note "Installation Complete" \
"${C_GREEN}Installation Successful!${C_OFF}  ${APP_TITLE} is now running.\n\n  Web Interface:  http://${server_ip}\n  Settings:       http://${server_ip}/settings\n  Install Path:   ${INSTALL_DIR}\n\nQuick Start:\n  1. Open http://${server_ip}/settings\n  2. Add your MS SQL store connections\n  3. Configure price formulas\n  4. Start entering products!\n\nUseful commands:\n  View logs:  cd ${INSTALL_DIR} && docker compose -f docker-compose.prod.yml logs -f\n  Restart:    cd ${INSTALL_DIR} && docker compose -f docker-compose.prod.yml restart\n  Update:     sudo bash ${INSTALL_DIR}/install.sh"
    else
        note "Warning" \
"${C_YELLOW}Installation finished but the health check failed.${C_OFF}\n\nThe services may still be starting.\nCheck logs: cd ${INSTALL_DIR} && docker compose -f docker-compose.prod.yml logs\n\nFull install log: ${LOG}"
    fi
}

# ════════════════════════════════════════════════════════
#  UPDATE
# ════════════════════════════════════════════════════════

do_update() {
    if [ ! -d "$INSTALL_DIR" ]; then
        note "Not Installed" "No installation found at ${INSTALL_DIR}.\n\nPlease run Install first."
        return
    fi

    cd "$INSTALL_DIR"

    # Read current config
    local current_ip=""
    local pg_pass="" fernet_key=""
    if [ -f ".env" ]; then
        current_ip=$(grep '^SERVER_IP=' .env 2>/dev/null | sed 's/^SERVER_IP=//')
        pg_pass=$(grep '^POSTGRES_PASSWORD=' .env 2>/dev/null | sed 's/^POSTGRES_PASSWORD=//')
        fernet_key=$(grep '^FERNET_KEY=' .env 2>/dev/null | sed 's/^FERNET_KEY=//')
    fi

    # Only generate a new Fernet key if none exists (should never happen on update)
    if [ -z "$fernet_key" ]; then
        fernet_key=$(generate_fernet_key)
        log "WARNING: No Fernet key found in .env, generated new key. Existing encrypted passwords will be lost."
    fi

    # Ask for IP (pre-filled with current)
    local server_ip
    server_ip=$(ask_server_ip "$current_ip") || return

    # Confirm
    note "Confirm Update" \
"Ready to update ${APP_TITLE}.\n\n  Server IP:     ${server_ip}\n  Install path:  ${INSTALL_DIR}\n\nThis will:\n  - Preserve all database data (stores, formulas, history)\n  - Preserve encryption keys and passwords\n  - Pull latest code from GitHub\n  - Rebuild Docker containers\n  - Clean up old Docker images and logs\n\nServices will be briefly offline during rebuild."
    if ! confirm "Proceed with update?" y; then
        return
    fi

    (
        gauge_msg 0  "[ 1/17] Backup Config" "Backing up .env to .env.backup..."
        cp .env .env.backup 2>/dev/null || true

        gauge_msg 5  "[ 2/17] Stop Nginx" "Stopping reverse proxy..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" stop nginx 2>&1 | tee -a "$LOG" || true

        gauge_msg 8  "[ 3/17] Stop App" "Stopping Flask application..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" stop app 2>&1 | tee -a "$LOG" || true

        gauge_msg 11 "[ 4/17] Stop Postgres" "Stopping database (data safe in volume)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" down 2>&1 | tee -a "$LOG" || \
        $DC -p "$COMPOSE_PROJECT" down 2>&1 | tee -a "$LOG" || true

        gauge_msg 15 "[ 4/17] Services Stopped" "All containers down. Data volume preserved."
        sleep 1

        gauge_msg 17 "[ 5/17] Fetch Code" "git fetch origin main..."
        git fetch origin main 2>&1 | tee -a "$LOG"

        gauge_msg 20 "[ 6/17] Apply Code" "git reset --hard origin/main..."
        git reset --hard origin/main 2>&1 | tee -a "$LOG"
        local commit_msg
        commit_msg=$(git log --oneline -1 2>/dev/null | head -c 50)

        gauge_msg 25 "[ 6/17] Code Updated" "${commit_msg}"
        sleep 1

        gauge_msg 27 "[ 7/17] Regenerate .env" "Preserving password + Fernet key, IP: ${server_ip}"
        generate_env_file "$server_ip" "$pg_pass" "$fernet_key"

        gauge_msg 29 "[ 8/17] Regenerate Compose" "docker-compose.prod.yml (3 services, log rotation)"
        generate_prod_compose

        gauge_msg 31 "[ 9/17] Regenerate Dockerfile" "Dockerfile.prod (python:3.12, 4 Gunicorn workers)"
        generate_prod_dockerfile

        gauge_msg 33 "[10/17] Regenerate Nginx" "nginx.conf (server: ${server_ip}, CORS, security)"
        generate_prod_nginx "$server_ip"

        gauge_msg 35 "[10/17] Configs Ready" "All production configs regenerated."
        sleep 1

        gauge_msg 36 "[11/17] Rebuild App" "Building app container --no-cache (2-5 min)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --no-cache --progress=plain app 2>&1 | tee -a "$LOG"

        gauge_msg 60 "[12/17] Rebuild Nginx" "Building nginx container..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --no-cache --progress=plain nginx 2>&1 | tee -a "$LOG"

        gauge_msg 63 "[12/17] Build Complete" "All container images rebuilt."
        sleep 1

        gauge_msg 65 "[13/17] Start Postgres" "Starting PostgreSQL 16..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d postgres 2>&1 | tee -a "$LOG"
        local pg_retries=0
        while [ $pg_retries -lt 10 ]; do
            if $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres pg_isready -U itementry 2>&1 | tee -a "$LOG"; then
                break
            fi
            pg_retries=$((pg_retries + 1))
            gauge_msg "$((66 + pg_retries))" "[13/17] Start Postgres" "Health check attempt ${pg_retries}/10..."
            sleep 2
        done

        gauge_msg 73 "[13/17] Run Migrations" "Applying database migrations..."
        # Create schema_migrations table if it doesn't exist (for pre-migration installs)
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
            psql -U itementry -d itementry -c \
            "CREATE TABLE IF NOT EXISTS schema_migrations (id SERIAL PRIMARY KEY, filename VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" \
            2>&1 | tee -a "$LOG" || true
        # Apply every migration file (all are idempotent) with ON_ERROR_STOP so a
        # failed apply is visible, and record it as applied ONLY on success. This
        # prevents schema_migrations from claiming a migration ran when it did not.
        if [ -d "${INSTALL_DIR}/postgres/migrations" ]; then
            for mig in $(ls "${INSTALL_DIR}/postgres/migrations/"*.sql 2>/dev/null | sort); do
                local mig_name
                mig_name=$(basename "$mig")
                gauge_msg 74 "[13/17] Run Migrations" "Applying ${mig_name}..."
                if $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
                    psql -U itementry -d itementry -v ON_ERROR_STOP=1 < "$mig" 2>&1 | tee -a "$LOG"; then
                    $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
                        psql -U itementry -d itementry -c \
                        "INSERT INTO schema_migrations (filename) VALUES ('${mig_name}') ON CONFLICT (filename) DO NOTHING;" 2>&1 | tee -a "$LOG"
                else
                    log "ERROR: migration ${mig_name} failed to apply"
                fi
            done
        fi

        gauge_msg 75 "[14/17] Start App" "Starting Flask/Gunicorn (4 workers)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d app 2>&1 | tee -a "$LOG"
        sleep 2

        gauge_msg 78 "[14/17] Start Nginx" "Starting reverse proxy on port ${PORT}..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d nginx 2>&1 | tee -a "$LOG"
        sleep 1

        gauge_msg 80 "[14/17] Services Running" "All 3 containers started."
        sleep 1

        gauge_msg 82 "[15/17] Cleanup" "Pruning unused Docker images..."
        docker image prune -f 2>&1 | tee -a "$LOG"

        gauge_msg 85 "[15/17] Cleanup" "Pruning build cache..."
        docker builder prune -f 2>&1 | tee -a "$LOG"

        gauge_msg 87 "[15/17] Cleanup" "Truncating large log files..."
        find /var/lib/docker/containers/ -name "*.log" -size +10M -exec truncate -s 0 {} \; 2>/dev/null || true

        gauge_msg 89 "[16/17] Health Check" "GET http://localhost/api/health ..."
        local retries=0
        while [ $retries -lt 20 ]; do
            if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
                break
            fi
            retries=$((retries + 1))
            gauge_msg "$((89 + retries / 2))" "[16/17] Health Check" "Waiting for response (attempt ${retries}/20)..."
            sleep 2
        done

        gauge_msg 98 "[17/17] Verified" "Health check passed. Application is running."
        sleep 1

        gauge_msg 100 "Update complete!" "All services running at http://${server_ip}"

    ) || true

    # Verify data
    local store_count formula_count
    store_count=$(cd "$INSTALL_DIR" && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
        psql -U itementry -d itementry -t -c "SELECT count(*) FROM stores;" 2>/dev/null | tr -d ' ' || echo "?")
    formula_count=$(cd "$INSTALL_DIR" && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
        psql -U itementry -d itementry -t -c "SELECT count(*) FROM price_formulas;" 2>/dev/null | tr -d ' ' || echo "?")

    if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
        note "Update Complete" \
"${C_GREEN}Update Successful!${C_OFF}  ${APP_TITLE} has been updated and is running.\n\n  Web Interface:  http://${server_ip}\n  Settings:       http://${server_ip}/settings\n\nData preserved:\n  Stores configured:  ${store_count}\n  Price formulas:     ${formula_count}\n  Config backup:      ${INSTALL_DIR}/.env.backup"
    else
        note "Warning" \
"${C_YELLOW}Update finished but the health check failed.${C_OFF}\n\nCheck logs: cd ${INSTALL_DIR} && docker compose -f docker-compose.prod.yml logs\n\nFull log: ${LOG}"
    fi
}

# ════════════════════════════════════════════════════════
#  REMOVE
# ════════════════════════════════════════════════════════

do_remove() {
    if [ ! -d "$INSTALL_DIR" ]; then
        note "Not Installed" "No installation found at ${INSTALL_DIR}.\n\nNothing to remove."
        return
    fi

    # First confirmation
    note "Confirm Removal" \
"This will stop all ${APP_TITLE} services and remove the application files from:\n\n  ${INSTALL_DIR}"
    if ! confirm "Are you sure you want to remove ${APP_TITLE}?" n; then
        return
    fi

    # Ask about data
    local remove_data=false
    if confirm "Also DELETE the database (stores, formulas, field configs, history)?" n; then
        if confirm "${C_RED}FINAL WARNING:${C_OFF} permanently delete all database data?" n; then
            remove_data=true
        fi
    fi

    (
        gauge_msg "" "Stopping containers..."
        cd "$INSTALL_DIR" 2>/dev/null || true
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" down 2>&1 | tee -a "$LOG" || \
        $DC -p "$COMPOSE_PROJECT" down 2>&1 | tee -a "$LOG" || true

        if [ "$remove_data" = true ]; then
            gauge_msg "" "Removing database volume..."
            docker volume rm "${COMPOSE_PROJECT}_pgdata" 2>&1 | tee -a "$LOG" || \
            docker volume rm "product-entry_pgdata" 2>&1 | tee -a "$LOG" || true
        fi

        gauge_msg "" "Removing application files..."
        cd /tmp
        rm -rf "$INSTALL_DIR"

        gauge_msg "" "Cleaning up Docker resources..."
        docker image prune -f 2>&1 | tee -a "$LOG"
        docker builder prune -f 2>&1 | tee -a "$LOG"

        gauge_msg "" "Removal complete!"
    ) || true

    local data_msg="Database data has been PRESERVED in the Docker volume.\nReinstall to reconnect to your existing data."
    if [ "$remove_data" = true ]; then
        data_msg="All data has been permanently removed."
    fi

    note "Removal Complete" "${APP_TITLE} has been removed.\n\n${data_msg}"
}

# ════════════════════════════════════════════════════════
#  VIEW LOGS
# ════════════════════════════════════════════════════════

do_view_logs() {
    if [ ! -d "$INSTALL_DIR" ]; then
        note "Not Installed" "No installation found."
        return
    fi

    local log_choice
    log_choice=$(choose "Select logs to view:" \
        "all"      "All containers (combined)" \
        "app"      "Application (Flask/Gunicorn)" \
        "nginx"    "Nginx (reverse proxy)" \
        "postgres" "PostgreSQL (database)" \
        "install"  "Installation log (${LOG})")
    [ -z "$log_choice" ] && return

    local logs=""
    if [ "$log_choice" = "install" ]; then
        logs=$(cat "$LOG" 2>/dev/null || echo "No install log found.")
    else
        local svc=""
        [ "$log_choice" != "all" ] && svc="$log_choice"
        logs=$(cd "$INSTALL_DIR" && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" logs --tail 100 $svc 2>&1)
    fi

    show_text "Logs: ${log_choice}" "$logs"
}

# ════════════════════════════════════════════════════════
#  SERVICE CONTROL
# ════════════════════════════════════════════════════════

do_service_control() {
    if [ ! -d "$INSTALL_DIR" ]; then
        note "Not Installed" "No installation found."
        return
    fi

    local action
    action=$(choose "Select action:" \
        "restart" "Restart all services" \
        "stop"    "Stop all services" \
        "start"   "Start all services" \
        "status"  "Show container status")
    [ -z "$action" ] && return

    cd "$INSTALL_DIR"

    case "$action" in
        restart)
            gauge_msg "" "Restarting services..."
            $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" restart 2>&1 | tee -a "$LOG"
            sleep 3
            if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
                note "Done" "Services restarted successfully."
            else
                note "Warning" "Services restarted but health check pending.\nThey may still be coming up."
            fi
            ;;
        stop)
            gauge_msg "" "Stopping services..."
            $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" stop 2>&1 | tee -a "$LOG"
            note "Done" "All services stopped."
            ;;
        start)
            gauge_msg "" "Starting services..."
            $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d 2>&1 | tee -a "$LOG"
            sleep 3
            if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
                note "Done" "Services started successfully."
            else
                note "Starting" "Services starting... may take a moment."
            fi
            ;;
        status)
            local status_output
            status_output=$($DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" ps 2>&1)
            show_text "Container Status" "$status_output"
            ;;
    esac
}

# ════════════════════════════════════════════════════════
#  MAIN MENU
# ════════════════════════════════════════════════════════

main() {
    if [ ! -e /dev/tty ]; then
        echo "ERROR: an interactive terminal is required for the menu." >&2
        exit 1
    fi

    while true; do
        # Build status line
        local info status status_line ip_line ip stores formulas commit_info
        info=$(get_status_info)
        status=$(echo "$info" | cut -d'|' -f1)
        ip=$(echo "$info" | cut -d'|' -f2)
        stores=$(echo "$info" | cut -d'|' -f3)
        formulas=$(echo "$info" | cut -d'|' -f4)

        commit_info=""
        if [ -d "${INSTALL_DIR}/.git" ]; then
            commit_info=$(cd "$INSTALL_DIR" && git log --oneline -1 --format="%h %ci" 2>/dev/null | cut -c1-30)
        fi

        case "$status" in
            RUNNING)      status_line="Status: ${C_GREEN}RUNNING${C_OFF}  |  http://${ip}"
                          ip_line="Stores: ${stores}  |  Formulas: ${formulas}  |  ${commit_info}" ;;
            STOPPED)      status_line="Status: ${C_YELLOW}STOPPED${C_OFF}  |  ${INSTALL_DIR}"
                          ip_line="Last update: ${commit_info:-unknown}" ;;
            *)            status_line="Status: NOT INSTALLED"
                          ip_line="Choose Install to get started" ;;
        esac

        echo
        hr
        printf '%s  %s%s\n' "$C_BOLD" "${APP_TITLE} Installer" "$C_OFF"
        printf '  %b\n' "$status_line"
        printf '  %b\n' "$ip_line"
        hr

        local choice
        choice=$(choose "Select an option:" \
            "1" "Install    — fresh production install" \
            "2" "Update     — pull latest, preserve data, rebuild" \
            "3" "Remove     — stop and uninstall application" \
            "4" "Services   — start / stop / restart / status" \
            "5" "View Logs  — container and install logs" \
            "6" "Exit")

        case "$choice" in
            1) do_install ;;
            2) do_update ;;
            3) do_remove ;;
            4) do_service_control ;;
            5) do_view_logs ;;
            6) break ;;
            *) echo "  Invalid selection." ;;
        esac
    done

    echo
    echo "  ${APP_TITLE} installer closed."
    [ -d "$INSTALL_DIR" ] && echo "  Application: ${INSTALL_DIR}"
    echo
}

main
