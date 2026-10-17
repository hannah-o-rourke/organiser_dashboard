git pull
npm i
npm run build
npm run build-web
cp engagement.json ../tool-hub/registrations/engagement.json
pm2 restart engagement
