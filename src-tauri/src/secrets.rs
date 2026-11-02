//! Encryption at rest for `settings.json`.
//!
//! The settings file contains API keys. Storing them as plaintext means any
//! process running as the same user (or a stolen disk) can read them. On
//! Windows we wrap the whole document with DPAPI, which ties decryption to the
//! current user account without asking for a password.

/// Marks a file written by this module; legacy plaintext files have no header.
const MAGIC: &str = "CMENC1:";

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) {
        return Err("加密的设置文件已损坏".to_string());
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    let bytes = text.as_bytes();
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char)
            .to_digit(16)
            .ok_or("加密的设置文件已损坏")?;
        let lo = (pair[1] as char)
            .to_digit(16)
            .ok_or("加密的设置文件已损坏")?;
        out.push((hi * 16 + lo) as u8);
    }
    Ok(out)
}

#[cfg(target_os = "windows")]
mod dpapi {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    /// Do not show a UI prompt; this runs from a background save.
    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    fn blob(data: &mut [u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_mut_ptr(),
        }
    }

    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let mut input = plaintext.to_vec();
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &blob(&mut input),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("无法加密设置文件".to_string());
        }
        let bytes = unsafe {
            let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
            let copy = slice.to_vec();
            LocalFree(output.pbData as *mut std::ffi::c_void);
            copy
        };
        Ok(bytes)
    }

    pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        let mut input = ciphertext.to_vec();
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &blob(&mut input),
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("无法解密设置文件".to_string());
        }
        let bytes = unsafe {
            let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
            let copy = slice.to_vec();
            LocalFree(output.pbData as *mut std::ffi::c_void);
            copy
        };
        Ok(bytes)
    }
}

#[cfg(not(target_os = "windows"))]
mod dpapi {
    pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plaintext.to_vec())
    }

    pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        Ok(ciphertext.to_vec())
    }
}

/// Encode a settings document for disk. Output is ASCII (hex), so the file can
/// still be inspected with a text editor, but not read without the user's
/// Windows credentials.
pub fn seal_settings(plaintext: &str) -> Result<String, String> {
    let encrypted = dpapi::protect(plaintext.as_bytes())?;
    Ok(format!("{MAGIC}{}", hex_encode(&encrypted)))
}

/// Decode a settings file. Accepts legacy plaintext documents so an upgrade
/// does not lose the user's existing profiles and keys.
pub fn open_settings(raw: &str) -> Result<String, String> {
    let Some(encoded) = raw.strip_prefix(MAGIC) else {
        return Ok(raw.to_string());
    };
    let encrypted = hex_decode(encoded.trim())?;
    let plaintext = dpapi::unprotect(&encrypted)?;
    String::from_utf8(plaintext).map_err(|error| format!("设置文件编码无效：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_binary() {
        let bytes = vec![0u8, 1, 15, 16, 127, 128, 255];
        assert_eq!(hex_decode(&hex_encode(&bytes)).unwrap(), bytes);
    }

    #[test]
    fn hex_rejects_odd_length_and_bad_digits() {
        assert!(hex_decode("abc").is_err());
        assert!(hex_decode("zz").is_err());
    }

    #[test]
    fn legacy_plaintext_is_passed_through() {
        let raw = r#"{"aiProfiles":[]}"#;
        assert_eq!(open_settings(raw).unwrap(), raw);
    }

    #[test]
    fn sealed_document_round_trips() {
        let plaintext = r#"{"apiKey":"sk-secret"}"#;
        let sealed = seal_settings(plaintext).unwrap();
        assert!(sealed.starts_with(MAGIC));
        assert!(!sealed.contains("sk-secret"));
        assert_eq!(open_settings(&sealed).unwrap(), plaintext);
    }
}
