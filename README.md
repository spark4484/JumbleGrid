# JumbleGrid

Self-hosted online Boggle game. Zero dependencies — just Node.js.

## Run it

```bash
node server.js
```

Then open http://localhost:3000.

## Play with a friend over the internet

In a second terminal:

```bash
cloudflared tunnel --url http://localhost:3000
```

Send your friend the `https://….trycloudflare.com` URL it prints, plus your room
code. You both join the same room code and play on the same board.

## How it plays

- **Join** with a name and a shared room code.
- Pick **4×4** (classic dice) or **5×5** (Big Boggle dice) and hit **Start round**.
- 3-minute rounds. Build words by **tapping adjacent tiles** (tap the last tile
  again to undo) or just **type** and press Enter.
- Words are claimed **first-come-first-served** — the shared *Words used* panel
  on the right shows every word claimed so far, who got it, and its points.
- Minimum word length: 3 letters on 4×4, 4 letters on 5×5. Scoring is standard
  Boggle: 3–4 letters = 1, 5 = 2, 6 = 3, 7 = 5, 8+ = 11. "Qu" counts as two letters.
- Scores carry across rounds in the same room.

## Dictionary (optional)

Out of the box there's no dictionary — any word that can be traced on the grid
is accepted, and either player can hit **✕** next to a word to veto a fake
(points are taken back). For automatic checking, drop a word list next to
`server.js`:

```bash
curl -o words.txt https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt
```

Restart the server and invalid words will be rejected automatically.
