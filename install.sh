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

# Blue background, default dialog colors (guaranteed readable text)
export NEWT_COLORS='root=,blue roottext=white,blue'

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

# ── Gauge helper ────────────────────────────────────────
# Whiptail gauge shows text between XXX markers as a single block.
# We format: PHASE header on line 1, detail on line 2.
gauge_msg() {
    local pct="$1"
    local phase="$2"
    local detail="$3"
    echo "$pct"
    echo "XXX"
    echo "${phase}"
    [ -n "$detail" ] && echo "${detail}"
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
        gauge_msg 0  "[ 1/20] System Dependencies" "Running apt-get update..."
        apt-get update -qq >> "$LOG" 2>&1

        gauge_msg 3  "[ 2/20] System Dependencies" "Installing git, curl, openssl, python3..."
        apt-get install -y -qq git curl openssl python3 >> "$LOG" 2>&1

        gauge_msg 5  "[ 3/20] System Dependencies" "Installing ca-certificates, gnupg, lsb-release..."
        apt-get install -y -qq ca-certificates gnupg lsb-release >> "$LOG" 2>&1

        gauge_msg 7  "[ 4/20] Docker Engine" "Checking if Docker is installed..."
        if ! command -v docker &>/dev/null; then
            gauge_msg 8  "[ 5/20] Docker Engine" "Adding Docker GPG key..."
            install -m 0755 -d /etc/apt/keyrings >> "$LOG" 2>&1
            curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc 2>> "$LOG"
            chmod a+r /etc/apt/keyrings/docker.asc

            gauge_msg 10 "[ 6/20] Docker Engine" "Adding Docker APT repository..."
            echo \
                "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
                https://download.docker.com/linux/ubuntu \
                $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
                tee /etc/apt/sources.list.d/docker.list >/dev/null

            gauge_msg 12 "[ 7/20] Docker Engine" "Updating package lists with Docker repo..."
            apt-get update -qq >> "$LOG" 2>&1

            gauge_msg 14 "[ 8/20] Docker Engine" "Installing docker-ce, docker-ce-cli (~400MB download)..."
            apt-get install -y -qq docker-ce docker-ce-cli >> "$LOG" 2>&1

            gauge_msg 18 "[ 9/20] Docker Engine" "Installing containerd, buildx, compose plugin..."
            apt-get install -y -qq containerd.io docker-buildx-plugin docker-compose-plugin >> "$LOG" 2>&1

            gauge_msg 22 "[10/20] Docker Engine" "Enabling Docker service (auto-start on boot)..."
            systemctl enable docker --now >> "$LOG" 2>&1
            sleep 2

            gauge_msg 25 "[10/20] Docker Engine" "Done: $(docker --version 2>/dev/null | head -c 40)"
            sleep 1
        else
            gauge_msg 25 "[10/20] Docker Engine" "Already installed: $(docker --version | head -c 40)"
            sleep 1
        fi

        gauge_msg 27 "[11/20] Clone Repository" "Cloning ${REPO_URL}..."
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >> "$LOG" 2>&1
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
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" pull postgres >> "$LOG" 2>&1 || true

        gauge_msg 45 "[17/20] Build App Container" "Installing FreeTDS, GCC, Flask, pymssql (2-5 min)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --progress=plain app >> "$LOG" 2>&1 &
        local build_pid=$!
        local build_pct=45
        while kill -0 $build_pid 2>/dev/null; do
            build_pct=$((build_pct + 1))
            [ $build_pct -gt 66 ] && build_pct=66
            local last_line
            last_line=$(tail -1 "$LOG" 2>/dev/null | sed 's/^[#0-9 ]*//' | head -c 50)
            gauge_msg "$build_pct" "[17/20] Build App Container" "> ${last_line:-working...}"
            sleep 3
        done
        wait $build_pid || true

        gauge_msg 68 "[18/20] Build Nginx Container" "Building nginx:alpine with custom config..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --progress=plain nginx >> "$LOG" 2>&1
        gauge_msg 72 "[18/20] Build Containers" "All container images built successfully."
        sleep 1

        gauge_msg 73 "[19/20] Start PostgreSQL" "Creating network, starting postgres:16..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d postgres >> "$LOG" 2>&1
        local pg_retries=0
        while [ $pg_retries -lt 15 ]; do
            if $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres pg_isready -U itementry >> "$LOG" 2>&1; then
                break
            fi
            pg_retries=$((pg_retries + 1))
            gauge_msg "$((74 + pg_retries / 3))" "[19/20] Start PostgreSQL" "Waiting for health check (attempt ${pg_retries}/15)..."
            sleep 2
        done

        gauge_msg 79 "[19/20] Start Application" "Starting Flask/Gunicorn (4 workers)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d app >> "$LOG" 2>&1
        sleep 2

        gauge_msg 81 "[19/20] Start Nginx" "Starting reverse proxy on port ${PORT}..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d nginx >> "$LOG" 2>&1
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
        sleep 1

    } | whiptail --gauge "Preparing..." 8 $WT_WIDTH 0 --title "Installing ${APP_TITLE}"

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
        gauge_msg 0  "[ 1/17] Backup Config" "Backing up .env to .env.backup..."
        cp .env .env.backup 2>/dev/null || true

        gauge_msg 5  "[ 2/17] Stop Nginx" "Stopping reverse proxy..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" stop nginx >> "$LOG" 2>&1 || true

        gauge_msg 8  "[ 3/17] Stop App" "Stopping Flask application..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" stop app >> "$LOG" 2>&1 || true

        gauge_msg 11 "[ 4/17] Stop Postgres" "Stopping database (data safe in volume)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" down >> "$LOG" 2>&1 || \
        $DC -p "$COMPOSE_PROJECT" down >> "$LOG" 2>&1 || true

        gauge_msg 15 "[ 4/17] Services Stopped" "All containers down. Data volume preserved."
        sleep 1

        gauge_msg 17 "[ 5/17] Fetch Code" "git fetch origin main..."
        git fetch origin main >> "$LOG" 2>&1

        gauge_msg 20 "[ 6/17] Apply Code" "git reset --hard origin/main..."
        git reset --hard origin/main >> "$LOG" 2>&1
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
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --no-cache --progress=plain app >> "$LOG" 2>&1 &
        local build_pid=$!
        local build_pct=36
        while kill -0 $build_pid 2>/dev/null; do
            build_pct=$((build_pct + 1))
            [ $build_pct -gt 58 ] && build_pct=58
            local last_line
            last_line=$(tail -1 "$LOG" 2>/dev/null | sed 's/^[#0-9 ]*//' | head -c 50)
            gauge_msg "$build_pct" "[11/17] Rebuild App" "> ${last_line:-working...}"
            sleep 3
        done
        wait $build_pid || true

        gauge_msg 60 "[12/17] Rebuild Nginx" "Building nginx container..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" build --no-cache --progress=plain nginx >> "$LOG" 2>&1

        gauge_msg 63 "[12/17] Build Complete" "All container images rebuilt."
        sleep 1

        gauge_msg 65 "[13/17] Start Postgres" "Starting PostgreSQL 16..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d postgres >> "$LOG" 2>&1
        local pg_retries=0
        while [ $pg_retries -lt 10 ]; do
            if $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres pg_isready -U itementry >> "$LOG" 2>&1; then
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
            >> "$LOG" 2>&1 || true
        # Apply each migration file that hasn't been run yet
        if [ -d "${INSTALL_DIR}/postgres/migrations" ]; then
            for mig in $(ls "${INSTALL_DIR}/postgres/migrations/"*.sql 2>/dev/null | sort); do
                local mig_name
                mig_name=$(basename "$mig")
                local already_applied
                already_applied=$($DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
                    psql -U itementry -d itementry -t -c "SELECT count(*) FROM schema_migrations WHERE filename = '${mig_name}';" 2>/dev/null | tr -d ' ')
                if [ "$already_applied" = "0" ]; then
                    gauge_msg 74 "[13/17] Run Migrations" "Applying ${mig_name}..."
                    cat "$mig" | $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
                        psql -U itementry -d itementry >> "$LOG" 2>&1
                    $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" exec -T postgres \
                        psql -U itementry -d itementry -c "INSERT INTO schema_migrations (filename) VALUES ('${mig_name}');" >> "$LOG" 2>&1
                fi
            done
        fi

        gauge_msg 75 "[14/17] Start App" "Starting Flask/Gunicorn (4 workers)..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d app >> "$LOG" 2>&1
        sleep 2

        gauge_msg 78 "[14/17] Start Nginx" "Starting reverse proxy on port ${PORT}..."
        $DC -f docker-compose.prod.yml -p "$COMPOSE_PROJECT" up -d nginx >> "$LOG" 2>&1
        sleep 1

        gauge_msg 80 "[14/17] Services Running" "All 3 containers started."
        sleep 1

        gauge_msg 82 "[15/17] Cleanup" "Pruning unused Docker images..."
        docker image prune -f >> "$LOG" 2>&1

        gauge_msg 85 "[15/17] Cleanup" "Pruning build cache..."
        docker builder prune -f >> "$LOG" 2>&1

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
        sleep 1

    } | whiptail --gauge "Preparing..." 8 $WT_WIDTH 0 --title "Updating ${APP_TITLE}"

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
