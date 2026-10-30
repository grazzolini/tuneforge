use std::{fmt, ptr, slice};

#[repr(C)]
struct Buffer {
    data: *mut u8,
    length: usize,
}
unsafe extern "C" {
    fn tf_music_core_api_version() -> u32;
    fn tf_music_core_abi_version() -> u32;
    fn tf_music_core_schema_version() -> u32;
    fn tf_music_core_corpus_version() -> u32;
    fn tf_music_core_call(request: *const u8, length: usize, output: *mut Buffer) -> i32;
    fn tf_music_core_buffer_free(output: *mut Buffer);
}
impl Drop for Buffer {
    fn drop(&mut self) {
        unsafe {
            tf_music_core_buffer_free(self);
        }
    }
}
#[derive(Debug)]
pub struct Error {
    pub status: i32,
    pub detail: String,
}
impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "music-core {}: {}", self.status, self.detail)
    }
}
impl std::error::Error for Error {}

pub fn versions() -> [u32; 4] {
    unsafe {
        [
            tf_music_core_api_version(),
            tf_music_core_abi_version(),
            tf_music_core_schema_version(),
            tf_music_core_corpus_version(),
        ]
    }
}
/// Raw named-operation transport preserves JSON integer/float and object-entry provenance.
pub fn call_json(request: &str) -> Result<String, Error> {
    if versions() != [1, 1, 1, 1] {
        return Err(Error {
            status: -1,
            detail: "incompatible core contract".into(),
        });
    }
    let mut output = Buffer {
        data: ptr::null_mut(),
        length: 0,
    };
    let status = unsafe { tf_music_core_call(request.as_ptr(), request.len(), &mut output) };
    let bytes = if output.data.is_null() {
        &[][..]
    } else {
        unsafe { slice::from_raw_parts(output.data, output.length) }
    };
    let text = std::str::from_utf8(bytes)
        .map_err(|error| Error {
            status: -1,
            detail: error.to_string(),
        })?
        .to_owned();
    if status != 0 {
        return Err(Error {
            status,
            detail: text,
        });
    }
    Ok(text)
}
#[cfg(test)]
mod tests {
    #[test]
    fn raw_transport_preserves_object_entry_order() {
        let request = r#"{"apiVersion":1,"schemaVersion":1,"operation":"normalizeObserved","input":{"G":[{"positions":["x","3","2","0","1","0"]}],"C":[{"positions":["x","3","2","0","1","0"]}]}}"#;
        let response: serde_json::Value =
            serde_json::from_str(&super::call_json(request).unwrap()).unwrap();
        let result = &response["result"];
        assert_eq!(result[0]["chordLabel"], "G");
        assert_eq!(result[0]["rank"], 1000);
        assert_eq!(result[1]["chordLabel"], "C");
        assert_eq!(result[1]["rank"], 1001);
    }
}
