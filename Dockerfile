FROM nginx:alpine

COPY index.html app.js style.css bragi.png /usr/share/nginx/html/
COPY configure-server.sh /docker-entrypoint.d/40-configure-server.sh
RUN chmod 755 /docker-entrypoint.d/40-configure-server.sh

EXPOSE 80
