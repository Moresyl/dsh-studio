//! Immutable local raster resources shared by document copies and undo snapshots.
use std::collections::HashSet;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{directory, failure, WRITES};
use crate::error::Result;

const INPUT_LIMIT: usize = 16 * 1024 * 1024;
const ENCODED_INPUT_LIMIT: usize = INPUT_LIMIT.div_ceil(3) * 4;
const ASSET_LIMIT: usize = 8 * 1024 * 1024;
const DOCUMENT_LIMIT: usize = 16 * 1024 * 1024;
const LIBRARY_LIMIT: u64 = 256 * 1024 * 1024;
const DIMENSION: u32 = 8192;
const PIXELS: u64 = 16 * 1024 * 1024;
static IMPORTING: AtomicBool = AtomicBool::new(false);

struct ImportGuard;

impl ImportGuard {
    fn acquire() -> Result<Self> {
        IMPORTING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| failure("another image import is already running"))
    }
}

impl Drop for ImportGuard {
    fn drop(&mut self) {
        IMPORTING.store(false, Ordering::SeqCst);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    id: String,
    width: u32,
    height: u32,
    bytes: usize,
    data_url: String,
}

fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0
        || height == 0
        || width > DIMENSION
        || height > DIMENSION
        || u64::from(width) * u64::from(height) > PIXELS
    {
        return Err(failure(
            "image exceeds 8192 pixels per side or 16 megapixels",
        ));
    }
    Ok(())
}

fn normalize(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() > INPUT_LIMIT {
        return Err(failure("image input exceeds 16 MiB"));
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| failure("could not identify image format"))?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
    ) {
        return Err(failure("choose a PNG, JPEG or WebP image"));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(DIMENSION);
    limits.max_image_height = Some(DIMENSION);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits.clone());
    let animated = match reader.format() {
        Some(ImageFormat::Png) => {
            image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes), limits)
                .and_then(|decoder| decoder.is_apng())
                .map_err(|_| failure("could not inspect PNG frames"))?
        }
        Some(ImageFormat::WebP) => image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
            .map_err(|_| failure("could not inspect WebP frames"))?
            .has_animation(),
        _ => false,
    };
    if animated {
        return Err(failure(
            "animated images are not supported; choose a static image",
        ));
    }
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| failure("could not decode image header"))?;
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    let orientation = decoder
        .orientation()
        .map_err(|_| failure("invalid image orientation"))?;
    let mut image =
        DynamicImage::from_decoder(decoder).map_err(|_| failure("could not decode image"))?;
    image.apply_orientation(orientation);
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| failure("could not normalize image"))?;
    let bytes = output.into_inner();
    if bytes.len() > ASSET_LIMIT {
        return Err(failure(
            "normalized image exceeds 8 MiB; use a smaller image",
        ));
    }
    Ok(bytes)
}

fn asset_directory(root: &Path) -> Result<PathBuf> {
    directory(root)?;
    let assets = root.join("assets");
    directory(&assets)?;
    Ok(assets)
}

fn asset_path(root: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(failure("invalid image resource identity"));
    }
    Ok(asset_directory(root)?.join(format!("{id}.png")))
}

fn read(root: &Path, id: &str) -> Result<Vec<u8>> {
    let path = asset_path(root, id)?;
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| failure("image resource is missing"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(failure("image resource must be a regular local file"));
    }
    let bytes = crate::bounded_file::read(&path, ASSET_LIMIT)
        .map_err(|_| failure("could not read bounded image resource"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != id {
        return Err(failure(
            "image resource is damaged; original document preserved",
        ));
    }
    Ok(bytes)
}

fn resource_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png)
        .into_dimensions()
        .map_err(|_| failure("invalid image resource header"))?;
    dimensions(width, height)?;
    Ok((width, height))
}

fn payload(id: String, bytes: &[u8]) -> Result<Asset> {
    let (width, height) = resource_dimensions(bytes)?;
    Ok(Asset {
        id,
        width,
        height,
        bytes: bytes.len(),
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(bytes)),
    })
}

