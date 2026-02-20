#!/bin/bash
# Kill background jobs on exit
trap "exit" INT TERM
trap "kill 0" EXIT

echo "Starting API Server on port 3000..."
export AGENFK_DB_PATH="$DB_PATH"
node packages/server/dist/server.js > .agenfk/api.log 2>&1 &
API_PID=$!

echo "Starting UI..."
> .agenfk/ui.log
cd packages/ui && npm run dev > ../../.agenfk/ui.log 2>&1 &
UI_PID=$!

echo "Services started."
echo "API: http://localhost:3000"
echo "Database: $AGENFK_DB_PATH"
echo "Logs are in .agenfk/*.log"
echo "Press Ctrl+C to stop both services."

# Wait a moment for UI server to boot and detect port
echo "Waiting for UI to be ready..."
UI_URL=""
for i in {1..15}; do
    if grep -q "http://localhost:" .agenfk/ui.log 2>/dev/null; then
        UI_URL=$(grep -o 'http://localhost:[0-9]*' .agenfk/ui.log | head -n 1)
        break
    fi
    sleep 1
done

if [ -z "$UI_URL" ]; then
    UI_URL="http://localhost:5173"
fi

echo "UI available at: $UI_URL"

# Attempt to open browser
if grep -qEi "(Microsoft|WSL)" /proc/version &> /dev/null; then
    explorer.exe "$UI_URL" > /dev/null 2>&1 || true
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "$UI_URL" > /dev/null 2>&1 || true
elif [[ "$OSTYPE" == "darwin"* ]]; then
    open "$UI_URL" > /dev/null 2>&1 || true
fi

wait
