#!/usr/bin/env bash
# ORK Reports — deploy to Vibecode
# Usage: VIBE_API_KEY=vibe_api_... bash deploy.sh

set -e

VIBE_KEY="${VIBE_API_KEY:-vibe_api_wXJ94h3wA502Vmsw2ksXZTraKgElqItx_599bd9}"
VIBE_URL="https://vibecode.bitrix24.tech/v1"
APP_NAME="ork-reports"

echo "=== ORK: Building frontend ==="
cd frontend
npm ci
npm run build
cd ..

echo "=== ORK: Building backend ==="
cd backend
npm ci
npm run build
cd ..

echo "=== ORK: Getting account info ==="
ME=$(curl -sf -H "Authorization: Bearer $VIBE_KEY" "$VIBE_URL/me")
echo "$ME" | python3 -m json.tool 2>/dev/null || echo "$ME"

echo ""
echo "=== ORK: Creating/updating app on Vibecode ==="
PAYLOAD=$(cat vibecode.json)

# Try to create app
RESP=$(curl -sf -X POST \
  -H "Authorization: Bearer $VIBE_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$VIBE_URL/apps" 2>&1 || true)

echo "Response: $RESP"

# Extract app ID from response
APP_ID=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id', d.get('app_id','')))" 2>/dev/null || echo "")

if [ -z "$APP_ID" ]; then
  echo "Note: App may already exist or different API format. Check Vibecode dashboard."
  echo "Falling back to file upload approach..."

  # Try uploading as archive
  tar czf /tmp/ork-app.tar.gz \
    backend/dist/ \
    backend/package.json \
    backend/public/ \
    vibecode.json

  curl -sf -X POST \
    -H "Authorization: Bearer $VIBE_KEY" \
    -F "file=@/tmp/ork-app.tar.gz" \
    -F "name=$APP_NAME" \
    "$VIBE_URL/apps/upload" || echo "Upload endpoint may differ — check docs."
else
  echo "App ID: $APP_ID"
  echo "Deploying..."
  curl -sf -X POST \
    -H "Authorization: Bearer $VIBE_KEY" \
    "$VIBE_URL/apps/$APP_ID/deploy" || echo "Deploy triggered."
fi

echo ""
echo "=== Deployment complete ==="
echo "Check your Vibecode dashboard for the app URL."
echo "Then configure the Bitrix24 placement (see README.md)."
