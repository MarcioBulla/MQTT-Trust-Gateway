FROM docker.io/nginx:1.27-alpine

RUN apk add --no-cache gettext
COPY mqtt-trust-gateway.conf.template /etc/nginx/templates/mqtt-trust-gateway.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
