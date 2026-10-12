# Offline dictionary provenance

The source archive is an unmodified `git archive --format=zip` of English
Speller Database revision `1e5b7d3a72f47a71da5d28686c1dd4b397178485`
(v2 branch). Its complete upstream Copyright notice is retained in
`assets/licenses/ESDB-Copyright.txt` and covers the generated accepted list.
The notice explicitly permits distribution of generated word lists with attribution.
American English size 70 does not invoke the size-above-80 or Australian additions;
we retain the entire notice, including those sections and WordNet, anyway.

Run `python scripts/words-generate.py` to regenerate offline, or add `--check`
to verify byte-for-byte reproduction. Python is a maintainer dependency only.
Generation extracts the archive and builds an upstream SQLite database in a
temporary directory, selects American English size 70, variant level 1, excludes
abbreviations, deaccents, and accepts only lowercase five-letter ASCII words.
It applies project exclusions and inclusions and independently curated common
answers. Source updating is an explicit maintainer action, never part of builds.

`answers-curated.txt` is an independently composed collection of everyday words,
not a scraped commercial game's answers or schedule. Every answer is accepted.
The initial schedule uses SHA-256 ordering with the public `clawdle-daily-v1:`
salt. `daily-v1.json` is now frozen; regeneration preserves its exact order.
Never append and recalculate its modulus. Its epoch is 2026-10-12 UTC.

Runtime code imports only `packages/game/src/words.generated.json`. Neither the
source archive, upstream Python tools, SQLite database, nor maintainer scripts
are imported into browser or desktop assets. Keep this import boundary intact.
