use crate::{store::Result, ScoreStore, User};
use rusqlite::{params, OptionalExtension};

pub fn current(store: &ScoreStore) -> Result<Option<User>> {
    let c = store.connection();
    let c = c.lock().unwrap();
    let row = c
        .query_row(
            "SELECT github_id, login, avatar_url, connected_at_ms
             FROM user_session WHERE id = 1",
            [],
            |r| {
                Ok(User {
                    github_id: r.get(0)?,
                    login: r.get(1)?,
                    avatar_url: r.get(2)?,
                    connected_at_ms: r.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn set_current(store: &ScoreStore, u: &User) -> Result<()> {
    let c = store.connection();
    let c = c.lock().unwrap();
    c.execute(
        "INSERT INTO user_session(id, github_id, login, avatar_url, connected_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            github_id=excluded.github_id,
            login=excluded.login,
            avatar_url=excluded.avatar_url,
            connected_at_ms=excluded.connected_at_ms",
        params![u.github_id, u.login, u.avatar_url, u.connected_at_ms],
    )?;
    Ok(())
}

pub fn clear(store: &ScoreStore) -> Result<()> {
    let c = store.connection();
    let c = c.lock().unwrap();
    c.execute("DELETE FROM user_session WHERE id = 1", [])?;
    Ok(())
}
