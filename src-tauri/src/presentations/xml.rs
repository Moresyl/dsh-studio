//! Bounded XML input. Neither parser resolves external entities or executes PIs.
use std::borrow::Cow;

use quick_xml::{events::Event, Reader};
use roxmltree::{Document, ParsingOptions};

use super::{failure, package::Package};
use crate::error::Result;

const BYTES: usize = 8 * 1024 * 1024;
const DEPTH: usize = 128;
const PARSER_STACK: usize = 8 * 1024 * 1024;
const NODES: u32 = 100_000;
const ATTRIBUTES: usize = 64;

pub(super) struct Source(String);

impl Source {
    pub(super) fn read(package: &mut Package<'_>, part: &str) -> Result<Self> {
        Self::decode(&package.read_part(part, BYTES)?)
    }

    fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > BYTES {
            return Err(failure("PPTX XML byte limit exceeded"));
        }
        let (text, encoding) = if bytes.starts_with(b"\xff\xfe") || bytes.starts_with(b"\xfe\xff") {
            let little = bytes.starts_with(b"\xff\xfe");
            if !bytes.len().is_multiple_of(2) {
                return Err(failure("truncated PPTX UTF-16 XML"));
            }
            let mut text = String::new();
            for character in char::decode_utf16(bytes[2..].as_chunks::<2>().0.iter().map(|pair| {
                if little {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })) {
                text.push(character.map_err(|_| failure("invalid PPTX UTF-16 XML"))?);
                if text.len() > BYTES {
                    return Err(failure("PPTX decoded XML byte limit exceeded"));
                }
            }
            (text, if little { "utf-16le" } else { "utf-16be" })
        } else {
            let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
            (
                std::str::from_utf8(bytes)
                    .map_err(|_| failure("PPTX XML must use UTF-8 or BOM-marked UTF-16"))?
                    .to_owned(),
                "utf-8",
            )
        };
        preflight(&text, encoding)?;
        Ok(Self(text))
    }

    pub(super) fn parse(&self) -> Result<Document<'_>> {
        // roxmltree recurses per element. Caller stacks differ across platforms;
        // use a bounded dedicated stack without relaxing input admission limits.
        std::thread::scope(|scope| {
            std::thread::Builder::new()
                .name("presentation-xml".into())
                .stack_size(PARSER_STACK)
                .spawn_scoped(scope, || self.parse_tree())
                .map_err(|_| failure("could not start PPTX XML parser"))?
                .join()
                .map_err(|_| failure("PPTX XML parser failed"))?
        })
    }

    fn parse_tree(&self) -> Result<Document<'_>> {
        Document::parse_with_options(
            &self.0,
            ParsingOptions {
                allow_dtd: false,
                nodes_limit: NODES,
                ..ParsingOptions::default()
            },
        )
        .map_err(|error| {
            let position = error.pos();
            // Do not include source text, namespace values, or entity URLs.
            failure(&format!(
                "invalid PPTX XML at line {}, column {}",
                position.row, position.col
            ))
        })
    }
}

