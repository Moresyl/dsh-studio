//! Resolve the package entry point and slide order, never filesystem paths.
use std::collections::{HashMap, HashSet};

use roxmltree::Node;

use super::{failure, package::Package, xml::Source};
use crate::error::Result;

const CONTENT_TYPES: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const PRESENTATION: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const STRICT_PRESENTATION: &str = "http://purl.oclc.org/ooxml/presentationml/main";
const DOCUMENT: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const STRICT_DOCUMENT: &str = "http://purl.oclc.org/ooxml/officeDocument/relationships";
const MAIN_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const SLIDE_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";

struct Relationship {
    kind: String,
    target: String,
    external: bool,
}

fn required<'a>(node: Node<'a, '_>, name: &str) -> Result<&'a str> {
    node.attribute(name)
        .filter(|value| !value.is_empty() && value.len() <= 2048)
        .ok_or_else(|| failure("missing or oversized PPTX structural attribute"))
}

fn relationship_kind(kind: &str, local: &str) -> bool {
    [DOCUMENT, STRICT_DOCUMENT].iter().any(|namespace| {
        kind.strip_prefix(namespace)
            .is_some_and(|tail| tail == format!("/{local}"))
    })
}

/// URI names remain package names. Encoded separators and encoded dot aliases
/// are rejected; ordinary percent escapes retain their URI spelling.
fn resolve(source: &str, target: &str) -> Result<String> {
    if target.is_empty()
        || target.len() > 1024
        || target.starts_with("//")
        || target.contains(['\\', ':', '?', '#'])
        || target.chars().any(char::is_control)
    {
        return Err(failure("invalid internal PPTX relationship target"));
    }
    let mut segments: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        source
            .rsplit_once('/')
            .map_or_else(Vec::new, |(directory, _)| directory.split('/').collect())
    };
    for segment in target.strip_prefix('/').unwrap_or(target).split('/') {
        match segment {
            "" => return Err(failure("empty PPTX target segment")),
            "." => {}
            ".." => {
                segments
                    .pop()
                    .ok_or_else(|| failure("PPTX target escapes package"))?;
            }
            _ => {
                let bytes = segment.as_bytes();
                let mut index = 0;
                while index < bytes.len() {
                    if bytes[index] == b'%' {
                        let encoded = segment
                            .get(index + 1..index + 3)
                            .and_then(|value| u8::from_str_radix(value, 16).ok())
                            .ok_or_else(|| failure("invalid PPTX target escape"))?;
                        if encoded.is_ascii_control()
                            || matches!(encoded, b'/' | b'\\' | b'.' | b':' | b'%' | b'?' | b'#')
                        {
                            return Err(failure("ambiguous PPTX target escape"));
                        }
                        index += 3;
                    } else {
                        index += 1;
                    }
                }
                segments.push(segment);
            }
        }
    }
    if segments.is_empty() || matches!(target.rsplit('/').next(), Some("." | "..")) {
        return Err(failure("PPTX target must name a part"));
    }
    Ok(segments.join("/"))
}

fn relations(package: &mut Package<'_>, source: &str) -> Result<HashMap<String, Relationship>> {
    let part = if source.is_empty() {
        "_rels/.rels".to_owned()
    } else if let Some((directory, name)) = source.rsplit_once('/') {
        format!("{directory}/_rels/{name}.rels")
    } else {
        format!("_rels/{source}.rels")
    };
    let source = Source::read(package, &part)?;
    let tree = source.parse()?;
    let root = tree.root_element();
    if !root.has_tag_name((RELATIONSHIPS, "Relationships")) {
        return Err(failure("invalid PPTX relationships root"));
    }
    let mut result = HashMap::new();
    for node in root.children().filter(Node::is_element) {
        if !node.has_tag_name((RELATIONSHIPS, "Relationship")) {
            return Err(failure("invalid PPTX relationship element"));
        }
        let id = required(node, "Id")?;
        let external = match node.attribute("TargetMode") {
            None | Some("Internal") => false,
            Some("External") => true,
            _ => return Err(failure("invalid PPTX relationship mode")),
        };
        let relation = Relationship {
            kind: required(node, "Type")?.to_owned(),
            target: required(node, "Target")?.to_owned(),
            external,
        };
        if result.insert(id.to_owned(), relation).is_some() {
            return Err(failure("duplicate PPTX relationship identity"));
        }
    }
    Ok(result)
}

