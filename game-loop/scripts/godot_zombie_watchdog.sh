#!/usr/bin/env bash
# godot_zombie_watchdog.sh — monitor and clean stuck Godot processes inside Docker containers
#
# Runs every 60 seconds. Kills:
#   - godot processes stuck > 5 minutes (likely zombie/hung)
#   - find processes stuck > 2 minutes (repair agent death-spiral)
# Logs to /tmp/godot_watchdog.log
#
# Usage:  bash godot_zombie_watchdog.sh &

set -euo pipefail

LOG="/tmp/godot_watchdog.log"
GODOT_TIMEOUT=300   # 5 minutes
FIND_TIMEOUT=120    # 2 minutes
SLEEP_INTERVAL=60   # check every 60 seconds
ZOMBIE_WARN_THRESHOLD=50

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

kill_stuck_in_container() {
    local pattern="$1"
    local timeout="$2"
    local label="$3"

    # Get running docker containers
    local containers
    containers=$(docker ps -q 2>/dev/null || true)
    if [[ -z "$containers" ]]; then
        return
    fi

    for cid in $containers; do
        # Find PIDs matching pattern inside container
        local pids
        pids=$(docker exec "$cid" sh -c "ps aux 2>/dev/null | grep -E '$pattern' | grep -v grep | awk '{print \$2}'" 2>/dev/null || true)
        if [[ -z "$pids" ]]; then
            continue
        fi

        for pid in $pids; do
            # Get elapsed time in seconds
            local elapsed
            elapsed=$(docker exec "$cid" sh -c "ps -o etimes= -p $pid 2>/dev/null | tr -d ' '" 2>/dev/null || echo "0")
            if [[ "$elapsed" =~ ^[0-9]+$ ]] && [[ "$elapsed" -gt "$timeout" ]]; then
                log "KILL $label pid=$pid container=$cid elapsed=${elapsed}s"
                docker exec "$cid" kill -9 "$pid" 2>/dev/null || true
            fi
        done
    done
}

count_zombies() {
    local count=0
    local containers
    containers=$(docker ps -q 2>/dev/null || true)
    if [[ -z "$containers" ]]; then
        echo 0
        return
    fi
    for cid in $containers; do
        local c
        c=$(docker exec "$cid" sh -c "ps aux 2>/dev/null | grep -E 'godot' | grep -v grep | wc -l" 2>/dev/null || echo "0")
        count=$((count + c))
    done
    echo "$count"
}

# Also clean host-level stuck godot processes
kill_stuck_host() {
    local pattern="$1"
    local timeout="$2"
    local label="$3"

    local pids
    pids=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [[ -z "$pids" ]]; then
        return
    fi
    for pid in $pids; do
        local elapsed
        elapsed=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || echo "0")
        if [[ "$elapsed" =~ ^[0-9]+$ ]] && [[ "$elapsed" -gt "$timeout" ]]; then
            log "KILL host $label pid=$pid elapsed=${elapsed}s"
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
}

log "=== godot_zombie_watchdog started PID=$$ ==="

while true; do
    # Docker containers
    kill_stuck_in_container "godot" "$GODOT_TIMEOUT" "godot"
    kill_stuck_in_container "find /" "$FIND_TIMEOUT" "find"

    # Host level
    kill_stuck_host "godot" "$GODOT_TIMEOUT" "godot"
    kill_stuck_host "find /" "$FIND_TIMEOUT" "find"

    # Zombie count warning
    zc=$(count_zombies)
    if [[ "$zc" -gt "$ZOMBIE_WARN_THRESHOLD" ]]; then
        log "WARNING: $zc godot processes across containers (threshold=$ZOMBIE_WARN_THRESHOLD)"
    fi

    sleep "$SLEEP_INTERVAL"
done
