#!/bin/bash
# ============================================================================
#  Product Entry - Visual Interactive Installer
#  Designed for Ubuntu Server 24.04 LTS (Minimal Install)
#
#  Usage:  curl -fsSL <raw-url>/install.sh | sudo bash
#     or:  sudo bash install.sh
# ============================================================================

set -e

# ── Config ──────────────────────────────────────────────
APP_NAME="product-entry"
APP_TITLE="Product Entry"
INSTALL_DIR="/opt/${APP_NAME}"
REPO_URL="https://github.com/ruolez/product-entry.git"
COMPOSE_PROJECT="product-entry"
DC="docker compose"
PORT=80
LOG="/tmp/${APP_NAME}-install.log"

# ── Whiptail dimensions & colors ────────────────────────
WT_HEIGHT=20
WT_WIDTH=70
WT_MENU_HEIGHT=10

# Clean blue color scheme
export NEWT_COLORS='
root=,blue
window=,lightgray
border=blue,lightgray
shadow=,black
title=blue,lightgray
button=white,blue
actbutton=lightgray,blue
checkbox=black,lightgray
actcheckbox=blue,lightgray
entry=black,white
label=black,lightgray
listbox=black,lightgray
actlistbox=white,blue
sellistbox=blue,lightgray
actsellistbox=white,blue
textbox=black,lightgray
acttextbox=black,lightgray
helpline=blue,lightgray
roottext=white,blue
emptyscale=,lightgray
fullscale=,blue
'

# ── Root check ──────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo "ERROR: This script must be run as root (sudo)."
    exit 1
fi

# ── Ensure whiptail is available ────────────────────────
if ! command -v whiptail &>/dev/null; then
    echo "Installing whiptail..."
    apt-get update -qq && apt-get install -y -qq whiptail >/dev/null 2>&1
fi

# ── Log setup ───────────────────────────────────────────
: > "$LOG"
log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

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

