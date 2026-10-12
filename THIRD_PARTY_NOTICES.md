# Third-party notices

Clawdle application code is MIT licensed. Third-party software and dictionary
data retain their original licenses; the application license does not replace them.

The accepted-guess dictionary is generated from the English Speller Database
(formerly SCOWL), pinned at revision
`1e5b7d3a72f47a71da5d28686c1dd4b397178485` of
[en-wl/wordlist](https://github.com/en-wl/wordlist).
The complete byte-preserved [upstream Copyright notice](assets/licenses/ESDB-Copyright.txt)
ships with the app. Generation options, provenance, and file hashes are recorded
in [the manifest](assets/words/manifest.json). Curated answers and the daily
schedule are independently authored; no Wordle schedule is included.

Bundled open-source application dependencies include React, React DOM, Zustand,
Tauri, Tokio, Axum, rusqlite/SQLite, and their transitive dependencies.
The [dependency license inventory](assets/licenses/DEPENDENCIES.md) contains
package names, exact resolved versions, license declarations, repository links,
and available full license/notice texts. Regenerate it with `pnpm licenses:generate`
after changing a lockfile. Build tools may appear in this intentionally inclusive
inventory even when they are not shipped in the application.

The original Clawdle mark and icons are authored for this project. System fonts
are used without redistributing font files. Microsoft WebView2 is distributed
by the separately labeled offline installer under Microsoft's runtime terms.
