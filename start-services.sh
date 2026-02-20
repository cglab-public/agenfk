#!/bin/bash
# Kill background jobs on exit
trap "exit" INT TERM
trap "kill 0" EXIT

echo "Starting API Server on port 3000..."
export AGENFK_DB_PATH="$DB_PATH"
node packages/server/dist/server.js > .agenfk/api.log 2>&1 &
API_PID=$!

echo "Starting UI on port 5173..."
cd packages/ui && npm run dev > ../../.agenfk/ui.log 2>&1 &
UI_PID=$!

echo "Services started."
echo "API: http://localhost:3000"
echo "UI:  http://localhost:5173"
echo "Database: $AGENFK_DB_PATH"
echo "Logs are in .agenfk/*.log"
echo "Press Ctrl+C to stop both services."

# Wait a moment for UI server to boot
sleep 2

# Attempt to open browser
if grep -qEi "(Microsoft|WSL)" /proc/version &> /dev/null; then
    explorer.exe "http://localhost:5173" > /dev/null 2>&1 || true
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "http://localhost:5173" > /dev/null 2>&1 || true
elif [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:5173" > /dev/null 2>&1 || true
fi

wait
