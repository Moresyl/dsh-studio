fn main() {
    println!("cargo:rerun-if-env-changed=DSH_STUDIO_EDITION");
    let edition = std::env::var("DSH_STUDIO_EDITION").unwrap_or_else(|_| "lite".into());
    println!("cargo:rustc-env=DSH_STUDIO_EDITION={edition}");
    tauri_build::build();
}
