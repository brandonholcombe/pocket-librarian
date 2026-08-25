#!/bin/zsh
# Build + push the image and roll the deployment on tow-c1.
set -euo pipefail
cd "$(dirname "$0")/.."

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/linode-config}"
IMAGE=bholcombe/pocket-librarian-bot:latest

docker buildx build --platform linux/amd64 -t "$IMAGE" --push .
kubectl apply -f K8s/app.yaml
kubectl -n pocket-librarian rollout restart deploy/pocket-librarian
kubectl -n pocket-librarian rollout status deploy/pocket-librarian --timeout=180s
