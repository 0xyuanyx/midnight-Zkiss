#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 ca-certificates curl
systemctl enable --now docker
install -d -m 700 /opt/zkiss/config
install -d /opt/zkiss/app
# Proof generation and wallet sync can temporarily peak above idle memory.
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
printf 'vm.swappiness=10\n' > /etc/sysctl.d/90-zkiss.conf
sysctl --system >/dev/null
touch /opt/zkiss/bootstrap-ready
