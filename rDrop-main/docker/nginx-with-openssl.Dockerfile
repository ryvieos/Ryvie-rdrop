FROM nginx:alpine

RUN apk add --no-cache openssl \
    && mkdir -p /etc/ssl/certs /mnt/openssl

# Copy static site assets
COPY client /usr/share/nginx/html

# Copy nginx configuration
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy OpenSSL helper scripts/configs and ensure executables have the right mode
COPY docker/openssl /mnt/openssl
RUN chmod +x /mnt/openssl/*.sh

# Pre-create cert directory so entrypoint script can drop files there
RUN mkdir -p /etc/ssl/certs