fn preflight(text: &str, encoding: &str) -> Result<()> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().check_comments = true;
    let mut depth = 0;
    let mut count = 0;
    let mut first = true;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| failure("malformed PPTX XML"))?;
        if matches!(event, Event::Eof) {
            return Ok(());
        }
        count += 1;
        if count > NODES * 2 {
            return Err(failure("PPTX XML event limit exceeded"));
        }
        match event {
            Event::Start(ref element) | Event::Empty(ref element) => {
                if depth >= DEPTH {
                    return Err(failure("PPTX XML depth limit exceeded"));
                }
                for (index, attribute) in element.attributes().enumerate() {
                    if index >= ATTRIBUTES || attribute.is_err() {
                        return Err(failure("invalid or excessive PPTX XML attributes"));
                    }
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
            }
            Event::End(_) => depth -= 1,
            Event::DocType(_) => return Err(failure("PPTX XML document types are unsupported")),
            Event::Decl(declaration) => {
                if !first || declaration.version().ok().as_deref() != Some(b"1.0") {
                    return Err(failure("PPTX requires an XML 1.0 document"));
                }
                if let Some(declared) = declaration.encoding() {
                    let declared: Cow<'_, [u8]> =
                        declared.map_err(|_| failure("invalid PPTX XML encoding declaration"))?;
                    let expected = declared.eq_ignore_ascii_case(encoding.as_bytes());
                    let generic_utf16 =
                        encoding.starts_with("utf-16") && declared.eq_ignore_ascii_case(b"utf-16");
                    if !expected && !generic_utf16 {
                        return Err(failure(
                            "PPTX XML encoding declaration does not match bytes",
                        ));
                    }
                }
            }
            _ => {}
        }
        first = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepted(bytes: &[u8]) -> bool {
        Source::decode(bytes).is_ok_and(|source| source.parse().is_ok())
    }

    #[test]
    fn resolves_namespaces_entities_cdata_and_unicode_without_losing_text() {
        let source = Source::decode(
            "<?xml version='1.0' encoding='UTF-8'?><p:a xmlns:p='urn:a' xmlns:r='urn:r' r:id='x&amp;y'>中文 &lt;&#x1f600;<![CDATA[<tag>]]><a xmlns='urn:child'/></p:a>".as_bytes(),
        ).unwrap();
        let tree = source.parse().unwrap();
        let root = tree.root_element();
        assert!(root.has_tag_name(("urn:a", "a")));
        assert_eq!(root.attribute(("urn:r", "id")), Some("x&y"));
        assert_eq!(root.text(), Some("中文 <😀<tag>"));
        assert!(root
            .last_element_child()
            .unwrap()
            .has_tag_name(("urn:child", "a")));
        assert!(accepted(b"\xef\xbb\xbf<a/>"));
        assert!(accepted(
            b"<?xml-stylesheet href='https://invalid.test/'?><a/><!--ok-->"
        ));
    }

    #[test]
    fn accepts_both_utf16_byte_orders_and_rejects_mismatched_declarations() {
        for little in [true, false] {
            let mut bytes = if little {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            };
            for code in "<?xml version='1.0' encoding='UTF-16'?><a>中😀</a>".encode_utf16() {
                bytes.extend(if little {
                    code.to_le_bytes()
                } else {
                    code.to_be_bytes()
                });
            }
            assert!(accepted(&bytes));
            bytes.pop();
            assert!(!accepted(&bytes));
        }
        for bytes in [
            b"\xff\xfe\x00\xd8".as_slice(),
            b"\xff",
            b"<?xml version='1.0' encoding='UTF-16'?><a/>",
            b"<?xml version='1.0' encoding='windows-1252'?><a/>",
            b"<?xml version='1.1'?><a/>",
            b"<a/><?xml version='1.0'?>",
        ] {
            assert!(!accepted(bytes));
        }
    }

    #[test]
    fn refuses_malformed_documents_entities_and_namespace_ambiguity() {
        for input in [
            "",
            "<a>",
            "</a>",
            "<a></b>",
            "<a/><b/>",
            "outside<a/>",
            "<!DOCTYPE a><a/>",
            "<!DOCTYPE a SYSTEM 'file:///private'><a/>",
            "<!DOCTYPE a [<!ENTITY x 'expanded'>]><a>&x;</a>",
            "<a>&undefined;</a>",
            "<a>&#0;</a>",
            "<a>\0</a>",
            "<a a='1' a='2'/>",
            "<p:a/>",
            "<a p:x='1'/>",
            "<a xmlns:x='urn:x' xmlns:y='urn:x' x:id='1' y:id='2'/>",
            "<1bad/>",
            "<a><!--bad--comment--></a>",
        ] {
            assert!(!accepted(input.as_bytes()), "accepted {input:?}");
        }
    }

    #[test]
    fn parses_admitted_depth_on_a_small_thread_stack() {
        std::thread::Builder::new()
            .stack_size(512 * 1024)
            .spawn(|| {
                assert!(accepted(
                    format!("{}{}", "<a>".repeat(DEPTH), "</a>".repeat(DEPTH)).as_bytes()
                ));
                assert!(!accepted(
                    format!("{}{}", "<a>".repeat(DEPTH + 1), "</a>".repeat(DEPTH + 1)).as_bytes()
                ));
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn bounds_input_depth_events_attributes_and_decoded_size() {
        assert!(!accepted(&vec![b' '; BYTES + 1]));
        assert!(accepted(
            format!("{}{}", "<a>".repeat(DEPTH), "</a>".repeat(DEPTH)).as_bytes()
        ));
        assert!(!accepted(
            format!("{}{}", "<a>".repeat(DEPTH + 1), "</a>".repeat(DEPTH + 1)).as_bytes()
        ));
        let attributes: String = (0..ATTRIBUTES + 1).map(|i| format!(" a{i}='x'")).collect();
        assert!(!accepted(format!("<a{attributes}/>").as_bytes()));
        assert!(!accepted(
            format!("<a>{}</a>", "<b/>".repeat(NODES as usize)).as_bytes()
        ));
        assert!(!accepted(
            format!("<a>{}</a>", "<b/>".repeat(NODES as usize * 2)).as_bytes()
        ));
        let mut bytes = vec![0xff, 0xfe];
        for _ in 0..BYTES / 3 + 1 {
            bytes.extend(0x4e2d_u16.to_le_bytes());
        }
        assert!(!accepted(&bytes));
    }
}