struct ContentTypes {
    overrides: HashMap<String, String>,
    defaults: HashMap<String, String>,
}

impl ContentTypes {
    fn read(package: &mut Package<'_>) -> Result<Self> {
        let source = Source::read(package, "[Content_Types].xml")?;
        let tree = source.parse()?;
        let root = tree.root_element();
        if !root.has_tag_name((CONTENT_TYPES, "Types")) {
            return Err(failure("invalid PPTX content types root"));
        }
        let mut result = Self {
            overrides: HashMap::new(),
            defaults: HashMap::new(),
        };
        for node in root.children().filter(Node::is_element) {
            let content_type = required(node, "ContentType")?.to_owned();
            let previous = if node.has_tag_name((CONTENT_TYPES, "Override")) {
                let name = required(node, "PartName")?;
                if !name.starts_with('/') {
                    return Err(failure("PPTX content type part must be absolute"));
                }
                result
                    .overrides
                    .insert(resolve("", name)?.to_ascii_lowercase(), content_type)
            } else if node.has_tag_name((CONTENT_TYPES, "Default")) {
                let extension = required(node, "Extension")?;
                if !extension.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
                    return Err(failure("invalid PPTX content type extension"));
                }
                result
                    .defaults
                    .insert(extension.to_ascii_lowercase(), content_type)
            } else {
                return Err(failure("invalid PPTX content type element"));
            };
            if previous.is_some() {
                return Err(failure("duplicate PPTX content type declaration"));
            }
        }
        Ok(result)
    }

    fn require(&self, part: &str, expected: &str) -> Result<()> {
        let name = part.to_ascii_lowercase();
        let actual = self.overrides.get(&name).or_else(|| {
            name.rsplit_once('.')
                .and_then(|(_, extension)| self.defaults.get(extension))
        });
        if actual.is_none_or(|value| value != expected) {
            return Err(failure("missing or unsupported PPTX content type"));
        }
        Ok(())
    }
}

fn internal(source: &str, relation: &Relationship) -> Result<String> {
    if relation.external {
        return Err(failure("required PPTX document part cannot be external"));
    }
    resolve(source, &relation.target)
}

