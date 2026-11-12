#!/bin/bash
# Controlla GitHub, aggiorna Alfred e lo riavvia. Va lanciato ogni 5 minuti dal Task Scheduler:
#   bash /volume1/alfred/alfred-2.0/scripts/alfred-update.sh
#
# Tutto il codice sta dentro la funzione main e lo script finisce con "exit": così Git può
# sostituire questo stesso file durante l'aggiornamento senza che bash si confonda.

main() {
    APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
    BASE_DIR="$(dirname "$APP_DIR")"
    LOG="$APP_DIR/alfred.log"                 # registro del bot
    ULOG="$BASE_DIR/alfred-update.log"        # registro dell'aggiornamento
    HEARTBEAT="$BASE_DIR/alfred-last-check.txt"
    LOCK="$BASE_DIR/alfred-update.lock"

    cd "$APP_DIR" || exit 1
    export PATH="$PATH:/usr/local/bin:/usr/bin:/bin"
    export HOME="${HOME:-/root}"

    log() { echo "[$(date '+%F %T')] $*" >> "$ULOG"; }

    # Messaggio Telegram (solo per i problemi: se tutto va bene è Alfred stesso a scrivere)
    notify() {
        local token chat
        token="$(grep -E '^TELEGRAM_BOT_TOKEN=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '"' | tr -d "'")"
        chat="$(grep -E '^ALLOWED_USER_ID=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '"' | tr -d "'")"
        if [ -n "$token" ] && [ -n "$chat" ]; then
            curl -s -m 20 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
                --data-urlencode "chat_id=${chat}" \
                --data-urlencode "text=$1" > /dev/null
        fi
    }
    scrub() { sed -E 's#(https?://)[^@/[:space:]]+@#\1***@#g'; }

    # Un solo controllo alla volta (un lock più vecchio di 20 minuti è considerato abbandonato)
    if ! mkdir "$LOCK" 2>/dev/null; then
        if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then
            log "Lock abbandonato, lo rimuovo"
            rm -rf "$LOCK"
            mkdir "$LOCK" 2>/dev/null || exit 0
        else
            exit 0
        fi
    fi
    trap 'rm -rf "$LOCK"' EXIT

    date > "$HEARTBEAT"

    # Processi del bot: "node server.js" avviati da questa cartella (non si basa sul file dei pid)
    bot_pids() {
        local d pid cmd
        for d in /proc/[0-9]*; do
            pid="${d#/proc/}"
            cmd="$(tr '\0' ' ' 2>/dev/null < "$d/cmdline")" || continue
            case "$cmd" in
                "node server.js"*|*"/node server.js"*)
                    [ "$(readlink "$d/cwd" 2>/dev/null)" = "$APP_DIR" ] && echo "$pid"
                    ;;
            esac
        done
    }

    stop_bot() {
        local pids i
        pids="$(bot_pids)"
        [ -z "$pids" ] && return 0
        kill $pids 2>/dev/null
        for i in 1 2 3 4 5 6 7 8 9 10; do
            [ -z "$(bot_pids)" ] && break
            sleep 1
        done
        pids="$(bot_pids)"
        [ -n "$pids" ] && kill -9 $pids 2>/dev/null
        return 0
    }

    start_bot() {
        if ! command -v node >/dev/null 2>&1; then
            log "ERRORE: node non trovato nel PATH"
            return 1
        fi
        nohup node server.js >> "$LOG" 2>&1 &
        echo $! > alfred.pid
        log "Alfred avviato (pid $!)"
        sleep 8
    }

    # Git rifiuta di lavorare in cartelle di un altro utente: si autorizza questa cartella
    if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$APP_DIR"; then
        git config --global --add safe.directory "$APP_DIR" 2>/dev/null
    fi

    UPDATED=0
    LOCAL="$(git rev-parse HEAD 2>&1)" || { log "ERRORE git rev-parse: $(echo "$LOCAL" | scrub)"; LOCAL=""; }

    OUT="$(git fetch origin main 2>&1)" || log "fetch FALLITO: $(echo "$OUT" | scrub | head -n 3 | tr '\n' ' ')"
    REMOTE="$(git rev-parse FETCH_HEAD 2>/dev/null)"

    if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
        log "Nuovo codice: ${LOCAL:0:7} -> ${REMOTE:0:7}"
        OUT="$(git pull --ff-only origin main 2>&1)"
        if [ $? -eq 0 ]; then
            # Le librerie si reinstallano solo se è cambiato package.json (e con un limite di tempo)
            if git diff --name-only "$LOCAL" HEAD 2>/dev/null | grep -qE '^package(-lock)?\.json$'; then
                log "package.json cambiato: npm install"
                if command -v timeout >/dev/null 2>&1; then
                    timeout 600 npm install --omit=dev >> "$LOG" 2>&1 || log "npm install FALLITO o scaduto"
                else
                    npm install --omit=dev >> "$LOG" 2>&1 || log "npm install FALLITO"
                fi
            fi
            stop_bot
            UPDATED=1
        else
            log "git pull FALLITO: $(echo "$OUT" | scrub | head -n 3 | tr '\n' ' ')"
            if [ "$(cat "$BASE_DIR/alfred-pull-failed.txt" 2>/dev/null)" != "$REMOTE" ]; then
                echo "$REMOTE" > "$BASE_DIR/alfred-pull-failed.txt"
                notify "⚠️ Su GitHub c'è codice nuovo ma non riesco ad aggiornarmi (git pull fallito). Dettagli in alfred-update.log sul NAS."
            fi
        fi
    fi

    # Più copie del bot insieme (Telegram darebbe errori e i messaggi si perderebbero): ne resta una sola
    if [ "$(bot_pids | wc -l)" -gt 1 ]; then
        log "Trovate più copie del bot: le fermo e ne riavvio una"
        stop_bot
    fi

    if [ -z "$(bot_pids)" ]; then
        start_bot
    fi

    # Se dopo un aggiornamento il bot non riparte, avvisa su Telegram (se riparte, scrive Alfred stesso)
    if [ "$UPDATED" = "1" ] && [ -z "$(bot_pids)" ]; then
        log "ERRORE: dopo l'aggiornamento Alfred non è ripartito"
        notify "⚠️ Aggiornamento applicato ma Alfred non è ripartito. Controlla alfred-update.log e alfred.log"
    fi

    # Il registro non cresce all'infinito
    if [ -f "$ULOG" ] && [ "$(wc -l < "$ULOG")" -gt 2000 ]; then
        tail -n 500 "$ULOG" > "$ULOG.tmp" && mv "$ULOG.tmp" "$ULOG"
    fi
}

main "$@"
exit 0
