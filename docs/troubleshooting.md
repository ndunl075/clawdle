# Troubleshooting

**The game cannot save.** Check free disk space and browser storage permissions.
Do not reset data as a first remedy. An unacknowledged move is not durable;
retry after fixing storage. Export accessible data before changing profiles.

**Another browser tab is read-only.** Close the original owner tab and reload.
Only one tab can change local game state at once. Browser saves are separate
from desktop saves.

**Claude is working but no ranked race appears.** Confirm native Windows Claude
Code, the selected settings scope, and the bridge path. Refresh the Claude
session. Missing trustworthy prompt identity disables ranked racing. Session
readiness and ordinary tool activity do not start a race.

**Claude finished before the game appeared.** A short unpresented turn is
unranked. It must not become a phantom loss. A late manual join also excludes
competitive timing records.

**A race shows unknown or interrupted.** Hooks observe lifecycle events; silence
does not imply completion. A restart, sleep, or timing gap invalidates competitive
timing while preserving guesses. Continue solving casually when available.

**Hook setup reports invalid or changed settings.** Clawdle leaves the file
untouched. Correct malformed JSON or retry after your settings editor saves.
Do not replace the whole settings file with a stale backup. Removal touches
only still-matching owned handlers.

**Copying failed.** The share dialog contains selectable text for manual copy.

**Daily changed while a game was open.** Your existing game keeps its original
UTC date. Select Daily to open today's official puzzle; the original result
does not count twice.

**A download shows a Windows trust warning.** Initial releases may be unsigned.
Check the repository, release version, and checksum. There is no promise that
unsigned downloads avoid OS warnings.

**An incompatible saved profile will not open.** The startup screen preserves original storage and offers a private recovery export. Confirm explicitly before exporting: a diagnostic copy can contain local session identifiers and damaged saved fields. Keep this copy private. It excludes connection-token and endpoint files; ordinary game exports remain separate and omit raw session identities.
