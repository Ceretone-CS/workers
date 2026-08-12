#!/bin/bash
DATE_TO=$(date +%Y-%m-%d)
DATE_FROM=$(date -d "14 days ago" +%Y-%m-%d)
BODY=$(printf '{"date_from":"%s","date_to":"%s"}' "$DATE_FROM" "$DATE_TO")
curl -s --max-time 300 -X POST http://localhost:3004/sync   -H "Content-Type: application/json"   -d "$BODY"
echo
