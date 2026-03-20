#!/bin/bash
set -euo pipefail

REGION=${1:-$(aws configure get region)}
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STACK_NAME=${2:-kodi-training}
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kodi-training"

echo "=== Building ARM64 Docker image ==="
docker build --platform linux/arm64 -t kodi-training .

echo "=== Logging in to ECR ==="
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "=== Pushing to ECR ==="
docker tag kodi-training:latest "${ECR_URI}:latest"
docker push "${ECR_URI}:latest"

echo "=== Image pushed to ${ECR_URI}:latest ==="

echo ""
echo "=== Writing aws-config.json from CloudFormation outputs ==="
OUTPUTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query 'Stacks[0].Outputs' --output json --region "$REGION")

node -e "
const outputs = JSON.parse(process.argv[1]);
const get = key => outputs.find(o => o.OutputKey === key).OutputValue;
const config = {
  bucket: get('BucketName'),
  cluster: get('ClusterArn'),
  taskDefinition: get('TaskDefinitionArn'),
  region: get('Region')
};
require('fs').writeFileSync('aws-config.json', JSON.stringify(config, null, 2));
console.log('aws-config.json created:', JSON.stringify(config, null, 2));
" "$OUTPUTS"

echo ""
echo "=== Done! Cloud processing is ready. ==="
