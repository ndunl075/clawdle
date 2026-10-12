# Windows installation

Use a versioned installer from this repository's GitHub Releases after release
verification is complete. An unsigned installer may trigger Windows trust
warnings. Compare its version and SHA-256 checksum to the published release.
Clawdle does not require a paid signing service or store membership.

The standard NSIS installer bundles the game, dictionary, and native bridge.
A computer without WebView2 may need to download Microsoft's runtime. The
separately labeled offline installer bundles that runtime and is the appropriate
variant for a clean disconnected computer. Do not describe the standard
installer as guaranteed offline on a computer missing WebView2.

Launch Clawdle and play Daily or Endless immediately. Claude Code is optional.
To connect, open Beat Claude and choose Connect Claude. Select global settings
or a project explicitly, then install the local hooks. Refresh the Claude
session after installation. Check connection reports without exposing tokens.

Automatic racing and always-on-top are opt-in. Agent permissions stay in
Claude's interface. Closing a game preserves its progress; when background
integration is enabled, close hides the game to its tray. Explicit Quit stops
the receiver and interrupts remaining competitive timing conservatively.

No development tools are needed to run the packaged application. Development
builds require Node/pnpm, Rust, MSVC build tools, and WebView2 as described by
Tauri. Native packaging and clean-machine smoke checks are separate acceptance
steps, recorded in the verification ledger.