fn store_normalized(root: &Path, bytes: Vec<u8>) -> Result<Asset> {
    let id = format!("{:x}", Sha256::digest(&bytes));
    let _guard = WRITES
        .lock()
        .map_err(|_| failure("storage is unavailable"))?;
    let path = asset_path(root, &id)?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => return payload(id.clone(), &read(root, &id)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(failure("could not inspect image resource")),
    }
    let mut total = bytes.len() as u64;
    for (index, entry) in std::fs::read_dir(asset_directory(root)?)
        .map_err(|_| failure("could not inspect image library"))?
        .enumerate()
    {
        if index >= 999 {
            return Err(failure("image library has reached its resource limit"));
        }
        let entry = entry.map_err(|_| failure("could not inspect image library entry"))?;
        let metadata = entry
            .metadata()
            .map_err(|_| failure("could not inspect image library size"))?;
        total = total.saturating_add(metadata.len());
        if total > LIBRARY_LIMIT {
            return Err(failure("image library exceeds 256 MiB"));
        }
    }
    crate::atomic::write(&path, &bytes).map_err(|_| failure("could not save image resource"))?;
    payload(id, &bytes)
}

#[cfg(test)]
fn store(root: &Path, input: &[u8]) -> Result<Asset> {
    store_normalized(root, normalize(input)?)
}

fn attachment_bytes(attachment_id: &str, data: &str) -> Result<Vec<u8>> {
    let id = attachment_id
        .strip_prefix("sha256:")
        .filter(|id| valid_id(id))
        .ok_or_else(|| failure("invalid attachment identity"))?;
    if data.len() > ENCODED_INPUT_LIMIT {
        return Err(failure("attachment image exceeds 16 MiB"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| failure("invalid attachment image encoding"))?;
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(failure("invalid attachment image encoding"));
    }
    if format!("{:x}", Sha256::digest(&bytes)) != id {
        return Err(failure(
            "attachment image digest does not match its identity",
        ));
    }
    Ok(bytes)
}

fn reference_summary(root: &Path, document: &Value) -> Result<(HashSet<String>, usize)> {
    let mut ids = HashSet::new();
    let mut total = 0;
    for page in document["slides"].as_array().into_iter().flatten() {
        for element in page["elements"].as_array().into_iter().flatten() {
            if element["kind"] != "image" {
                continue;
            }
            if document["version"] != 2 {
                return Err(failure("images require document version 2"));
            }
            let id = element["asset"]
                .as_str()
                .ok_or_else(|| failure("missing image resource identity"))?
                .to_owned();
            if !ids.insert(id.clone()) {
                continue;
            }
            if ids.len() > 100 {
                return Err(failure("document image count exceeds 100"));
            }
            let bytes = read(root, &id)?;
            total += bytes.len();
            if total > DOCUMENT_LIMIT {
                return Err(failure("document images exceed 16 MiB"));
            }
            resource_dimensions(&bytes)?;
        }
    }
    Ok((ids, total))
}

fn store_for_document(root: &Path, input: Vec<u8>, document: &Value) -> Result<Asset> {
    let document_id = document
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| failure("unsupported document source"))?;
    super::validate(document, document_id)?;
    let (ids, total) = reference_summary(root, document)?;
    let bytes = normalize(&input)?;
    drop(input);
    let id = format!("{:x}", Sha256::digest(&bytes));
    if !ids.contains(&id) {
        if ids.len() >= 100 {
            return Err(failure("document image count exceeds 100"));
        }
        if total.saturating_add(bytes.len()) > DOCUMENT_LIMIT {
            return Err(failure("document images exceed 16 MiB"));
        }
    }
    store_normalized(root, bytes)
}

/// Only referenced resources count toward the per-document export budget.
pub(super) fn validate_references(root: &Path, document: &Value) -> Result<()> {
    reference_summary(root, document).map(|_| ())
}

#[tauri::command]
pub async fn presentation_image_import(path: String, document: Value) -> Result<Asset> {
    let _import = ImportGuard::acquire()?;
    tokio::task::spawn_blocking(move || {
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| failure("could not inspect selected image"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(failure("selected image must be a regular local file"));
        }
        let bytes = crate::bounded_file::read(Path::new(&path), INPUT_LIMIT)
            .map_err(|_| failure("could not read selected image within 16 MiB"))?;
        store_for_document(&super::root(), bytes, &document)
    })
    .await
    .map_err(|_| failure("image import task failed"))?
}

#[tauri::command]
pub async fn presentation_image_import_attachment(
    attachment_id: String,
    data: String,
    document: Value,
) -> Result<Asset> {
    let _import = ImportGuard::acquire()?;
    tokio::task::spawn_blocking(move || {
        let bytes = attachment_bytes(&attachment_id, &data)?;
        drop(data);
        store_for_document(&super::root(), bytes, &document)
    })
    .await
    .map_err(|_| failure("attachment image import task failed"))?
}

