# Name and domain

Checked 2026-09-10. **Nothing here is a guess** — every line was answered by the
authoritative registry over whois, and the method notes at the bottom explain
why that distinction turned out to matter.

## Recommendation

### `cut.film`

Three letters. "Cut" is the most basic verb in editing and the word a director
says out loud, and the domain reads as a finished phrase rather than a name with
a suffix bolted on. It is the shortest thing available that means something.

The cost of it: **there is no `.com` to pair with it.** `cut.com`, `cutfilm.com`,
`getcut.com`, `trycut.com`, `cutapp.com` and `cuthq.com` are all registered. A
product on `cut.film` lives on `.film` alone.

## Everything found available

All confirmed against `whois.nic.film`, which answers `No Data Found` for an
unregistered name.

| domain | why it fits |
|---|---|
| **`cut.film`** | the editing verb, and the word on set |
| `rec.film` | recording-first, but the app is an editor too |
| `one.film` | gestures at "one take", needs the rest of the sentence |
| `cue.film` | a cue is a mark, not a cut |
| `set.film` | reads as a film set, or as a verb — ambiguous |
| `mux.film` | accurate (muxing is literally what the exporter does) but technical, and Mux is an established video company |
| `take.film` | strong; a take is exactly what this records |
| `sync.film` | matches the linked-clip guarantee, but generic |
| `reel.film` | slightly redundant — a reel is film |
| `roll.film` | "roll" is the instruction to start |
| `rush.film` | rushes are the raw footage; nice, but obscure outside the trade |
| `shot.film` · `trim.film` · `edit.film` · `gate.film` | available, weaker |
| `onetake.film` · `cutline.film` | longer, both free |

Also free, and not recommended: `cutrol.com`, `slatebin.com`.

## Not available

Short is genuinely exhausted. Every one of these is registered:

- **`.com`** — slate, rush, take, roll, reel, gate, cue, kino, clip, trim,
  splice, cutline, rushes, onetake, cutly, takes, frameup, slatecam, getslate,
  useslate, slatehq, rollcam, oneroll, picturelock, tailslate, trimbin, rushbin,
  takebin, clipbin, klokk, trakk, onclock, kine, reev, cutli, cutlo, cutro,
  kinly, klipp, reelo, rolla, slato, synco, takro, vidro, clappr, cutr, cutt,
  kutt, reelr, slat, takr, syncly, takely, slatly
- **`.app`** — kine, klok, klokk, trakk, reev, vell, roka, rushes, kino, cutt,
  clapr, slat, sticks, kutt, onset, lockstep
- **`.io`** — slate, take, rush *(an RDAP redirector reported these free; whois
  showed all three registered)*
- **`.video`** — slate, rushes, kino, cue, mark, sync, lock, mux, onset, cutt,
  sticks, dailies, lumo, filo, vela, cut, lockstep
- **`.cam`** — slate, roll, reel, take, clap, kino, rushes, mux, sync, lock,
  head, tail, lumo
- **`.studio`** — slate, rushes, cutt
- **`.film`** — slate, clap, kino, clip, raw, tape
- **short ccTLDs** — `cut.to`, `cut.sh`, `cut.gg`, `take.to`, `reel.to`,
  `roll.to`

## The one thing still to check

**Price.** `.film` is run by the Motion Picture Domain Registry and is not a
budget TLD; three- and four-letter dictionary words are frequently flagged as
registry premium, which can mean several hundred to several thousand a year
rather than the standard fee. whois does not expose pricing, so this has to be
confirmed at a registrar before committing to the name. Treat "available" here
as "not registered", which is not the same as "cheap".

## Method, and a trap worth remembering

Availability was read from **whois against each registry's own server**, not
from a redirector.

Two ways of getting this wrong both showed up in one session:

1. **`rdap.org` returns 404 for TLDs it does not serve**, which looks exactly
   like "available". It reported `slate.io`, `take.io` and `rush.io` free; whois
   showed registrations dating back to 2014.
2. **The `whois` client falls back to IANA when a registry rate-limits it**, and
   then answers with information about the *TLD* rather than the domain. That
   output contains a line beginning `domain:`, so a naive parse reads it as
   either taken or free depending on which pattern it checks first. The fix is
   to name the server: `whois -h whois.nic.film cut.film`.

Anything above marked available was confirmed by the second method.
