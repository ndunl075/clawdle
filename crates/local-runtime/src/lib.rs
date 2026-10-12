pub mod commands;
pub mod private;
pub mod receiver;
pub mod repository;
pub mod settings;
pub use repository::{Checkpoint, JournalEntry, Repository, ResultRecord, RuntimeSnapshot};
pub fn data_dir(development: bool) -> std::path::PathBuf {
    directories::ProjectDirs::from(
        "org",
        "Clawdle",
        if development { "ClawdleDev" } else { "Clawdle" },
    )
    .expect("user data directory")
    .data_local_dir()
    .into()
}