#[tauri::command]
pub async fn presentation_image_read(id: String) -> Result<Asset> {
    tokio::task::spawn_blocking(move || payload(id.clone(), &read(&super::root(), &id)?))
        .await
        .map_err(|_| failure("image read task failed"))?
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fixture;
    use super::*;

    fn png() -> Vec<u8> {
        let image = DynamicImage::new_rgba8(3, 2);
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageFormat::Png).unwrap();
        output.into_inner()
    }

    fn marked_png(marker: u8) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([marker, 0, 0, 255]));
        let mut output = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut output, ImageFormat::Png)
            .unwrap();
        output.into_inner()
    }

    #[test]
    fn imports_deduplicates_and_verifies_immutable_resource_bytes() {
        let root = Fixture::new();
        let first = store(&root.0, &png()).unwrap();
        let again = store(&root.0, &png()).unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!((first.width, first.height), (3, 2));
        assert_eq!(std::fs::read_dir(root.0.join("assets")).unwrap().count(), 1);
        assert_eq!(read(&root.0, &first.id).unwrap().len(), first.bytes);
        assert!(first.data_url.starts_with("data:image/png;base64,"));
        std::fs::write(asset_path(&root.0, &first.id).unwrap(), b"damaged").unwrap();
        assert!(read(&root.0, &first.id).is_err());
        assert!(store(&root.0, &png()).is_err());
    }

    #[test]
    fn rejects_bad_formats_dimensions_and_resource_paths() {
        let root = Fixture::new();
        for input in [
            b"not an image".as_slice(),
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        ] {
            assert!(store(&root.0, input).is_err());
        }
        assert!(normalize(&vec![0; INPUT_LIMIT + 1]).is_err());
        for (width, height) in [(0, 1), (8193, 1), (1, 8193), (8192, 8192)] {
            assert!(dimensions(width, height).is_err());
        }
        for id in [
            "../private",
            "C:/private",
            "",
            &"A".repeat(64),
            &"g".repeat(64),
        ] {
            assert!(read(&root.0, id).is_err());
        }
        assert!(read(&root.0, &"a".repeat(64)).is_err());
        assert!(payload("a".repeat(64), b"bad header").is_err());
    }

    #[test]
    fn source_validation_refuses_missing_media_and_old_schema() {
        let root = Fixture::new();
        let asset = store(&root.0, &png()).unwrap();
        let mut doc = serde_json::json!({"version":2,"slides":[{"elements":[{"kind":"image","asset":asset.id}]}]});
        validate_references(&root.0, &doc).unwrap();
        doc["version"] = 1.into();
        assert!(validate_references(&root.0, &doc).is_err());
        doc["version"] = 2.into();
        doc["slides"][0]["elements"][0]["asset"] = "b".repeat(64).into();
        assert!(validate_references(&root.0, &doc).is_err());
    }

    #[test]
    fn converts_jpeg_and_webp_to_png() {
        for format in [ImageFormat::Jpeg, ImageFormat::WebP] {
            let mut output = Cursor::new(Vec::new());
            DynamicImage::new_rgb8(2, 3)
                .write_to(&mut output, format)
                .unwrap();
            let bytes = normalize(&output.into_inner()).unwrap();
            assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Png);
            assert_eq!(payload("a".repeat(64), &bytes).unwrap().height, 3);
        }
    }

    #[test]
    fn refuses_oversized_headers_before_accepting_resources() {
        let mut output = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(DIMENSION + 1, 1)
            .write_to(&mut output, ImageFormat::Png)
            .unwrap();
        assert!(normalize(&output.into_inner()).is_err());
        let root = Fixture::new();
        let id = "a".repeat(64);
        let path = asset_path(&root.0, &id).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(read(&root.0, &id).is_err());
    }

    #[test]
    fn enforces_library_count_and_size_before_adding_an_asset() {
        let root = Fixture::new();
        let directory = asset_directory(&root.0).unwrap();
        for index in 0..1000 {
            std::fs::write(directory.join(format!("entry-{index}")), []).unwrap();
        }
        assert!(store(&root.0, &png()).is_err());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1000);
        let root = Fixture::new();
        let directory = asset_directory(&root.0).unwrap();
        std::fs::File::create(directory.join("occupied"))
            .unwrap()
            .set_len(LIBRARY_LIMIT)
            .unwrap();
        assert!(store(&root.0, &png()).is_err());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    }

    #[test]
    fn broken_image_update_preserves_the_existing_document() {
        let root = Fixture::new();
        let asset = store(&root.0, &png()).unwrap();
        let mut document = serde_json::json!({
            "format":"dsh-studio-presentation", "version":2, "id":"report", "title":"Original",
            "slides":[{"elements":[{"kind":"image", "asset":asset.id}]}]
        });
        let original = document.to_string();
        let saved = super::super::save(&root.0, "report", &original, None).unwrap();
        document["title"] = "Changed".into();
        document["slides"][0]["elements"][0]["asset"] = "a".repeat(64).into();
        assert!(super::super::save(
            &root.0,
            "report",
            &document.to_string(),
            Some(&saved.revision)
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.0.join("report.json")).unwrap(),
            original
        );
    }

    #[test]
    fn imports_only_canonical_digest_bound_attachment_images() {
        let root = Fixture::new();
        let input = png();
        let digest = format!("sha256:{:x}", Sha256::digest(&input));
        let wrong_digest = format!("sha256:{}", "a".repeat(64));
        let encoded = STANDARD.encode(&input);
        assert_eq!(
            store(&root.0, &attachment_bytes(&digest, &encoded).unwrap())
                .unwrap()
                .width,
            3
        );
        for (id, data) in [
            ("invalid", encoded.as_str()),
            (wrong_digest.as_str(), encoded.as_str()),
            (digest.as_str(), "%%%"),
            (digest.as_str(), ""),
        ] {
            assert!(attachment_bytes(id, data).is_err());
        }
        assert!(attachment_bytes(&digest, &"A".repeat(ENCODED_INPUT_LIMIT + 1)).is_err());
    }

    #[test]
    fn accepts_the_exact_attachment_limit_and_serializes_native_imports() {
        let input = vec![7; INPUT_LIMIT];
        let digest = format!("sha256:{:x}", Sha256::digest(&input));
        let encoded = STANDARD.encode(&input);
        assert_eq!(
            attachment_bytes(&digest, &encoded).unwrap().len(),
            INPUT_LIMIT
        );
        let guard = ImportGuard::acquire().unwrap();
        assert!(ImportGuard::acquire().is_err());
        drop(guard);
        assert!(ImportGuard::acquire().is_ok());
    }

    #[test]
    fn document_budget_is_checked_before_a_new_asset_is_stored() {
        let root = Fixture::new();
        let mut ids = Vec::new();
        for marker in [1, 2] {
            let mut bytes = png();
            bytes.resize(ASSET_LIMIT, marker);
            let id = format!("{:x}", Sha256::digest(&bytes));
            crate::atomic::write(&asset_path(&root.0, &id).unwrap(), &bytes).unwrap();
            payload(id.clone(), &bytes).unwrap();
            ids.push(id);
        }
        let document = serde_json::json!({
            "format": "dsh-studio-presentation",
            "version": 2,
            "id": "budget",
            "title": "Budget",
            "slides": [{
                "elements": ids.iter().map(|id| serde_json::json!({
                    "kind": "image",
                    "asset": id,
                })).collect::<Vec<_>>(),
            }],
        });
        let input = png();
        let normalized = normalize(&input).unwrap();
        let candidate = format!("{:x}", Sha256::digest(&normalized));
        let path = asset_path(&root.0, &candidate).unwrap();
        assert!(!path.exists());
        assert!(store_for_document(&root.0, input, &document).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn full_document_image_roster_allows_duplicates_but_rejects_new_assets_before_storage() {
        let root = Fixture::new();
        let mut ids = Vec::new();
        for marker in 0..100 {
            ids.push(store(&root.0, &marked_png(marker)).unwrap().id);
        }
        let document = serde_json::json!({
            "format": "dsh-studio-presentation",
            "version": 2,
            "id": "count",
            "title": "Count",
            "slides": [{
                "elements": ids.iter().map(|id| serde_json::json!({
                    "kind": "image",
                    "asset": id,
                })).collect::<Vec<_>>(),
            }],
        });
        let duplicate = store_for_document(&root.0, marked_png(0), &document).unwrap();
        assert_eq!(duplicate.id, ids[0]);
        assert_eq!(
            std::fs::read_dir(root.0.join("assets")).unwrap().count(),
            100
        );

        let input = marked_png(255);
        let candidate = format!("{:x}", Sha256::digest(normalize(&input).unwrap()));
        let path = asset_path(&root.0, &candidate).unwrap();
        assert!(store_for_document(&root.0, input, &document).is_err());
        assert!(!path.exists());
    }
}
