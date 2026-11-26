# Pool

Online 8-ball pool. Create a room, send the 4-letter code to a friend, and play on two screens. There's also a pass-and-play mode for one device.

## Run it locally

```
npm install
npm start
```

Then open http://localhost:3000. Open a second tab to test joining a room.

## How it works

- `public/core.js` has the table, physics and 8-ball rules. It runs on the server and in the browser.
  The physics only uses `+ - * /` and `Math.sqrt`, so every browser gets exactly the same result.
  Balls skid after being struck, then roll: each ball tracks its spin, so follow, draw and stun
  come from the same friction model, and object balls lose a little speed as they start rolling.
- `server.js` (Express + Socket.IO) holds the rooms. It checks each shot, simulates it, applies the rules and
  sends the shot and the result to both players. Their browsers then animate the same shot.
- `public/client.js` handles drawing, controls, sound, the home screen and the match lobby.
  Balls are shaded per pixel from a 3D orientation that turns as they roll, so numbers and stripes
  move like the real thing.
- `public/index.html` + `public/style.css` are the broadcast-style UI. The font (Archivo, variable width) is self-hosted in `public/fonts`.

Deploys to Render with `render.yaml` (free web service, Singapore region).
