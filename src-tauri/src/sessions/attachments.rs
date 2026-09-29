//! Display-only attachment records. Names and identifiers never authorize file access.

use serde::Serialize;
use serde_json::Value;

const MAX_ATTACHMENTS: usize = 64;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub kind: &'static str,
    pub id: Option<String>,
    pub name: Option<String>,
    pub bytes: Option<u64>,
    pub media_type: Option<String>,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

impl Attachment {
    pub fn label(&self) -> &str {
        self.name.as_deref().unwrap_or(self.kind)
    }

    pub fn weight(&self) -> u64 {
        (std::mem::size_of::<Self>()
            + self.id.as_ref().map_or(0, String::len)
            + self.name.as_ref().map_or(0, String::len)
            + self.media_type.as_ref().map_or(0, String::len)) as u64
    }
}

/// Keep even incomplete records visible, but never inline bytes, URLs or host paths.
pub fn collect(message: &Value) -> (Vec<Attachment>, usize) {
    let mut kept = Vec::new();
    let mut omitted = 0;
    for block in message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let kind = match block.get("type").and_then(Value::as_str) {
            Some("image") => "image",
            Some("file") => "file",
            _ => continue,
        };
        if kept.len() == MAX_ATTACHMENTS {
            omitted += 1;
            continue;
        }
        let reference = block.get("attachment").unwrap_or(&Value::Null);
        let name = reference
            .get("name")
            .and_then(Value::as_str)
            .and_then(|name| name.rsplit(['/', '\\']).next())
            .and_then(|name| clean(name, 256));
        let id = reference
            .get("attachmentId")
            .and_then(Value::as_str)
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 256
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
            })
            .map(str::to_owned);
        kept.push(Attachment {
            kind,
            id,
            name,
            bytes: integer(reference, "bytes"),
            media_type: reference
                .get("mediaType")
                .and_then(Value::as_str)
                .and_then(|value| clean(value, 128)),
            width: integer(reference, "width").filter(|value| *value > 0),
            height: integer(reference, "height").filter(|value| *value > 0),
        });
    }
    (kept, omitted)
}

fn integer(value: &Value, key: &str) -> Option<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value <= 9_007_199_254_740_991)
}

fn clean(value: &str, limit: usize) -> Option<String> {
    let text: String = value
        .chars()
        .filter(|ch| {
            !ch.is_control() && !matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(limit)
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn records_file_and_image_without_resolving_paths() {
        let (items, omitted) = collect(&json!({"content": [
            {"type":"text","text":"question"},
            {"type":"file","attachment":{"attachmentId":"sha256:abc","name":"C:\\private\\财报.txt","bytes":0}},
            {"type":"image","attachment":{"attachmentId":"xyz","name":"/tmp/photo.png","bytes":30,"mediaType":"image/png","width":40,"height":20}}
        ]}));
        assert_eq!(omitted, 0);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].label(), "财报.txt");
        assert_eq!(items[0].id.as_deref(), Some("sha256:abc"));
        assert_eq!(items[0].bytes, Some(0));
        assert_eq!(items[1].width, Some(40));
        assert_eq!(items[1].height, Some(20));
        assert_eq!(items[1].media_type.as_deref(), Some("image/png"));
        assert!(items[1].weight() > 0);
        assert!(!serde_json::to_string(&items).unwrap().contains("private"));
    }

    #[test]
    fn malformed_metadata_is_bounded_and_not_mistaken_for_a_path() {
        let (items, _) = collect(&json!({"content":[
            {"type":"file","attachment":{"attachmentId":"../../secret","name":"\u{202e}\n","bytes":-1}},
            {"type":"image","attachment":{"name":"字".repeat(1000),"bytes":9007199254740992_u64,"width":0,"height":-2,"mediaType":"x".repeat(200)}},
            {"type":"image","data":"sensitive inline bytes"},
            {"type":"file","attachment":null}
        ]}));
        assert_eq!(items[0].label(), "file");
        assert!(items[0].id.is_none());
        assert!(items[0].bytes.is_none());
        assert_eq!(items[1].name.as_ref().unwrap().chars().count(), 256);
        assert_eq!(items[1].media_type.as_ref().unwrap().len(), 128);
        assert!(items[1].bytes.is_none() && items[1].width.is_none() && items[1].height.is_none());
        assert_eq!(items[2].label(), "image");
        assert!(!serde_json::to_string(&items).unwrap().contains("sensitive"));
    }

    #[test]
    fn excessive_attachments_are_reported_and_empty_content_is_supported() {
        let (items, omitted) = collect(&json!({"content":vec![json!({"type":"file"}); 67]}));
        assert_eq!(items.len(), 64);
        assert_eq!(omitted, 3);
        assert!(collect(&Value::Null).0.is_empty());
        assert!(collect(&json!({"content":"invalid"})).0.is_empty());
    }
}