/// The returned order comes from sldIdLst, not ZIP order or numbered filenames.
/// This validates document structure only, not drawing support or visual fidelity.
pub(super) fn slides(package: &mut Package<'_>) -> Result<Vec<String>> {
    let types = ContentTypes::read(package)?;
    let root_relations = relations(package, "")?;
    let mut entries = root_relations
        .values()
        .filter(|relation| relationship_kind(&relation.kind, "officeDocument"));
    let entry = entries
        .next()
        .ok_or_else(|| failure("missing PPTX document relationship"))?;
    if entries.next().is_some() {
        return Err(failure("multiple PPTX document relationships"));
    }
    let main = internal("", entry)?;
    types.require(&main, MAIN_TYPE)?;
    let source = Source::read(package, &main)?;
    let tree = source.parse()?;
    let root = tree.root_element();
    let namespace = root.tag_name().namespace().unwrap_or("");
    if ![PRESENTATION, STRICT_PRESENTATION].contains(&namespace)
        || root.tag_name().name() != "presentation"
    {
        return Err(failure("invalid PPTX presentation root"));
    }
    let mut lists = root
        .children()
        .filter(|node| node.has_tag_name((namespace, "sldIdLst")));
    let list = lists
        .next()
        .ok_or_else(|| failure("missing PPTX slide list"))?;
    if lists.next().is_some() {
        return Err(failure("multiple PPTX slide lists"));
    }
    let relationships = relations(package, &main)?;
    let relation_namespace = if namespace == PRESENTATION {
        DOCUMENT
    } else {
        STRICT_DOCUMENT
    };
    let mut ids = HashSet::new();
    let mut parts = HashSet::new();
    let mut ordered = Vec::new();
    for node in list.children().filter(Node::is_element) {
        if ordered.len() >= 100 || !node.has_tag_name((namespace, "sldId")) {
            return Err(failure("invalid or oversized PPTX slide list"));
        }
        let id = required(node, "id")?
            .parse::<u32>()
            .map_err(|_| failure("invalid PPTX slide identity"))?;
        if !(256..=2_147_483_647).contains(&id) || !ids.insert(id) {
            return Err(failure("invalid or duplicate PPTX slide identity"));
        }
        let reference = node
            .attribute((relation_namespace, "id"))
            .and_then(|id| relationships.get(id))
            .ok_or_else(|| failure("missing PPTX slide relationship"))?;
        if !relationship_kind(&reference.kind, "slide") {
            return Err(failure("PPTX slide relationship has the wrong type"));
        }
        let part = internal(&main, reference)?;
        if !parts.insert(part.to_ascii_lowercase()) {
            return Err(failure("multiple PPTX slides reference the same part"));
        }
        types.require(&part, SLIDE_TYPE)?;
        let slide_source = Source::read(package, &part)?;
        let slide = slide_source.parse()?;
        if !slide.root_element().has_tag_name((namespace, "sld")) {
            return Err(failure("invalid PPTX slide root"));
        }
        ordered.push(part);
    }
    if ordered.is_empty() {
        return Err(failure("PPTX contains no slides"));
    }
    Ok(ordered)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::{Cursor, Write};

    fn fixture() -> BTreeMap<String, String> {
        [
            ("[Content_Types].xml", format!("<Types xmlns='{CONTENT_TYPES}'><Override PartName='/slides/document.xml' ContentType='{MAIN_TYPE}'/><Default Extension='xml' ContentType='{SLIDE_TYPE}'/></Types>")),
            ("_rels/.rels", format!("<Relationships xmlns='{RELATIONSHIPS}'><Relationship Id='main' Type='{DOCUMENT}/officeDocument' Target='slides/document.xml'/></Relationships>")),
            ("slides/document.xml", format!("<p:presentation xmlns:p='{PRESENTATION}' xmlns:r='{DOCUMENT}'><p:sldIdLst><p:sldId id='257' r:id='second'/><p:sldId id='256' r:id='first'/></p:sldIdLst></p:presentation>")),
            ("slides/_rels/document.xml.rels", format!("<Relationships xmlns='{RELATIONSHIPS}'><Relationship Id='first' Type='{DOCUMENT}/slide' Target='../pages/slide1.xml'/><Relationship Id='second' Type='{DOCUMENT}/slide' Target='/pages/slide2.xml'/><Relationship Id='link' Type='{DOCUMENT}/hyperlink' Target='https://invalid.test/private' TargetMode='External'/></Relationships>")),
            ("pages/slide1.xml", format!("<p:sld xmlns:p='{PRESENTATION}'/>")),
            ("pages/slide2.xml", format!("<sld xmlns='{PRESENTATION}'/>")),
        ].into_iter().map(|(name, content)| (name.to_owned(), content)).collect()
    }

    fn archive(parts: &BTreeMap<String, String>) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in parts {
            writer
                .start_file(
                    name,
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    pub(crate) fn fixture_bytes() -> Vec<u8> {
        archive(&fixture())
    }

    pub(crate) fn missing_slide_bytes() -> Vec<u8> {
        let mut parts = fixture();
        parts.remove("pages/slide1.xml");
        archive(&parts)
    }

    fn inspect(parts: &BTreeMap<String, String>) -> Result<Vec<String>> {
        slides(&mut Package::open(&archive(parts))?)
    }

    #[test]
    fn follows_root_relationship_and_declared_slide_order_in_both_dialects() {
        for strict in [false, true] {
            let mut parts = fixture();
            if strict {
                for text in parts.values_mut() {
                    *text = text
                        .replace(PRESENTATION, STRICT_PRESENTATION)
                        .replace(DOCUMENT, STRICT_DOCUMENT);
                }
            }
            assert_eq!(
                inspect(&parts).unwrap(),
                ["pages/slide2.xml", "pages/slide1.xml"]
            );
        }
    }

    #[test]
    fn accepts_case_insensitive_part_names_and_preserves_escaped_names() {
        let mut parts = fixture();
        let content = parts.remove("pages/slide1.xml").unwrap();
        parts.insert("PAGES/SLIDE1.XML".into(), content);
        assert_eq!(inspect(&parts).unwrap()[1], "pages/slide1.xml");
        for name in ["page%20one.xml", "%E4%B8%AD.xml", "中文.xml"] {
            let mut parts = fixture();
            let content = parts.remove("pages/slide1.xml").unwrap();
            parts.insert(format!("pages/{name}"), content);
            let relationships = parts.get_mut("slides/_rels/document.xml.rels").unwrap();
            *relationships = relationships.replace("slide1.xml", name);
            assert_eq!(inspect(&parts).unwrap()[1], format!("pages/{name}"));
        }
    }

    #[test]
    fn resolves_only_bounded_internal_part_paths() {
        for (source, target, expected) in [
            ("", "ppt/main.xml", "ppt/main.xml"),
            ("ppt/main.xml", "./slides/page.xml", "ppt/slides/page.xml"),
            ("ppt/main.xml", "../slides/page.xml", "slides/page.xml"),
            ("ppt/main.xml", "/slides/page.xml", "slides/page.xml"),
            ("main.xml", "slides/page%20one.xml", "slides/page%20one.xml"),
            ("main.xml", "slides/中文.xml", "slides/中文.xml"),
        ] {
            assert_eq!(resolve(source, target).unwrap(), expected);
        }
        for target in [
            "",
            "//host/file",
            "https://host/file",
            "C:/file",
            "../../file",
            "a//b",
            "a/",
            ".",
            "..",
            "a/../..",
            "a?query",
            "a#fragment",
            "a\\b",
            "a\0b",
            "a%",
            "a%0",
            "a%zz",
            "a%2Fb",
            "%2e%2e/b",
            "a%5cb",
            "a%00b",
            "a%252fb",
        ] {
            assert!(
                resolve("ppt/main.xml", target).is_err(),
                "accepted {target:?}"
            );
        }
        assert!(resolve("", &"a".repeat(1025)).is_err());
    }

    #[test]
    fn rejects_missing_parts_before_producing_an_order() {
        for name in fixture().keys() {
            let mut parts = fixture();
            parts.remove(name);
            assert!(inspect(&parts).is_err(), "accepted missing {name}");
        }
    }

    #[test]
    fn rejects_malformed_metadata_relationships_and_slides() {
        let cases = [
            ("[Content_Types].xml", CONTENT_TYPES, "urn:wrong"),
            ("[Content_Types].xml", "Override", "Unknown"),
            ("[Content_Types].xml", "PartName='/slides", "PartName='slides"),
            ("[Content_Types].xml", "Extension='xml'", "Extension='x/ml'"),
            ("[Content_Types].xml", MAIN_TYPE, "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"),
            ("[Content_Types].xml", SLIDE_TYPE, "application/xml"),
            ("[Content_Types].xml", "</Types>", &format!("<Default Extension='XML' ContentType='{SLIDE_TYPE}'/></Types>")),
            ("[Content_Types].xml", "</Types>", &format!("<Override PartName='/SLIDES/document.xml' ContentType='{MAIN_TYPE}'/></Types>")),
            ("_rels/.rels", RELATIONSHIPS, "urn:wrong"),
            ("_rels/.rels", "Type=", "Other="),
            ("_rels/.rels", "officeDocument", "somethingElse"),
            ("_rels/.rels", "<Relationship ", "<Other "),
            ("_rels/.rels", "Target='slides/document.xml'", "Target='https://invalid.test/main.xml' TargetMode='External'"),
            ("_rels/.rels", "</Relationships>", &format!("<Relationship Id='another' Type='{DOCUMENT}/officeDocument' Target='slides/document.xml'/></Relationships>")),
            ("slides/document.xml", "presentation", "wrong"),
            ("slides/document.xml", PRESENTATION, "urn:wrong"),
            ("slides/document.xml", "sldIdLst", "somethingElse"),
            ("slides/document.xml", "</p:presentation>", "<p:sldIdLst/></p:presentation>"),
            ("slides/document.xml", "r:id='first'", "r:id='second'"),
            ("slides/document.xml", "r:id='first'", "r:id='absent'"),
            ("slides/document.xml", "id='257'", "id='256'"),
            ("slides/document.xml", "id='257'", "id='255'"),
            ("slides/document.xml", "id='257'", "id='2147483648'"),
            ("slides/document.xml", "id='257'", "id='bad'"),
            ("slides/document.xml", "<p:sldId id=", "<p:unknown id="),
            ("slides/_rels/document.xml.rels", "Id='first'", "Id='second'"),
            ("slides/_rels/document.xml.rels", "TargetMode='External'", "TargetMode='Bogus'"),
            ("slides/_rels/document.xml.rels", "Target='../pages/slide1.xml'", "Target='../pages/slide1.xml' TargetMode='External'"),
            ("slides/_rels/document.xml.rels", "/slide'", "/notSlide'"),
            ("pages/slide1.xml", "p:sld", "p:presentation"),
            ("pages/slide1.xml", PRESENTATION, STRICT_PRESENTATION),
            ("pages/slide1.xml", "/>", ">"),
        ];
        for (name, from, to) in cases {
            let mut parts = fixture();
            let text = parts.get_mut(name).unwrap();
            assert!(text.contains(from));
            *text = text.replace(from, to);
            assert!(inspect(&parts).is_err(), "accepted {name}: {from} => {to}");
        }
    }

    #[test]
    fn rejects_empty_and_oversized_slide_lists() {
        for count in [0, 101] {
            let mut parts = fixture();
            let ids: String = (0..count)
                .map(|index| format!("<p:sldId id='{}' r:id='r{index}'/>", index + 256))
                .collect();
            let references: String = (0..count).map(|index| format!("<Relationship Id='r{index}' Type='{DOCUMENT}/slide' Target='../pages/{index}.xml'/>")).collect();
            parts.insert("slides/document.xml".into(), format!("<p:presentation xmlns:p='{PRESENTATION}' xmlns:r='{DOCUMENT}'><p:sldIdLst>{ids}</p:sldIdLst></p:presentation>"));
            parts.insert(
                "slides/_rels/document.xml.rels".into(),
                format!("<Relationships xmlns='{RELATIONSHIPS}'>{references}</Relationships>"),
            );
            for index in 0..count {
                parts.insert(
                    format!("pages/{index}.xml"),
                    format!("<p:sld xmlns:p='{PRESENTATION}'/>"),
                );
            }
            assert!(inspect(&parts).is_err());
        }
    }

    #[test]
    #[ignore = "requires DSH_TEST_PPTX pointing to an independently generated PPTX"]
    fn reads_independently_generated_slide_graph() {
        let path = std::env::var_os("DSH_TEST_PPTX").expect("DSH_TEST_PPTX required");
        let bytes = std::fs::read(path).unwrap();
        let mut package = Package::open(&bytes).unwrap();
        assert!(!slides(&mut package).unwrap().is_empty());
        package.verify_contents().unwrap();
    }
}
