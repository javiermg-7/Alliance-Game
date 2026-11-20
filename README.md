# Alliance-Game
An online tactical multiplayer game. 🤝⚔️

## Rules

- Each player is placed at random cells, starting with 1 point.
  | Action | Cost | Meaning |
  |--|--|--|
  | `MOVE` ➡️| 1 | Moving 1 cell in any direction (adjactent and diagonal) |
  | `ATACK` ⚔️| 1 | Hit another player (-1 life) in the player range |
  | `SEND POINTS` 💌| n | Send n points to a player in range |
  | `EXTEND RANGE` 🏹| 2 | Extends the player range 1 cell |
  | `HEAL` ❤️| 3 | Heal 1 life. Can't have more than the starting lives |

- Everyone sees where the other players are.
- Only the player see their own lives, points and range.
- Last player standing wins.  


## Run

```
node server.js
```

Open http://localhost:3000. Share the URL (or deploy to any Node host) so friends can join.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `GRID_SIZE` | 16 | Board is GRID_SIZE x GRID_SIZE |
| `MAX_PLAYERS` | 16 | Game starts automatically when this many have joined |
| `AP_INTERVAL_SECONDS` | 600 | Every player alive gets 1 action point this often |
| `LIVES` | 3 | Starting (and maximum) lives |
| `START_RANGE` | 2 | Starting range (in cells, diagonals count) |
| `PORT` | 3000 | HTTP port |
| `ADMIN_PASSWORD` | random, printed at startup | Needed to start early / reset |

Example quick test game: `MAX_PLAYERS=4 AP_INTERVAL_SECONDS=10 ADMIN_PASSWORD=secret node server.js`

Costs live in `envConfig()` in `server.js` (`costs: { move:1, attack:1, range:3, heal:3 }`).


## Notes

- The server is authoritative: all rules are checked server-side, and other players' lives/points are never sent to your browser.
- State is saved to `data.json`, so the game survives restarts. Delete it (or use Admin > Reset) for a new game.
- Passwords are hashed with scrypt. Use HTTPS if you host it publicly.
