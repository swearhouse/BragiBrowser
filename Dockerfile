FROM nginx:alpine

COPY index.html app.js style.css bragi.png /usr/share/nginx/html/

EXPOSE 80
