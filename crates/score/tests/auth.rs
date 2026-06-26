use karl_score::auth::{fetch_user, poll_token, start_device_flow, DeviceTokenResponse};

#[tokio::test]
async fn start_device_flow_parses_response() {
    let mut server = mockito::Server::new_async().await;
    let _m = server
        .mock("POST", "/login/device/code")
        .match_body(mockito::Matcher::AllOf(vec![
            mockito::Matcher::UrlEncoded(
                "client_id".into(),
                karl_score::auth::GITHUB_CLIENT_ID.into(),
            ),
            mockito::Matcher::UrlEncoded("scope".into(), "repo".into()),
        ]))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{
            "device_code": "abc123",
            "user_code": "WDJB-MJHT",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_in": 900
        }"#,
        )
        .create_async()
        .await;
    let resp = start_device_flow(&server.url()).await.unwrap();
    assert_eq!(resp.user_code, "WDJB-MJHT");
    assert_eq!(resp.interval, 5);
}

#[tokio::test]
async fn poll_token_handles_pending() {
    let mut server = mockito::Server::new_async().await;
    let _m = server
        .mock("POST", "/login/oauth/access_token")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"error":"authorization_pending"}"#)
        .create_async()
        .await;
    let resp = poll_token(&server.url(), "abc").await.unwrap();
    assert!(matches!(resp, DeviceTokenResponse::Pending { .. }));
}

#[tokio::test]
async fn poll_token_handles_success() {
    let mut server = mockito::Server::new_async().await;
    let _m = server
        .mock("POST", "/login/oauth/access_token")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"access_token":"ghu_xxx","token_type":"bearer","scope":""}"#)
        .create_async()
        .await;
    let resp = poll_token(&server.url(), "abc").await.unwrap();
    assert!(matches!(resp, DeviceTokenResponse::Success { .. }));
}

#[tokio::test]
async fn fetch_user_parses_github_user() {
    let mut server = mockito::Server::new_async().await;
    let _m = server
        .mock("GET", "/user")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"id": 12345, "login": "karluiz", "avatar_url": "https://avatars/x"}"#)
        .create_async()
        .await;
    let u = fetch_user(&server.url(), "tok").await.unwrap();
    assert_eq!(u.github_id, 12345);
    assert_eq!(u.login, "karluiz");
    assert_eq!(u.avatar_url, "https://avatars/x");
}
