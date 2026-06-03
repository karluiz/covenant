//! Persistent store for the browser favorites tree.
//!
//! Single SQLite file, adjacency-list tree with fractional `position` indexing so a
//! reorder/move is a single-row write. Arbitrary nesting via `parent_id` self-reference
//! with `ON DELETE CASCADE` (folder delete removes its contents).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// A node in the favorites tree. `children` is populated only by [`Favorites::tree`].
#[derive(Debug, Clone, Serialize)]
pub struct FavNode {
    pub id: String,
    pub parent_id: Option<String>,
    /// "folder" | "link"
    pub kind: String,
    pub title: String,
    pub url: Option<String>,
    pub position: f64,
    pub collapsed: bool,
    pub created_at: i64,
    pub children: Vec<FavNode>,
}

pub struct Favorites {
    conn: Connection,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Favorites {
    /// Open (and migrate) the favorites database at `path`.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// In-memory database, for tests.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS favorites (
                 id          TEXT PRIMARY KEY,
                 parent_id   TEXT REFERENCES favorites(id) ON DELETE CASCADE,
                 kind        TEXT NOT NULL,
                 title       TEXT NOT NULL,
                 url         TEXT,
                 position    REAL NOT NULL,
                 collapsed   INTEGER NOT NULL DEFAULT 0,
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_fav_parent ON favorites(parent_id, position);",
        )?;
        Ok(Self { conn })
    }

    /// Full tree, nested, each level ordered by `position`.
    pub fn tree(&self) -> Result<Vec<FavNode>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, parent_id, kind, title, url, position, collapsed, created_at
             FROM favorites ORDER BY position ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(FavNode {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                kind: r.get(2)?,
                title: r.get(3)?,
                url: r.get(4)?,
                position: r.get(5)?,
                collapsed: r.get::<_, i64>(6)? != 0,
                created_at: r.get(7)?,
                children: Vec::new(),
            })
        })?;
        let mut flat: Vec<FavNode> = Vec::new();
        for row in rows {
            flat.push(row?);
        }
        Ok(nest(flat))
    }

    fn get(&self, id: &str) -> Result<FavNode> {
        self.conn
            .query_row(
                "SELECT id, parent_id, kind, title, url, position, collapsed, created_at
                 FROM favorites WHERE id = ?1",
                params![id],
                |r| {
                    Ok(FavNode {
                        id: r.get(0)?,
                        parent_id: r.get(1)?,
                        kind: r.get(2)?,
                        title: r.get(3)?,
                        url: r.get(4)?,
                        position: r.get(5)?,
                        collapsed: r.get::<_, i64>(6)? != 0,
                        created_at: r.get(7)?,
                        children: Vec::new(),
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(id.to_string()))
    }

    /// Add a node at the end of `parent_id`'s child list.
    pub fn add(
        &self,
        parent_id: Option<&str>,
        kind: &str,
        title: &str,
        url: Option<&str>,
    ) -> Result<FavNode> {
        if kind != "folder" && kind != "link" {
            return Err(StoreError::Invalid(format!("kind: {kind}")));
        }
        if kind == "link" && url.is_none() {
            return Err(StoreError::Invalid("link requires url".into()));
        }
        let id = ulid::Ulid::new().to_string();
        let position = self.max_position(parent_id)? + 1.0;
        let created_at = now_millis();
        self.conn.execute(
            "INSERT INTO favorites (id, parent_id, kind, title, url, position, collapsed, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
            params![id, parent_id, kind, title, url, position, created_at],
        )?;
        self.get(&id)
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE favorites SET title = ?2 WHERE id = ?1",
            params![id, title],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn set_collapsed(&self, id: &str, collapsed: bool) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE favorites SET collapsed = ?2 WHERE id = ?1",
            params![id, collapsed as i64],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Delete a node; children cascade.
    pub fn delete(&self, id: &str) -> Result<()> {
        let n = self
            .conn
            .execute("DELETE FROM favorites WHERE id = ?1", params![id])?;
        if n == 0 {
            return Err(StoreError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Move `id` under `new_parent_id`, positioned between `after_id` (the node it should
    /// follow) and `before_id` (the node it should precede). Both neighbours optional.
    pub fn move_node(
        &self,
        id: &str,
        new_parent_id: Option<&str>,
        after_id: Option<&str>,
        before_id: Option<&str>,
    ) -> Result<()> {
        // Guard against cycles: a node cannot be moved into itself or its own descendant.
        if let Some(parent) = new_parent_id {
            if parent == id || self.is_descendant(parent, id)? {
                return Err(StoreError::Invalid("cannot move into own subtree".into()));
            }
        }
        let after = after_id.map(|a| self.position_of(a)).transpose()?;
        let before = before_id.map(|b| self.position_of(b)).transpose()?;
        let position = match (after, before) {
            (Some(a), Some(b)) => (a + b) / 2.0,
            (Some(a), None) => a + 1.0,
            (None, Some(b)) => b - 1.0,
            (None, None) => self.max_position(new_parent_id)? + 1.0,
        };
        let n = self.conn.execute(
            "UPDATE favorites SET parent_id = ?2, position = ?3 WHERE id = ?1",
            params![id, new_parent_id, position],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(id.to_string()));
        }
        Ok(())
    }

    fn position_of(&self, id: &str) -> Result<f64> {
        self.conn
            .query_row(
                "SELECT position FROM favorites WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::NotFound(id.to_string()))
    }

    fn max_position(&self, parent_id: Option<&str>) -> Result<f64> {
        let max: Option<f64> = match parent_id {
            Some(p) => self.conn.query_row(
                "SELECT MAX(position) FROM favorites WHERE parent_id = ?1",
                params![p],
                |r| r.get(0),
            )?,
            None => self.conn.query_row(
                "SELECT MAX(position) FROM favorites WHERE parent_id IS NULL",
                [],
                |r| r.get(0),
            )?,
        };
        Ok(max.unwrap_or(0.0))
    }

    /// Is `maybe_descendant` inside the subtree rooted at `ancestor`?
    fn is_descendant(&self, maybe_descendant: &str, ancestor: &str) -> Result<bool> {
        let mut cur = Some(maybe_descendant.to_string());
        while let Some(id) = cur {
            let parent: Option<String> = self
                .conn
                .query_row(
                    "SELECT parent_id FROM favorites WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            match parent {
                Some(p) if p == ancestor => return Ok(true),
                other => cur = other,
            }
        }
        Ok(false)
    }
}

/// Assemble a flat, position-ordered list into a nested tree.
fn nest(flat: Vec<FavNode>) -> Vec<FavNode> {
    use std::collections::HashMap;
    // children_of[parent] = ordered child ids; flat is already position-ordered.
    let mut children_of: HashMap<Option<String>, Vec<String>> = HashMap::new();
    let mut by_id: HashMap<String, FavNode> = HashMap::new();
    for node in flat {
        children_of
            .entry(node.parent_id.clone())
            .or_default()
            .push(node.id.clone());
        by_id.insert(node.id.clone(), node);
    }
    build(&None, &children_of, &mut by_id)
}

fn build(
    parent: &Option<String>,
    children_of: &std::collections::HashMap<Option<String>, Vec<String>>,
    by_id: &mut std::collections::HashMap<String, FavNode>,
) -> Vec<FavNode> {
    let ids = children_of.get(parent).cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(mut node) = by_id.remove(&id) {
            node.children = build(&Some(id.clone()), children_of, by_id);
            out.push(node);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Favorites {
        Favorites::open_in_memory().unwrap()
    }

    #[test]
    fn add_and_tree_orders_by_position() {
        let f = db();
        f.add(None, "link", "A", Some("https://a.com")).unwrap();
        f.add(None, "link", "B", Some("https://b.com")).unwrap();
        let tree = f.tree().unwrap();
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].title, "A");
        assert_eq!(tree[1].title, "B");
    }

    #[test]
    fn link_requires_url() {
        let f = db();
        assert!(f.add(None, "link", "no url", None).is_err());
        assert!(f.add(None, "folder", "ok", None).is_ok());
    }

    #[test]
    fn delete_cascades_to_children() {
        let f = db();
        let folder = f.add(None, "folder", "F", None).unwrap();
        f.add(Some(&folder.id), "link", "child", Some("https://c.com"))
            .unwrap();
        f.delete(&folder.id).unwrap();
        assert!(f.tree().unwrap().is_empty());
    }

    #[test]
    fn move_between_neighbours_sets_midpoint() {
        let f = db();
        let a = f.add(None, "link", "A", Some("https://a.com")).unwrap();
        let b = f.add(None, "link", "B", Some("https://b.com")).unwrap();
        let c = f.add(None, "link", "C", Some("https://c.com")).unwrap();
        // Move C between A and B.
        f.move_node(&c.id, None, Some(&a.id), Some(&b.id)).unwrap();
        let tree = f.tree().unwrap();
        let order: Vec<_> = tree.iter().map(|n| n.title.as_str()).collect();
        assert_eq!(order, vec!["A", "C", "B"]);
    }

    #[test]
    fn move_into_folder_reparents() {
        let f = db();
        let folder = f.add(None, "folder", "F", None).unwrap();
        let link = f.add(None, "link", "L", Some("https://l.com")).unwrap();
        f.move_node(&link.id, Some(&folder.id), None, None).unwrap();
        let tree = f.tree().unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].title, "L");
    }

    #[test]
    fn cannot_move_into_own_subtree() {
        let f = db();
        let outer = f.add(None, "folder", "outer", None).unwrap();
        let inner = f.add(Some(&outer.id), "folder", "inner", None).unwrap();
        assert!(f.move_node(&outer.id, Some(&inner.id), None, None).is_err());
        assert!(f.move_node(&outer.id, Some(&outer.id), None, None).is_err());
    }

    #[test]
    fn collapsed_persists() {
        let f = db();
        let folder = f.add(None, "folder", "F", None).unwrap();
        f.set_collapsed(&folder.id, true).unwrap();
        assert!(f.tree().unwrap()[0].collapsed);
    }
}
