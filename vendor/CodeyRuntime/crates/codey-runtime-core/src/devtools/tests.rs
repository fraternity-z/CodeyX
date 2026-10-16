use super::*;

#[test]
fn loopback_candidates_share_the_connection_budget_and_preserve_tls_identity() {
    for (url, first) in [
        (
            "ws://localhost:9229/devtools/page/ABC",
            "ws://127.0.0.1:9229/devtools/page/ABC",
        ),
        (
            "ws://[::1]:9229/devtools/page/ABC",
            "ws://127.0.0.1:9229/devtools/page/ABC",
        ),
        (
            "ws://localhost/devtools/page/ABC",
            "ws://127.0.0.1/devtools/page/ABC",
        ),
    ] {
        assert_eq!(websocket_connect_candidates(url), [first, url]);
    }
    for url in [
        "ws://127.0.0.1:9229/page",
        "wss://localhost:9229/page",
        "wss://codex.example/page",
        "ws://user:password@localhost/page",
        "invalid",
    ] {
        assert_eq!(websocket_connect_candidates(url), [url]);
    }
    assert_eq!(connect_attempt_timeout(0), CONNECT_TIMEOUT);
    assert_eq!(connect_attempt_timeout(1), CONNECT_TIMEOUT);
    assert_eq!(connect_attempt_timeout(2), CONNECT_TIMEOUT / 2);
    let connect = connect_websocket("ws://127.0.0.1:9229/page");
    assert!(std::mem::size_of_val(&connect) <= 1024);
}

#[test]
fn protocol_failures_are_typed_and_do_not_retain_remote_payloads() {
    for (code, message, kind, reconnect) in [
        (
            -32601,
            "private token",
            FailureKind::UnsupportedMethod,
            false,
        ),
        (
            -32602,
            "private token",
            FailureKind::InvalidParameters,
            false,
        ),
        (
            -32000,
            "Cannot find context with specified id",
            FailureKind::ContextLost,
            true,
        ),
        (
            -32000,
            "Execution context was destroyed.",
            FailureKind::ContextLost,
            true,
        ),
        (
            -32000,
            "Inspected target navigated or closed",
            FailureKind::ContextLost,
            true,
        ),
        (
            -32000,
            "Cannot find default execution context",
            FailureKind::ContextLost,
            true,
        ),
        (-32000, "private token", FailureKind::Rejected, false),
    ] {
        let error = command_result(
            json!({"id":7,"error":{"code":code,"message":message,"data":"private token"}}),
            "Runtime.evaluate",
            7,
        )
        .unwrap_err();
        let failure = error.downcast_ref::<ProtocolFailure>().unwrap();
        assert_eq!(failure.kind, kind);
        assert_eq!(failure.code, Some(code));
        assert_eq!(failure.method.as_deref(), Some("Runtime.evaluate"));
        assert_eq!(failure.command_id, Some(7));
        assert_eq!(failure.requires_reconnect(), reconnect);
        assert_eq!(failure.retryable_setup(), reconnect);
        assert!(!format!("{error:#}").contains("private token"));
        assert!(
            !serde_json::to_string(failure)
                .unwrap()
                .contains("private token")
        );
    }
    let response = json!({"id":7,"result":{"value":"ok"}});
    assert_eq!(
        command_result(response.clone(), "Runtime.enable", 7).unwrap(),
        response
    );
    for response in [
        json!({"id":8,"result":{}}),
        json!({"id":7}),
        json!({"id":7,"result":null}),
    ] {
        assert_eq!(
            command_result(response, "Runtime.enable", 7)
                .unwrap_err()
                .downcast_ref::<ProtocolFailure>()
                .unwrap()
                .kind,
            FailureKind::InvalidMessage
        );
    }
    let error = ensure_evaluate_succeeded(
        json!({"id":7,"result":{"exceptionDetails":{"text":"private token"}}}),
    )
    .unwrap_err();
    assert_eq!(
        error.downcast_ref::<ProtocolFailure>().unwrap().kind,
        FailureKind::ScriptException
    );
    assert!(!format!("{error:#}").contains("private token"));
    for kind in [
        FailureKind::Connection,
        FailureKind::Closed,
        FailureKind::Timeout,
    ] {
        assert!(ProtocolFailure::new("connect", kind, None, None).retryable_setup());
    }
}

#[tokio::test]
async fn shared_transport_sends_commands_and_reads_events_ping_and_close() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let command = read_message(&mut socket).await.unwrap().unwrap();
        assert_eq!(
            command,
            json!({"id":1,"method":"Runtime.enable","params":{}})
        );
        socket.send(Message::Ping(vec![1].into())).await.unwrap();
        assert!(matches!(socket.next().await, Some(Ok(Message::Pong(_)))));
        socket
            .send(Message::Text(
                json!({"method":"Debugger.paused","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({"id":1,"result":{}}).to_string().into(),
            ))
            .await
            .unwrap();
        socket.close(None).await.unwrap();
    });
    let mut socket = connect_websocket(&format!("ws://localhost:{}", address.port()))
        .await
        .unwrap();
    send_command(&mut socket, 1, "Runtime.enable", json!({}))
        .await
        .unwrap();
    assert_eq!(
        read_message(&mut socket).await.unwrap().unwrap()["method"],
        "Debugger.paused"
    );
    command_result(
        read_message(&mut socket).await.unwrap().unwrap(),
        "Runtime.enable",
        1,
    )
    .unwrap();
    assert!(read_message(&mut socket).await.unwrap().is_none());
    task.await.unwrap();
}

#[tokio::test]
async fn malformed_frames_do_not_echo_their_contents() {
    for message in [
        Message::Text("private token".into()),
        Message::Text("[]".into()),
        Message::Binary(b"private token".to_vec().into()),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket.send(message).await.unwrap();
        });
        let mut socket = connect_websocket(&format!("ws://{address}")).await.unwrap();
        let error = read_message(&mut socket).await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<ProtocolFailure>().unwrap().kind,
            FailureKind::InvalidMessage
        );
        assert!(!format!("{error:#}").contains("private token"));
        task.await.unwrap();
    }
}
