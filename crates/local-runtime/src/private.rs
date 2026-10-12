use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Endpoint {
    pub protocol_version: u8,
    pub port: u16,
    pub runtime_epoch: String,
    pub pid: u32,
    pub development: bool,
}
pub fn reject_links(path: &Path) -> std::io::Result<()> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(m) => {
                if m.file_type().is_symlink() {
                    return Err(std::io::Error::other("symlink_rejected"));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if m.file_attributes() & 0x400 != 0 {
                        return Err(std::io::Error::other("reparse_rejected"));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
pub fn secure_dir(path: &Path) -> std::io::Result<()> {
    reject_links(path)?;
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        secure_acl(path, true)?;
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            reject_links(&entry.path())?;
            if entry.file_type()?.is_file() {
                secure_acl(&entry.path(), false)?;
            } else if entry.file_type()?.is_dir() {
                secure_acl(&entry.path(), true)?;
            }
        }
    }
    Ok(())
}
#[cfg(windows)]
fn secure_acl(path: &Path, directory: bool) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
                SE_FILE_OBJECT,
            },
            GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION,
        },
    };
    let sddl = if directory {
        "D:P(A;OICI;FA;;;OW)"
    } else {
        "D:P(A;;FA;;;OW)"
    };
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = std::ptr::null_mut();
        if GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) == 0 {
            LocalFree(descriptor);
            return Err(std::io::Error::last_os_error());
        }
        let error = SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null_mut(),
        );
        LocalFree(descriptor);
        if error != 0 {
            return Err(std::io::Error::from_raw_os_error(error as i32));
        }
    }
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    reject_links(path)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&temp)?;
        #[cfg(windows)]
        secure_acl(&temp, false)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }
        #[cfg(not(windows))]
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn token(dir: &Path) -> std::io::Result<String> {
    let path = dir.join("token");
    reject_links(&path)?;
    match fs::read_to_string(&path) {
        Ok(s) if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) => Ok(s),
        Ok(_) => Err(std::io::Error::other("invalid_token")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            let s = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
            atomic_write(&path, s.as_bytes())?;
            Ok(s)
        }
        Err(e) => Err(e),
    }
}
pub fn endpoint(dir: &Path) -> std::io::Result<Endpoint> {
    let path = dir.join("endpoint.json");
    reject_links(&path)?;
    let m = fs::metadata(&path)?;
    if m.len() > 2048 {
        return Err(std::io::Error::other("endpoint_size"));
    }
    let e: Endpoint = serde_json::from_slice(&fs::read(path)?)
        .map_err(|_| std::io::Error::other("endpoint_json"))?;
    if e.protocol_version != 1 || e.port == 0 || uuid::Uuid::parse_str(&e.runtime_epoch).is_err() {
        return Err(std::io::Error::other("endpoint_version"));
    }
    Ok(e)
}
pub fn mailbox_write(
    dir: &Path,
    event: &clawdle_agent_adapters::AgentEvent,
) -> std::io::Result<()> {
    let path = dir.join("mailbox");
    reject_links(&path)?;
    fs::create_dir_all(&path)?;
    if fs::read_dir(&path)?.take(257).count() >= 256 {
        return Err(std::io::Error::other("mailbox_full"));
    }
    atomic_write(
        &path.join(format!("{}.json", event.event_id)),
        &serde_json::to_vec(event)?,
    )
}
pub fn mailbox_drain(
    dir: &Path,
) -> std::io::Result<Vec<(PathBuf, clawdle_agent_adapters::AgentEvent)>> {
    let path = dir.join("mailbox");
    reject_links(&path)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut entries = vec![];
    for entry in fs::read_dir(path)?.take(256) {
        let entry = entry?;
        let p = entry.path();
        if reject_links(&p).is_err() {
            continue;
        }
        let m = entry.metadata()?;
        if !m.is_file() {
            continue;
        }
        if m.len() > 8192 {
            let _ = fs::remove_file(&p);
            continue;
        }
        let event = fs::read(&p)
            .ok()
            .and_then(|b| serde_json::from_slice::<clawdle_agent_adapters::AgentEvent>(&b).ok());
        let fresh = m
            .modified()?
            .elapsed()
            .map(|d| d.as_secs() <= 30)
            .unwrap_or(false);
        if let Some(e) = event.filter(|e| fresh && e.validate().is_ok()) {
            entries.push((p, e));
        } else {
            let _ = fs::remove_file(p);
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn removes_preexisting_broad_explicit_acl() {
        use std::os::windows::process::CommandExt;
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("private");
        fs::create_dir(&path).unwrap();
        let status = std::process::Command::new("icacls.exe")
            .arg(&path)
            .args(["/grant", "*S-1-1-0:(OI)(CI)F"])
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        secure_dir(&path).unwrap();
        let acl = std::process::Command::new("icacls.exe")
            .arg(&path)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&acl.stdout).contains("Everyone"));
        token(&path).unwrap();
    }
    #[test]
    fn atomic_private_data() {
        let d = tempfile::tempdir().unwrap();
        secure_dir(d.path()).unwrap();
        let first = token(d.path()).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(first, token(d.path()).unwrap());
        atomic_write(&d.path().join("state"), b"one").unwrap();
        atomic_write(&d.path().join("state"), b"two").unwrap();
        assert_eq!(fs::read(d.path().join("state")).unwrap(), b"two");
    }
    #[test]
    #[cfg(windows)]
    fn rejects_windows_reparse_mailbox_and_endpoint_ancestors() {
        use std::os::windows::process::CommandExt;
        let d = tempfile::tempdir().unwrap();
        let target = d.path().join("target");
        fs::create_dir(&target).unwrap();
        let link = d.path().join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "junction fixture creation failed");
        assert!(reject_links(&link.join("endpoint.json")).is_err());
        assert!(atomic_write(&link.join("token"), b"secret").is_err());
        assert!(mailbox_drain(&link).is_err());
        fs::remove_dir(&link).unwrap();
        assert!(target.exists());
    }
}