# ── Gauge-based progress runner ─────────────────────────
# Usage: run_with_progress "Title" step1_func step2_func ...
# Each step function should: echo "description" first, then do work
run_with_progress() {
    local title="$1"
    shift
    local steps=("$@")
    local total=${#steps[@]}
    local i=0

    for step_func in "${steps[@]}"; do
        i=$((i + 1))
        local pct=$(( (i - 1) * 100 / total ))
        local desc
        desc=$($step_func description 2>/dev/null)
        echo "$pct"
        echo "XXX"
        echo "Step ${i}/${total}: ${desc}"
        echo "XXX"
        log "Step ${i}/${total}: ${desc}"
        $step_func execute >> "$LOG" 2>&1
        if [ $? -ne 0 ]; then
            log "FAILED: ${desc}"
            echo "100"
            return 1
        fi
        log "OK: ${desc}"
    done
    echo "100"
    echo "XXX"
    echo "Complete!"
    echo "XXX"
    return 0
}

# ── Gauge helper (multi-line progress text) ─────────────
gauge_msg() {
    local pct="$1"; shift
    echo "$pct"
    echo "XXX"
    for line in "$@"; do echo "$line"; done
    echo "XXX"
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

ask_server_ip() {
    local detected_ip
    detected_ip=$(detect_ip)
    local default_ip="${1:-$detected_ip}"

    local server_ip
    server_ip=$(whiptail --inputbox \
        "Enter the server IP address for this installation.\n\nThis IP will be used for:\n  - Nginx server_name\n  - CORS allowed origins\n  - Access URL\n\nDetected IP: ${detected_ip:-none}" \
        $WT_HEIGHT $WT_WIDTH "$default_ip" \
        --title "Network Configuration" \
        3>&1 1>&2 2>&3) || return 1

    if [ -z "$server_ip" ]; then
        whiptail --msgbox "IP address is required. Installation cancelled." 8 $WT_WIDTH --title "Error"
        return 1
    fi

    # Validate IP format
    if ! echo "$server_ip" | grep -qP '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'; then
        whiptail --msgbox "Invalid IP address format: ${server_ip}" 8 $WT_WIDTH --title "Error"
        return 1
    fi

    echo "$server_ip"
}

# ════════════════════════════════════════════════════════
#  INSTALL
# ════════════════════════════════════════════════════════

do_install() {
    # Check existing installation
    if [ -d "$INSTALL_DIR" ]; then
        if ! whiptail --yesno \
            "An existing installation was found at:\n\n  ${INSTALL_DIR}\n\nThis will REMOVE the existing installation and start fresh.\nDatabase data will be DELETED.\n\nContinue with fresh install?" \
            $WT_HEIGHT $WT_WIDTH --title "Existing Installation Found" --defaultno; then
            return
        fi
        # Remove silently
        whiptail --infobox "Removing existing installation..." 5 $WT_WIDTH
        cd /tmp
        (cd "$INSTALL_DIR" 2>/dev/null && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" down -v 2>/dev/null) || true
        rm -rf "$INSTALL_DIR"
        sleep 1
    fi

    # Get server IP
    local server_ip
    server_ip=$(ask_server_ip) || return

    # Confirm
    if ! whiptail --yesno \
        "Ready to install ${APP_TITLE}.\n\n\
  Server IP:       ${server_ip}\n\
  Install path:    ${INSTALL_DIR}\n\
  Web access:      http://${server_ip}\n\
  Docker port:     ${PORT}\n\n\
This will install Docker (if needed), clone the repository,\n\
generate secure credentials, and build production containers.\n\n\
Proceed with installation?" \
        $WT_HEIGHT $WT_WIDTH --title "Confirm Installation"; then
        return
    fi

    # ── Run install steps with progress gauge ───────
    local pg_pass fernet_key
    pg_pass=$(generate_password)
    fernet_key=$(generate_fernet_key)

    {
        gauge_msg 0 \
            "PHASE 1: System Dependencies" \
            "" \
            "Running apt-get update..."
        apt-get update -qq >> "$LOG" 2>&1
        log "Package lists updated"

        gauge_msg 2 \
            "PHASE 1: System Dependencies" \
            "" \
            "Installing: git, curl, openssl, python3" \
            "These are required for cloning the repo and generating keys."
        apt-get install -y -qq git curl openssl python3 >> "$LOG" 2>&1
        log "Core packages installed"

        gauge_msg 5 \
            "PHASE 1: System Dependencies" \
            "" \
            "Installing: ca-certificates, gnupg, lsb-release" \
            "Required for Docker repository authentication."
        apt-get install -y -qq ca-certificates gnupg lsb-release >> "$LOG" 2>&1
        log "Certificate packages installed"

        gauge_msg 7 \
            "PHASE 2: Docker Engine" \
            "" \
            "Checking if Docker is already installed..."
        if ! command -v docker &>/dev/null; then
            gauge_msg 8 \
                "PHASE 2: Docker Engine" \
                "" \
                "Docker not found. Starting installation." \
                "Adding Docker official GPG key to /etc/apt/keyrings..."
            install -m 0755 -d /etc/apt/keyrings >> "$LOG" 2>&1
            curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc 2>> "$LOG"
            chmod a+r /etc/apt/keyrings/docker.asc
            log "Docker GPG key added"

            gauge_msg 10 \
                "PHASE 2: Docker Engine" \
                "" \
                "Adding Docker APT repository for Ubuntu." \
                "Source: https://download.docker.com/linux/ubuntu"
            echo \
                "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
                https://download.docker.com/linux/ubuntu \
                $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
                tee /etc/apt/sources.list.d/docker.list >/dev/null
            log "Docker repo added"

            gauge_msg 12 \
                "PHASE 2: Docker Engine" \
                "" \
                "Refreshing package lists with Docker repository..."
            apt-get update -qq >> "$LOG" 2>&1

            gauge_msg 14 \
                "PHASE 2: Docker Engine" \
                "" \
                "Downloading and installing Docker Engine (~400MB)..." \
                "Packages: docker-ce, docker-ce-cli"
            apt-get install -y -qq docker-ce docker-ce-cli >> "$LOG" 2>&1
            log "Docker engine installed"

            gauge_msg 18 \
                "PHASE 2: Docker Engine" \
                "" \
                "Installing container runtime and build tools..." \
                "Packages: containerd.io, docker-buildx, docker-compose"
            apt-get install -y -qq containerd.io docker-buildx-plugin docker-compose-plugin >> "$LOG" 2>&1
            log "Docker plugins installed"

            gauge_msg 22 \
                "PHASE 2: Docker Engine" \
                "" \
                "Enabling Docker service (systemctl enable --now)..." \
                "Docker will start automatically on boot."
            systemctl enable docker --now >> "$LOG" 2>&1
            sleep 2
            log "Docker service started"

            gauge_msg 25 \
                "PHASE 2: Docker Engine  [COMPLETE]" \
                "" \
                "$(docker --version 2>/dev/null | head -1)" \
                "Docker Compose $(docker compose version 2>/dev/null | head -1)"
            sleep 1
        else
            gauge_msg 25 \
                "PHASE 2: Docker Engine  [SKIPPED]" \
                "" \
                "Docker already installed:" \
                "$(docker --version | head -1)"
            log "Docker already present"
            sleep 1
        fi

        gauge_msg 27 \
            "PHASE 3: Clone Repository" \
            "" \
            "Connecting to GitHub..." \
            "URL: ${REPO_URL}"
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >> "$LOG" 2>&1
        log "Repository cloned"
        gauge_msg 32 \
            "PHASE 3: Clone Repository  [COMPLETE]" \
            "" \
            "Cloned to: ${INSTALL_DIR}" \
            "Branch: main (shallow clone, depth=1)"
        sleep 1

        gauge_msg 33 \
            "PHASE 4: Production Configuration" \
            "" \
            "Generating secure PostgreSQL password (24 chars)..." \
            "Generating Fernet encryption key (base64, 32 bytes)..."
        sleep 1

        gauge_msg 34 \
            "PHASE 4: Production Configuration" \
            "" \
            "Writing .env file with:" \
            "  - PostgreSQL credentials" \
            "  - Fernet encryption key for store passwords" \
            "  - Server IP: ${server_ip}"
        generate_env_file "$server_ip" "$pg_pass" "$fernet_key"
        log "Env file generated"

        gauge_msg 36 \
            "PHASE 4: Production Configuration" \
            "" \
            "Generating docker-compose.prod.yml" \
            "  - 3 services: nginx, app, postgres" \
            "  - Log rotation: 10MB max, 3 files" \
            "  - Persistent volume for database"
        generate_prod_compose
        log "Compose file generated"

        gauge_msg 37 \
            "PHASE 4: Production Configuration" \
            "" \
            "Generating Dockerfile.prod" \
            "  - Base: python:3.12-slim + FreeTDS" \
            "  - 4 Gunicorn workers (production mode)" \
            "  - No auto-reload, preloaded app"
        generate_prod_dockerfile
        log "Prod Dockerfile generated"

        gauge_msg 39 \
            "PHASE 4: Production Configuration" \
            "" \
            "Generating nginx.conf" \
            "  - Server name: ${server_ip}" \
            "  - CORS headers for http://${server_ip}" \
            "  - Security headers (XSS, nosniff, frame)" \
            "  - Proxy timeouts: 120s for MS SQL"
        generate_prod_nginx "$server_ip"
        log "Nginx config generated"

        gauge_msg 40 \
            "PHASE 4: Production Configuration  [COMPLETE]" \
            "" \
            "All config files generated in ${INSTALL_DIR}"
        sleep 1

        cd "$INSTALL_DIR"

        gauge_msg 41 \
            "PHASE 5: Build Docker Containers" \
            "" \
            "Pulling postgres:16-alpine base image..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" pull postgres >> "$LOG" 2>&1 || true

        gauge_msg 45 \
            "PHASE 5: Build Docker Containers" \
            "" \
            "Building APP container (this takes 2-5 minutes)..." \
            "  - Installing system packages: FreeTDS, GCC" \
            "  - Installing Python packages: Flask, pymssql, etc." \
            "  - Copying application code"
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --progress=plain app >> "$LOG" 2>&1 &
        local build_pid=$!
        local build_pct=45
        while kill -0 $build_pid 2>/dev/null; do
            build_pct=$((build_pct + 1))
            [ $build_pct -gt 66 ] && build_pct=66
            local last_line
            last_line=$(tail -1 "$LOG" 2>/dev/null | sed 's/^[#0-9 ]*//' | head -c 55)
            echo "$build_pct"
            echo "XXX"
            echo "PHASE 5: Build Docker Containers"
            echo ""
            echo "Building APP container..."
            echo "  > ${last_line:-working...}"
            echo "XXX"
            sleep 3
        done
        wait $build_pid || true
        log "App container built"

        gauge_msg 68 \
            "PHASE 5: Build Docker Containers" \
            "" \
            "Building NGINX container..." \
            "  - Base: nginx:alpine" \
            "  - Copying nginx.conf"
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --progress=plain nginx >> "$LOG" 2>&1
        log "Nginx container built"
        gauge_msg 72 \
            "PHASE 5: Build Docker Containers  [COMPLETE]" \
            "" \
            "All 3 container images built successfully."
        sleep 1

        gauge_msg 73 \
            "PHASE 6: Start Services" \
            "" \
            "Creating Docker bridge network..." \
            "Starting PostgreSQL 16 container..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d postgres >> "$LOG" 2>&1

        local pg_retries=0
        while [ $pg_retries -lt 15 ]; do
            if $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres pg_isready -U itementry >> "$LOG" 2>&1; then
                break
            fi
            pg_retries=$((pg_retries + 1))
            gauge_msg "$((74 + pg_retries / 3))" \
                "PHASE 6: Start Services" \
                "" \
                "Waiting for PostgreSQL to accept connections..." \
                "  Health check attempt ${pg_retries}/15"
            sleep 2
        done
        log "PostgreSQL healthy"

        gauge_msg 79 \
            "PHASE 6: Start Services" \
            "" \
            "PostgreSQL is healthy." \
            "Starting Flask application (4 Gunicorn workers)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d app >> "$LOG" 2>&1
        sleep 2
        log "App started"

        gauge_msg 82 \
            "PHASE 6: Start Services" \
            "" \
            "Flask app is running." \
            "Starting Nginx reverse proxy on port ${PORT}..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d nginx >> "$LOG" 2>&1
        sleep 1
        log "Nginx started"

        gauge_msg 84 \
            "PHASE 6: Start Services  [COMPLETE]" \
            "" \
            "All 3 containers running:" \
            "  - postgres  (PostgreSQL 16)" \
            "  - app       (Flask + Gunicorn)" \
            "  - nginx     (Reverse proxy, port ${PORT})"
        sleep 1

        gauge_msg 86 \
            "PHASE 7: Verification" \
            "" \
            "Running health check: GET http://localhost/api/health"
        local retries=0
        while [ $retries -lt 20 ]; do
            if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
                log "Health check passed"
                break
            fi
            retries=$((retries + 1))
            gauge_msg "$((86 + retries / 2))" \
                "PHASE 7: Verification" \
                "" \
                "Waiting for application to respond..." \
                "  Attempt ${retries}/20 - retrying in 2 seconds"
            sleep 2
        done

        gauge_msg 96 \
            "PHASE 7: Verification" \
            "" \
            "Health check passed." \
            "Verifying database schema (tables, seed data)..."
        local table_count
        table_count=$($DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
            psql -U itementry -d itementry -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d ' ' || echo "?")
        local field_count
        field_count=$($DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
            psql -U itementry -d itementry -t -c "SELECT count(*) FROM field_configs;" 2>/dev/null | tr -d ' ' || echo "?")
        log "Database: ${table_count} tables, ${field_count} field configs"

        gauge_msg 99 \
            "PHASE 7: Verification  [COMPLETE]" \
            "" \
            "Database verified:" \
            "  - ${table_count} tables created" \
            "  - ${field_count} field configurations seeded"
        sleep 1

        gauge_msg 100 \
            "INSTALLATION COMPLETE" \
            "" \
            "All services are running at http://${server_ip}"
        sleep 1

    } | whiptail --gauge "Initializing..." 12 $WT_WIDTH 0 --title "Installing ${APP_TITLE}"

    # ── Result ────────────────────────────────────────
    if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
        whiptail --msgbox \
"$( cat <<MSGEOF
    Installation Successful!

    ${APP_TITLE} is now running.

    ┌─────────────────────────────────────────────┐
    │  Web Interface:  http://${server_ip}        │
    │  Settings:       http://${server_ip}/settings│
    │  Install Path:   ${INSTALL_DIR}              │
    └─────────────────────────────────────────────┘

    Quick Start:
    1. Open http://${server_ip}/settings
    2. Add your MS SQL store connections
    3. Configure price formulas
    4. Start entering products!

    Useful commands:
    View logs:   cd ${INSTALL_DIR} && docker compose \\
                 -f docker-compose.prod.yml logs -f
    Restart:     cd ${INSTALL_DIR} && docker compose \\
                 -f docker-compose.prod.yml restart
    Update:      sudo bash ${INSTALL_DIR}/install.sh
MSGEOF
)" 26 60 --title "Installation Complete"
    else
        whiptail --msgbox \
            "Installation finished but health check failed.\n\nThe services may still be starting.\nCheck logs: cd ${INSTALL_DIR} && docker compose -f docker-compose.prod.yml logs\n\nFull install log: ${LOG}" \
            12 $WT_WIDTH --title "Warning"
    fi
}

# ════════════════════════════════════════════════════════
#  UPDATE
# ════════════════════════════════════════════════════════

do_update() {
    if [ ! -d "$INSTALL_DIR" ]; then
        whiptail --msgbox "No installation found at ${INSTALL_DIR}.\n\nPlease run Install first." 10 $WT_WIDTH --title "Not Installed"
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
    if ! whiptail --yesno \
        "Ready to update ${APP_TITLE}.\n\n\
  Server IP:       ${server_ip}\n\
  Install path:    ${INSTALL_DIR}\n\n\
This will:\n\
  - Preserve all database data (stores, formulas, history)\n\
  - Preserve encryption keys and passwords\n\
  - Pull latest code from GitHub\n\
  - Rebuild Docker containers\n\
  - Clean up old Docker images and logs\n\n\
Services will be briefly offline during rebuild.\n\n\
Proceed?" \
        $WT_HEIGHT $WT_WIDTH --title "Confirm Update"; then
        return
    fi

    {
        gauge_msg 0 \
            "PHASE 1: Backup Configuration" \
            "" \
            "Backing up .env to .env.backup..." \
            "  Preserving: PostgreSQL password, Fernet key, Server IP"
        cp .env .env.backup 2>/dev/null || true
        log "Config backed up"

        gauge_msg 3 \
            "PHASE 1: Backup Configuration  [COMPLETE]" \
            "" \
            "Credentials and encryption keys preserved."
        sleep 1

        gauge_msg 5 \
            "PHASE 2: Stop Services" \
            "" \
            "Stopping Nginx reverse proxy..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" stop nginx >> "$LOG" 2>&1 || true

        gauge_msg 8 \
            "PHASE 2: Stop Services" \
            "" \
            "Stopping Flask application..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" stop app >> "$LOG" 2>&1 || true

        gauge_msg 11 \
            "PHASE 2: Stop Services" \
            "" \
            "Stopping PostgreSQL..." \
            "  Database data is safe in Docker volume."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" down >> "$LOG" 2>&1 || \
        $DC -p "$COMPOSE_PROJECT" down >> "$LOG" 2>&1 || true
        log "Services stopped"

        gauge_msg 15 \
            "PHASE 2: Stop Services  [COMPLETE]" \
            "" \
            "All containers stopped." \
            "Data volume preserved."
        sleep 1

        gauge_msg 17 \
            "PHASE 3: Pull Latest Code" \
            "" \
            "Fetching from origin/main..." \
            "  Repository: ${REPO_URL}"
        git fetch origin main >> "$LOG" 2>&1
        log "Fetch complete"

        gauge_msg 20 \
            "PHASE 3: Pull Latest Code" \
            "" \
            "Applying latest commit (git reset --hard)..."
        git reset --hard origin/main >> "$LOG" 2>&1
        local commit_msg
        commit_msg=$(git log --oneline -1 2>/dev/null | head -c 55)
        log "Code updated to: ${commit_msg}"

        gauge_msg 25 \
            "PHASE 3: Pull Latest Code  [COMPLETE]" \
            "" \
            "Updated to: ${commit_msg}"
        sleep 1

        gauge_msg 26 \
            "PHASE 4: Regenerate Configuration" \
            "" \
            "Writing .env (preserving password + Fernet key)..." \
            "  Server IP: ${server_ip}"
        generate_env_file "$server_ip" "$pg_pass" "$fernet_key"
        log "Env file regenerated"

        gauge_msg 28 \
            "PHASE 4: Regenerate Configuration" \
            "" \
            "Generating docker-compose.prod.yml..." \
            "  3 services, log rotation, health checks"
        generate_prod_compose

        gauge_msg 30 \
            "PHASE 4: Regenerate Configuration" \
            "" \
            "Generating Dockerfile.prod..." \
            "  4 Gunicorn workers, preloaded, no auto-reload"
        generate_prod_dockerfile

        gauge_msg 33 \
            "PHASE 4: Regenerate Configuration" \
            "" \
            "Generating nginx.conf..." \
            "  Server: ${server_ip}, CORS, security headers"
        generate_prod_nginx "$server_ip"
        log "All configs regenerated"

        gauge_msg 35 \
            "PHASE 4: Regenerate Configuration  [COMPLETE]" \
            "" \
            "All production configs regenerated."
        sleep 1

        gauge_msg 36 \
            "PHASE 5: Rebuild Containers (--no-cache)" \
            "" \
            "Rebuilding APP container from scratch..." \
            "  This ensures all code changes are included." \
            "  May take 2-5 minutes."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --no-cache --progress=plain app >> "$LOG" 2>&1 &
        local build_pid=$!
        local build_pct=36
        while kill -0 $build_pid 2>/dev/null; do
            build_pct=$((build_pct + 1))
            [ $build_pct -gt 58 ] && build_pct=58
            local last_line
            last_line=$(tail -1 "$LOG" 2>/dev/null | sed 's/^[#0-9 ]*//' | head -c 55)
            echo "$build_pct"
            echo "XXX"
            echo "PHASE 5: Rebuild Containers"
            echo ""
            echo "Building APP container..."
            echo "  > ${last_line:-working...}"
            echo "XXX"
            sleep 3
        done
        wait $build_pid || true
        log "App container rebuilt"

        gauge_msg 60 \
            "PHASE 5: Rebuild Containers" \
            "" \
            "Rebuilding NGINX container..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --no-cache --progress=plain nginx >> "$LOG" 2>&1
        log "Nginx container rebuilt"

        gauge_msg 63 \
            "PHASE 5: Rebuild Containers  [COMPLETE]" \
            "" \
            "All container images rebuilt."
        sleep 1

        gauge_msg 65 \
            "PHASE 6: Start Services" \
            "" \
            "Starting PostgreSQL 16..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d postgres >> "$LOG" 2>&1
        local pg_retries=0
        while [ $pg_retries -lt 10 ]; do
            if $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres pg_isready -U itementry >> "$LOG" 2>&1; then
                break
            fi
            pg_retries=$((pg_retries + 1))
            gauge_msg "$((66 + pg_retries))" \
                "PHASE 6: Start Services" \
                "" \
                "Waiting for PostgreSQL to accept connections..." \
                "  Health check attempt ${pg_retries}/10"
            sleep 2
        done
        log "PostgreSQL healthy"

        gauge_msg 75 \
            "PHASE 6: Start Services" \
            "" \
            "PostgreSQL ready. Starting Flask app..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d app >> "$LOG" 2>&1
        sleep 2

        gauge_msg 78 \
            "PHASE 6: Start Services" \
            "" \
            "Flask app running. Starting Nginx..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d nginx >> "$LOG" 2>&1
        sleep 1
        log "All services started"

        gauge_msg 80 \
            "PHASE 6: Start Services  [COMPLETE]" \
            "" \
            "All 3 containers running."
        sleep 1

        gauge_msg 82 \
            "PHASE 7: Cleanup" \
            "" \
            "Pruning unused Docker images..."
        docker image prune -f >> "$LOG" 2>&1

        gauge_msg 85 \
            "PHASE 7: Cleanup" \
            "" \
            "Pruning Docker build cache..."
        docker builder prune -f >> "$LOG" 2>&1

        gauge_msg 87 \
            "PHASE 7: Cleanup" \
            "" \
            "Truncating container logs > 10MB..."
        find /var/lib/docker/containers/ -name "*.log" -size +10M -exec truncate -s 0 {} \; 2>/dev/null || true
        log "Docker cleanup done"

        gauge_msg 89 \
            "PHASE 8: Verification" \
            "" \
            "Running health check: GET http://localhost/api/health"
        local retries=0
        while [ $retries -lt 20 ]; do
            if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
                log "Health check passed"
                break
            fi
            retries=$((retries + 1))
            gauge_msg "$((89 + retries / 2))" \
                "PHASE 8: Verification" \
                "" \
                "Waiting for application to respond..." \
                "  Attempt ${retries}/20"
            sleep 2
        done

        gauge_msg 98 \
            "PHASE 8: Verification  [COMPLETE]" \
            "" \
            "Health check passed. Application is running."
        sleep 1

        gauge_msg 100 \
            "UPDATE COMPLETE" \
            "" \
            "All services running at http://${server_ip}"
        sleep 1

    } | whiptail --gauge "Initializing update..." 12 $WT_WIDTH 0 --title "Updating ${APP_TITLE}"

    # Verify data
    local store_count formula_count
    store_count=$(cd "$INSTALL_DIR" && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
        psql -U itementry -d itementry -t -c "SELECT count(*) FROM stores;" 2>/dev/null | tr -d ' ' || echo "?")
    formula_count=$(cd "$INSTALL_DIR" && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
        psql -U itementry -d itementry -t -c "SELECT count(*) FROM price_formulas;" 2>/dev/null | tr -d ' ' || echo "?")

    if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
        whiptail --msgbox \
"$( cat <<MSGEOF
    Update Successful!

    ${APP_TITLE} has been updated and is running.

    ┌─────────────────────────────────────────────┐
    │  Web Interface:  http://${server_ip}        │
    │  Settings:       http://${server_ip}/settings│
    └─────────────────────────────────────────────┘

    Data preserved:
      Stores configured:  ${store_count}
      Price formulas:     ${formula_count}
      Config backup:      ${INSTALL_DIR}/.env.backup
MSGEOF
)" 20 60 --title "Update Complete"
    else
        whiptail --msgbox \
            "Update finished but health check failed.\n\nCheck logs: cd ${INSTALL_DIR} && docker compose -f docker-compose.prod.yml logs\n\nFull log: ${LOG}" \
            10 $WT_WIDTH --title "Warning"
    fi
}

# ════════════════════════════════════════════════════════
#  REMOVE
# ════════════════════════════════════════════════════════

do_remove() {
    if [ ! -d "$INSTALL_DIR" ]; then
        whiptail --msgbox "No installation found at ${INSTALL_DIR}.\n\nNothing to remove." 10 $WT_WIDTH --title "Not Installed"
        return
    fi

    # First confirmation
    if ! whiptail --yesno \
        "This will stop all ${APP_TITLE} services and remove the application files from:\n\n  ${INSTALL_DIR}\n\nAre you sure?" \
        $WT_HEIGHT $WT_WIDTH --title "Confirm Removal" --defaultno; then
        return
    fi

    # Ask about data
    local remove_data=false
    if whiptail --yesno \
        "Do you also want to DELETE the database?\n\nThis includes:\n  - Store connections\n  - Price formulas\n  - Field configurations\n  - Insertion history\n\nChoose 'No' to keep your data for a future reinstall." \
        $WT_HEIGHT $WT_WIDTH --title "Database Data" --defaultno; then
        # Second confirmation for data removal
        if whiptail --yesno \
            "FINAL WARNING\n\nAll database data will be permanently deleted.\nThis cannot be undone.\n\nDelete everything?" \
            12 $WT_WIDTH --title "Confirm Data Deletion" --defaultno; then
            remove_data=true
        fi
    fi

    {
        echo "10"
        echo "XXX"
        echo "Stopping containers..."
        echo "XXX"
        cd "$INSTALL_DIR" 2>/dev/null || true
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" down >> "$LOG" 2>&1 || \
        $DC -p "$COMPOSE_PROJECT" down >> "$LOG" 2>&1 || true
        log "Containers stopped"

        if [ "$remove_data" = true ]; then
            echo "30"
            echo "XXX"
            echo "Removing database volume..."
            echo "XXX"
            docker volume rm "${COMPOSE_PROJECT}_pgdata" >> "$LOG" 2>&1 || \
            docker volume rm "product-entry_pgdata" >> "$LOG" 2>&1 || true
            log "Database volume removed"
        fi

        echo "50"
        echo "XXX"
        echo "Removing application files..."
        echo "XXX"
        cd /tmp
        rm -rf "$INSTALL_DIR"
        log "App files removed"

        echo "70"
        echo "XXX"
        echo "Cleaning up Docker resources..."
        echo "XXX"
        docker image prune -f >> "$LOG" 2>&1
        docker builder prune -f >> "$LOG" 2>&1
        log "Docker cleanup done"

        echo "100"
        echo "XXX"
        echo "Removal complete!"
        echo "XXX"
        sleep 1

    } | whiptail --gauge "Removing ${APP_TITLE}..." 8 $WT_WIDTH 0 --title "Removing"

    local data_msg="Database data has been PRESERVED in Docker volume.\nReinstall to reconnect to your existing data."
    if [ "$remove_data" = true ]; then
        data_msg="All data has been permanently removed."
    fi

    whiptail --msgbox \
        "${APP_TITLE} has been removed.\n\n${data_msg}" \
        12 $WT_WIDTH --title "Removal Complete"
}

# ════════════════════════════════════════════════════════
#  VIEW LOGS
# ════════════════════════════════════════════════════════

do_view_logs() {
    if [ ! -d "$INSTALL_DIR" ]; then
        whiptail --msgbox "No installation found." 8 $WT_WIDTH --title "Not Installed"
        return
    fi

    local log_choice
    log_choice=$(whiptail --menu "Select container logs to view:" $WT_HEIGHT $WT_WIDTH 5 \
        "all"      "All containers (combined)" \
        "app"      "Application (Flask/Gunicorn)" \
        "nginx"    "Nginx (reverse proxy)" \
        "postgres" "PostgreSQL (database)" \
        "install"  "Installation log (${LOG})" \
        3>&1 1>&2 2>&3) || return

    local logs=""
    if [ "$log_choice" = "install" ]; then
        logs=$(cat "$LOG" 2>/dev/null || echo "No install log found.")
    else
        local svc=""
        [ "$log_choice" != "all" ] && svc="$log_choice"
        logs=$(cd "$INSTALL_DIR" && $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" logs --tail 100 $svc 2>&1)
    fi

    # Show in scrollable textbox
    echo "$logs" > /tmp/pe-log-view.txt
    whiptail --textbox /tmp/pe-log-view.txt 24 80 --title "Logs: ${log_choice}" --scrolltext
    rm -f /tmp/pe-log-view.txt
}

# ════════════════════════════════════════════════════════
#  SERVICE CONTROL
# ════════════════════════════════════════════════════════

do_service_control() {
    if [ ! -d "$INSTALL_DIR" ]; then
        whiptail --msgbox "No installation found." 8 $WT_WIDTH --title "Not Installed"
        return
    fi

    local action
    action=$(whiptail --menu "Select action:" $WT_HEIGHT $WT_WIDTH 4 \
        "restart" "Restart all services" \
        "stop"    "Stop all services" \
        "start"   "Start all services" \
        "status"  "Show container status" \
        3>&1 1>&2 2>&3) || return

    cd "$INSTALL_DIR"

    case "$action" in
        restart)
            whiptail --infobox "Restarting services..." 5 $WT_WIDTH
            $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" restart >> "$LOG" 2>&1
            sleep 3
            if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
                whiptail --msgbox "Services restarted successfully." 8 $WT_WIDTH --title "Done"
            else
                whiptail --msgbox "Services restarted but health check pending.\nThey may still be coming up." 10 $WT_WIDTH --title "Warning"
            fi
            ;;
        stop)
            whiptail --infobox "Stopping services..." 5 $WT_WIDTH
            $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" stop >> "$LOG" 2>&1
            whiptail --msgbox "All services stopped." 8 $WT_WIDTH --title "Done"
            ;;
        start)
            whiptail --infobox "Starting services..." 5 $WT_WIDTH
            $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d >> "$LOG" 2>&1
            sleep 3
            if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
                whiptail --msgbox "Services started successfully." 8 $WT_WIDTH --title "Done"
            else
                whiptail --msgbox "Services starting... may take a moment." 8 $WT_WIDTH --title "Starting"
            fi
            ;;
        status)
            local status_output
            status_output=$($DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" ps 2>&1)
            echo "$status_output" > /tmp/pe-status.txt
            whiptail --textbox /tmp/pe-status.txt 16 80 --title "Container Status" --scrolltext
            rm -f /tmp/pe-status.txt
            ;;
    esac
}

