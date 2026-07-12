//! File-backed credential vault (CP3): one JSON file per credential under
//! `vault_dir`, mode 0600, written atomically (tmp + rename). `CredStore` is
//! the seam a Vaultwarden backend replaces later.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Credential {
    pub name: String,
    pub secret: String,
    /// Previous secret, kept for one rotation grace window (CP4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
    pub version: u64,
    pub created_at: String,
    pub rotated_at: Option<String>,
}

pub trait CredStore: Send {
    fn get(&self, name: &str) -> Result<Option<Credential>, String>;
    fn put(&self, cred: &Credential) -> Result<(), String>;
    fn list(&self) -> Result<Vec<String>, String>;
}

pub struct FileVault {
    dir: PathBuf,
}

/// Credential names become filenames: same canonical rule as agent handles,
/// plus ':' for scoping (e.g. `agent:janet:matrix`).
pub fn is_valid_cred_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-' | ':')
        })
        && !name.starts_with(['.', ':'])
}

impl FileVault {
    pub fn open(dir: &Path) -> Result<FileVault, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(FileVault {
            dir: dir.to_path_buf(),
        })
    }

    fn path_for(&self, name: &str) -> Result<PathBuf, String> {
        if !is_valid_cred_name(name) {
            return Err(format!("invalid credential name {name:?}"));
        }
        Ok(self.dir.join(format!("{}.json", name.replace(':', "__"))))
    }
}

impl CredStore for FileVault {
    fn get(&self, name: &str) -> Result<Option<Credential>, String> {
        let path = self.path_for(name)?;
        match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn put(&self, cred: &Credential) -> Result<(), String> {
        let path = self.path_for(&cred.name)?;
        let tmp = path.with_extension("tmp");
        let body = serde_json::to_string_pretty(cred).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    fn list(&self) -> Result<Vec<String>, String> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(&self.dir)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    names.push(stem.replace("__", ":"));
                }
            }
        }
        names.sort();
        Ok(names)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cred(name: &str) -> Credential {
        Credential {
            name: name.into(),
            secret: "s3cret".into(),
            previous: None,
            version: 1,
            created_at: "2026-07-12T11:00:00Z".into(),
            rotated_at: None,
        }
    }

    #[test]
    fn round_trip_and_list() {
        let dir = tempfile::tempdir().unwrap();
        let v = FileVault::open(dir.path()).unwrap();
        v.put(&cred("agent:janet:matrix")).unwrap();
        v.put(&cred("agent:box-a:token")).unwrap();
        let got = v.get("agent:janet:matrix").unwrap().unwrap();
        assert_eq!(got.secret, "s3cret");
        assert_eq!(v.get("missing").unwrap(), None);
        assert_eq!(
            v.list().unwrap(),
            vec!["agent:box-a:token", "agent:janet:matrix"]
        );
    }

    #[test]
    fn hostile_names_never_reach_the_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let v = FileVault::open(dir.path()).unwrap();
        for bad in ["../escape", "a/b", "", ".hidden", ":lead", "UPPER"] {
            assert!(v.get(bad).is_err(), "{bad:?} must be rejected");
            let mut c = cred("ok");
            c.name = bad.into();
            assert!(v.put(&c).is_err(), "{bad:?} must be rejected");
        }
    }

    #[cfg(unix)]
    #[test]
    fn files_are_0600_and_dir_0700() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let v = FileVault::open(dir.path()).unwrap();
        v.put(&cred("agent:janet:matrix")).unwrap();
        let dir_mode = std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        let file = dir.path().join("agent__janet__matrix.json");
        let mode = std::fs::metadata(file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
