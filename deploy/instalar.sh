#!/bin/bash
# Instala o actualiza Panel Nube en Amazon Linux 2023.
# Uso: sudo bash instalar.sh <carpeta-con-app-y-deploy>
# Requiere /etc/panel-nube.env creado antes (ver app/.env.example).
set -euo pipefail

SRC="${1:-.}"
DEST=/opt/panel-nube

dnf install -y -q python3 python3-pip nginx

# Si Apache ocupa el puerto 80, se detiene para que nginx lo use
if systemctl is-active --quiet httpd; then
  systemctl disable --now httpd
fi

id panelnube &>/dev/null || useradd --system --no-create-home --shell /sbin/nologin panelnube

mkdir -p "$DEST"
cp -r "$SRC/app/." "$DEST/"
python3 -m venv "$DEST/venv"
"$DEST/venv/bin/pip" install -q --upgrade pip
"$DEST/venv/bin/pip" install -q -r "$DEST/requirements.txt"
chown -R panelnube:panelnube "$DEST"
chmod -R a+rX "$DEST/static"
chmod 711 "$DEST"

chown root:panelnube /etc/panel-nube.env
chmod 640 /etc/panel-nube.env

cp "$SRC/deploy/panel-nube.service" /etc/systemd/system/panel-nube.service
cp "$SRC/deploy/panel-nube.nginx.conf" /etc/nginx/conf.d/panel-nube.conf

systemctl daemon-reload
systemctl enable --now panel-nube
systemctl restart panel-nube
nginx -t
systemctl enable --now nginx
systemctl reload nginx

sleep 2
curl -s -o /dev/null -w "login HTTP %{http_code}\n" http://127.0.0.1/login
