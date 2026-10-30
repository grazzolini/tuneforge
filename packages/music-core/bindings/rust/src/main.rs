use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.expect("read request");
        // Add only the transport envelope; leave request JSON numeric tokens untouched.
        let request = format!(
            "{{\"apiVersion\":1,\"schemaVersion\":1,{}",
            line.trim().strip_prefix('{').expect("request object")
        );
        match tuneforge_music_core::call_json(&request) {
            Ok(value) => {
                let response: std::collections::HashMap<&str, &serde_json::value::RawValue> =
                    serde_json::from_str(&value).expect("response envelope");
                println!("{}", response["result"].get());
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
}
