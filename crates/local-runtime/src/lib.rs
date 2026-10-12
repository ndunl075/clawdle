pub mod commands;
pub mod private;
pub mod receiver;
pub mod repository;
pub mod settings;
pub use repository::{Checkpoint, JournalEntry, Repository, ResultRecord, RuntimeSnapshot};
pub fn data_dir(development: bool) -> std::path::PathBuf {
    if std::env::var_os("CLAWDLE_TEST_MODE").as_deref() == Some(std::ffi::OsStr::new("1")) {
        if let Some(path) = std::env::var_os("CLAWDLE_DATA_DIR")
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_absolute() && p.parent().is_some())
        {
            return path;
        }
    }
    directories::ProjectDirs::from(
        "org",
        "Clawdle",
        if development { "ClawdleDev" } else { "Clawdle" },
    )
    .expect("user data directory")
    .data_local_dir()
    .into()
}
