#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/deploy.sh <stage>
# Example: ./scripts/deploy.sh dev

STAGE=${1:-}
if [ -z "$STAGE" ]; then
  echo "Usage: $0 <stage>"
  echo "Example: $0 dev"
  exit 1
fi

echo "==> Deploy script starting (stage=$STAGE)"

tmp_config=""
cleanup_tmp() {
  if [ -n "$tmp_config" ] && [ -f "$tmp_config" ]; then
    rm -f "$tmp_config"
  fi
}
trap cleanup_tmp EXIT

# Ensure node modules
if [ ! -d node_modules ]; then
  echo "Installing npm dependencies (node_modules not found)..."
  npm ci
else
  echo "node_modules present — skipping install. To force reinstall remove node_modules and run again."
fi

# Check env using project's checker
if npm run -s check-env; then
  echo "Environment check passed"
else
  echo "Environment check failed — aborting"
  exit 1
fi

# Check serverless.yml runtime compatibility
runtime_line=$(grep -E "^\s*runtime:" serverless.yml || true)
if echo "$runtime_line" | grep -q "nodejs22.x"; then
  echo "Warning: serverless.yml uses nodejs22.x which some Serverless versions don't accept."
  echo "Creating temporary serverless config using nodejs20.x for this deploy..."
  tmp_config=$(mktemp /tmp/serverless.yml.XXXX)
  sed 's/nodejs22.x/nodejs20.x/g' serverless.yml > "$tmp_config"
  CONFIG_ARG=(--config "$tmp_config")
else
  CONFIG_ARG=()
fi

# Generate OpenAPI (try to produce JSON output first)
echo "Generating OpenAPI specification..."
set +e
npx serverless openapi generate --format json "${CONFIG_ARG[@]}"
gen_status=$?
if [ $gen_status -ne 0 ]; then
  echo "-- failed generating with --format json, trying with --output openapi.json"
  npx serverless openapi generate --output openapi.json "${CONFIG_ARG[@]}"
  gen_status=$?
fi
set -e
if [ $gen_status -ne 0 ]; then
  echo "OpenAPI generation failed. Check plugin/preset compatibility. Aborting."
  exit 1
fi

# Ensure openapi.json exists for postprocessing
if [ ! -f openapi.json ]; then
  if [ -f openapi.yml ]; then
    echo "openapi.json not found but openapi.yml exists — attempting to convert to JSON..."
    # Try to convert YAML to JSON using node (no extra deps if Node already has 'yaml' not available).
    # We'll try a lightweight conversion using a small JS snippet that requires 'js-yaml' if available.
    node -e "try{const fs=require('fs'); const jsYaml=require('js-yaml'); const y=jsYaml.load(fs.readFileSync('openapi.yml','utf8')); fs.writeFileSync('openapi.json', JSON.stringify(y,null,2)); console.log('Converted openapi.yml -> openapi.json');}catch(e){console.error('Conversion failed: '+e.message); process.exit(1);}"
    if [ ! -f openapi.json ]; then
      echo "Conversion to openapi.json failed — postprocess requires openapi.json. Aborting."
      exit 1
    fi
  else
    echo "openapi.json not found after generation — aborting."
    exit 1
  fi
fi

# Run postprocess script (if present)
if [ -f ./scripts/postprocess-openapi.js ]; then
  echo "Running postprocess-openapi.js"
  node ./scripts/postprocess-openapi.js
else
  echo "No postprocess-openapi.js found — skipping postprocess step"
fi

# Finally deploy
echo "Deploying with Serverless Framework (stage=$STAGE)..."
# Use npx to ensure local serverless is used
npx serverless deploy --stage "$STAGE" "${CONFIG_ARG[@]}"

echo "Deploy finished"
exit 0
