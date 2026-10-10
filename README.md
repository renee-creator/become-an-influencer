# Become an Influencer — Live Beta

A temporary in-memory 15-minute multiplayer party game. Node.js + Express + Socket.IO.

## Render
Create a new **Web Service** linked to this GitHub repository. Runtime: Node. Build: `npm install`. Start: `npm start`. Health check: `/health`.

Visit the deployed URL to create a room, open the projector view from the host dashboard, and join from phones using the room QR.

## Limitations
Early private-test build: no authentication beyond the host key; data resets on restart; uploaded media is stored on the instance filesystem and can disappear after redeployment; 10 MB upload limit; no content moderation dashboard yet; no production abuse controls. Use only with trusted adult participants. The host must retain the browser tab holding the host key. Do not use for public events or sensitive media.
