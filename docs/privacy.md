# Local by design

Clawdle does not use an account, analytics, advertisements, a cloud database, or
a model API. Ordinary gameplay uses bundled assets and local storage.

Desktop data resides in the OS user's application data directory. Browser data
resides in IndexedDB. These are separate profiles, with no synchronization.

The Claude bridge reads stdin only to extract allowlisted lifecycle metadata.
It discards prompts, response content, tool input/output, notification messages,
and transcript paths. It never opens a transcript. Sanitized session and turn
identifiers are local correlation data, not published identities.

The native journal orders sanitized events and player commands. The receiver is
authenticated, local-only, bounded, and unavailable to browser gameplay. Local
software running as the same OS user is outside this security boundary.

Sharing is explicit copying of an emoji grid. It excludes the answer and agent
metadata. Exports exclude connection secrets and replace local session identity
with export-local aliases. Exports never restore a live connection.

Settings can export games and reset statistics. Resetting statistics preserves
active puzzles and the daily unique key. Clearing all application data is a
separate operation. Removing hooks does not erase unrelated Claude settings.

Explicitly clicked documentation and release links use the network. Developer
dependency installation and maintainer releases are not gameplay operations.
