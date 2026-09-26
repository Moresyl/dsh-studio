//! A bounded market index shared by every window.
//!
//! Most HTTP catalogs are complete snapshots, so downloading one for every
//! keystroke is wasteful. npm and dshfind are query indexes; cache entries for
//! those sources include the normalized query while snapshot sources keep one
//! source-wide entry.

use std::cmp::Reverse;
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::Mutex;

use super::registry::Listing;
use crate::error::{Error, Result};

const PAGE_SIZE: usize = 25;
const CACHE_LIFETIME: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
struct Entry {
    items: Vec<Listing>,
    indexed_at: u64,
    fetched_at: Instant,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Listing>,
    pub categories: Vec<String>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
    pub has_more: bool,
    pub indexed_at: u64,
}

static CACHE: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Entry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct SearchOptions<'a> {
    pub query: &'a str,
    pub category: Option<&'a str>,
    pub sort: &'a str,
    pub page: usize,
    pub refresh: bool,
    pub available: Option<&'a BTreeSet<String>>,
}

pub async fn search(node: &Path, source_id: &str, options: SearchOptions<'_>) -> Result<Page> {
    let SearchOptions {
        query,
        category,
        sort,
        page,
        refresh,
        available,
    } = options;
    let normalized_query = query.trim().to_ascii_lowercase();
    let query_index = source_id == "npm" || source_id == super::catalog::DSHFIND_ID;
    let cache_key = if query_index {
        format!("{source_id}\0{normalized_query}")
    } else {
        source_id.to_string()
    };

    let cached = {
        let entries = cache().lock().await;
        entries
            .get(&cache_key)
            .filter(|entry| !refresh && entry.fetched_at.elapsed() < CACHE_LIFETIME)
            .cloned()
    };
    let entry = match cached {
        Some(entry) => entry,
        None => {
            let items = if source_id == "npm" {
                super::registry::search(node, &normalized_query).await?
            } else if source_id == super::catalog::DSHFIND_ID {
                super::catalog::search(source_id, &normalized_query).await?
            } else {
                // HTTP catalogs are indexed in full. Search, categories and
                // pages are then stable until the explicit refresh or TTL.
                super::catalog::search(source_id, "").await?
            };
            let entry = Entry {
                items,
                indexed_at: now(),
                fetched_at: Instant::now(),
            };
            cache().lock().await.insert(cache_key, entry.clone());
            entry
        }
    };

    let items = available_items(entry.items, available);
    page_items(
        items,
        &normalized_query,
        category,
        sort,
        page,
        entry.indexed_at,
    )
}

/// Filter the entire index before paging, so counts and empty states describe
/// the same set of packages that the user can browse.
fn available_items(items: Vec<Listing>, installed: Option<&BTreeSet<String>>) -> Vec<Listing> {
    let Some(installed) = installed else {
        return items;
    };
    items
        .into_iter()
        .filter(|item| item.installable && !installed.contains(&item.name))
        .collect()
}

pub async fn invalidate(source_id: &str) {
    let mut entries = cache().lock().await;
    entries.retain(|key, _| key != source_id && !key.starts_with(&format!("{source_id}\0")));
}

fn page_items(
    items: Vec<Listing>,
    query: &str,
    category: Option<&str>,
    sort: &str,
    requested_page: usize,
    indexed_at: u64,
) -> Result<Page> {
    let categories = items
        .iter()
        .flat_map(|item| item.categories.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let category = category.map(str::trim).filter(|value| !value.is_empty());
    let mut filtered: Vec<Listing> = items
        .into_iter()
        .filter(|item| {
            (query.is_empty()
                || format!("{} {} {}", item.name, item.description, item.publisher)
                    .to_ascii_lowercase()
                    .contains(query))
                && category.is_none_or(|wanted| {
                    item.categories
                        .iter()
                        .any(|candidate| candidate.eq_ignore_ascii_case(wanted))
                })
        })
        .collect();

    match sort {
        "relevance" => {}
        "updated" => filtered.sort_by_key(|item| Reverse(item.updated.clone())),
        "name" => filtered.sort_by_key(|item| item.name.to_ascii_lowercase()),
        "downloads" => filtered.sort_by_key(|item| Reverse(item.weekly_downloads)),
        other => return Err(Error::Plugin(format!("unknown catalog sort {other}"))),
    }

    let total = filtered.len();
    let last_page = total.saturating_sub(1) / PAGE_SIZE;
    let page = requested_page.min(last_page);
    let start = page * PAGE_SIZE;
    let items = filtered.into_iter().skip(start).take(PAGE_SIZE).collect();
    Ok(Page {
        items,
        categories,
        total,
        page,
        page_size: PAGE_SIZE,
        has_more: start + PAGE_SIZE < total,
        indexed_at,
    })
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{available_items, page_items, Listing};

    #[test]
    fn available_filter_precedes_pagination_and_preserves_discovery() {
        let mut items: Vec<_> = (0..60)
            .map(|n| listing(&format!("tool-{n:02}"), "agent", n))
            .collect();
        items[59].installable = false;
        let installed = (0..30).map(|n| format!("tool-{n:02}")).collect();
        assert_eq!(available_items(items.clone(), None).len(), 60);
        let filtered = available_items(items, Some(&installed));
        let first = page_items(filtered.clone(), "", None, "name", 0, 0).unwrap();
        assert_eq!(first.total, 29);
        assert_eq!(first.items.len(), 25);
        assert_eq!(first.items[0].name, "tool-30");
        assert!(first.has_more);
        let second = page_items(filtered, "", None, "name", 1, 0).unwrap();
        assert_eq!(second.items.len(), 4);
        assert!(!second.has_more);
    }

    fn listing(name: &str, category: &str, downloads: u64) -> Listing {
        Listing {
            name: name.into(),
            version: "1.0.0".into(),
            description: String::new(),
            publisher: String::new(),
            updated: String::new(),
            weekly_downloads: downloads,
            link: None,
            repository: None,
            source_id: "test".into(),
            source_label: "Test".into(),
            installable: true,
            categories: vec![category.into()],
            has_icon: false,
            icon: None,
        }
    }

    #[test]
    fn filters_sorts_and_pages_one_index() {
        let mut items = Vec::new();
        for number in 0..31 {
            items.push(listing(
                &format!("tool-{number:02}"),
                if number % 2 == 0 { "agent" } else { "theme" },
                number,
            ));
        }
        let first = page_items(items, "tool", Some("agent"), "downloads", 0, 42).unwrap();
        assert_eq!(first.total, 16);
        assert_eq!(first.items[0].name, "tool-30");
        assert_eq!(first.categories, vec!["agent", "theme"]);
        assert!(!first.has_more);
        assert_eq!(first.indexed_at, 42);
    }

    #[test]
    fn refuses_unknown_sort_and_clamps_a_stale_page() {
        let items = vec![listing("one", "agent", 1)];
        assert!(page_items(items.clone(), "", None, "newest", 0, 0).is_err());
        let page = page_items(items, "", None, "name", 99, 0).unwrap();
        assert_eq!(page.page, 0);
        assert_eq!(page.items.len(), 1);
    }
}