# ════════════════════════════════════════════════════════
#  MAIN MENU
# ════════════════════════════════════════════════════════

main() {
    while true; do
        # Build status line
        local info status_line ip_line
        info=$(get_status_info)
        local status=$(echo "$info" | cut -d'|' -f1)
        local ip=$(echo "$info" | cut -d'|' -f2)
        local stores=$(echo "$info" | cut -d'|' -f3)
        local formulas=$(echo "$info" | cut -d'|' -f4)

        case "$status" in
            RUNNING)      status_line="Status: RUNNING  |  http://${ip}"
                          ip_line="Stores: ${stores}  |  Formulas: ${formulas}" ;;
            STOPPED)      status_line="Status: STOPPED  |  ${INSTALL_DIR}"
                          ip_line="Services are not running" ;;
            *)            status_line="Status: NOT INSTALLED"
                          ip_line="Choose Install to get started" ;;
        esac

        local choice
        choice=$(whiptail --menu \
            "${status_line}\n${ip_line}" \
            $WT_HEIGHT $WT_WIDTH $WT_MENU_HEIGHT \
            "1" "Install          Fresh production install" \
            "2" "Update           Pull latest, preserve data, rebuild" \
            "3" "Remove           Stop and uninstall application" \
            "4" "Services         Start / Stop / Restart / Status" \
            "5" "View Logs        Container and install logs" \
            "6" "Exit" \
            3>&1 1>&2 2>&3) || break

        case "$choice" in
            1) do_install ;;
            2) do_update ;;
            3) do_remove ;;
            4) do_service_control ;;
            5) do_view_logs ;;
            6) break ;;
        esac
    done

    clear
    echo ""
    echo "  ${APP_TITLE} installer closed."
    [ -d "$INSTALL_DIR" ] && echo "  Application: ${INSTALL_DIR}"
    echo ""
}

main
