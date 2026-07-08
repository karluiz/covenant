use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::framing::{encode_frame, FrameDecoder};
use crate::LspError;

pub struct LspServer {
    child: Child,
    outgoing: mpsc::Sender<String>,
}

impl LspServer {
    pub async fn spawn(
        bin: &Path,
        args: &[String],
        cwd: &Path,
        on_message: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> Result<LspServer, LspError> {
        let mut child = Command::new(bin)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| LspError::Spawn(format!("{}: {e}", bin.display())))?;

        let mut stdin = child.stdin.take().ok_or_else(|| LspError::Spawn("no stdin".into()))?;
        let mut stdout = child.stdout.take().ok_or_else(|| LspError::Spawn("no stdout".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| LspError::Spawn("no stderr".into()))?;

        // Writer pump: frame and forward outgoing messages.
        let (outgoing, mut outgoing_rx) = mpsc::channel::<String>(256);
        tokio::spawn(async move {
            while let Some(msg) = outgoing_rx.recv().await {
                if stdin.write_all(&encode_frame(&msg)).await.is_err() {
                    break;
                }
            }
        });

        // Reader pump: de-frame stdout, fire callback per message.
        // on_exit fires when stdout closes (process gone).
        tokio::spawn(async move {
            let mut decoder = FrameDecoder::new();
            let mut buf = [0u8; 64 * 1024];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for msg in decoder.push(&buf[..n]) {
                            on_message(msg);
                        }
                    }
                }
            }
            on_exit(None);
        });

        // stderr → tracing, never blocks the reader.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "lsp_server_stderr", "{line}");
            }
        });

        Ok(LspServer { child, outgoing })
    }

    pub async fn send(&self, msg: String) {
        if self.outgoing.send(msg).await.is_err() {
            tracing::warn!("lsp send after server exit");
        }
    }

    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc as tokio_mpsc;

    #[tokio::test]
    async fn roundtrip_through_cat() {
        let (tx, mut rx) = tokio_mpsc::unbounded_channel::<String>();
        let mut srv = LspServer::spawn(
            std::path::Path::new("/bin/cat"),
            &[],
            std::path::Path::new("/tmp"),
            move |msg| { let _ = tx.send(msg); },
            |_| {},
        )
        .await
        .expect("spawn cat");

        srv.send(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#.to_string()).await;
        let echoed = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for echo")
            .expect("echo back");
        assert_eq!(echoed, r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
        srv.kill().await;
    }

    #[tokio::test]
    async fn exit_callback_fires_on_kill() {
        let (tx, mut rx) = tokio_mpsc::unbounded_channel::<Option<i32>>();
        let mut srv = LspServer::spawn(
            std::path::Path::new("/bin/cat"),
            &[],
            std::path::Path::new("/tmp"),
            |_| {},
            move |code| { let _ = tx.send(code); },
        )
        .await
        .expect("spawn cat");
        srv.kill().await;
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for exit callback");
    }
}
