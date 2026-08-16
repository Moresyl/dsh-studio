//! The pairing URL as a grid of modules for the UI to draw.
//!
//! No image is produced here. A QR code is a boolean matrix, and the frontend
//! can turn that into an SVG that stays sharp at any size and takes its colours
//! from the theme — where a PNG would have to be re-encoded to follow either.

use serde::Serialize;

/// A finished QR code: `size` × `size` modules, row-major, true meaning dark.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Matrix {
    pub size: usize,
    pub modules: Vec<bool>,
}

/// Encode `text`, or `None` if it will not fit in a version 40 symbol.
///
/// Medium error correction: a phone camera reads a screen through glare and at
/// an angle, and the pairing URL is short enough that the extra redundancy
/// costs no version.
pub fn encode(text: &str) -> Option<Matrix> {
    let code = qrcodegen::QrCode::encode_text(text, qrcodegen::QrCodeEcc::Medium).ok()?;
    let size = code.size() as usize;

    let mut modules = Vec::with_capacity(size * size);
    for y in 0..code.size() {
        for x in 0..code.size() {
            modules.push(code.get_module(x, y));
        }
    }

    Some(Matrix { size, modules })
}

#[cfg(test)]
mod tests {
    use super::encode;

    #[test]
    fn encodes_a_pairing_url() {
        let matrix = encode("http://192.168.1.20:52418/?k=0123456789abcdef").expect("encodes");
        assert!(matrix.size >= 21, "smallest QR symbol is 21 modules");
        assert_eq!(matrix.modules.len(), matrix.size * matrix.size);
    }

    #[test]
    fn marks_the_finder_pattern_corners() {
        let matrix = encode("http://10.0.0.2:8080/?k=abc").expect("encodes");
        // Every QR symbol opens with a dark module at the top-left finder.
        assert!(matrix.modules[0]);
        // And the top-right finder starts seven modules from the right edge.
        assert!(matrix.modules[matrix.size - 7]);
    }
}
