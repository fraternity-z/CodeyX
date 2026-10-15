use super::*;

fn request(body: Value) -> Value {
    responses_to_gemini_request(&body).unwrap().body
}

fn response(chunks: &[Value], model: &str, bridge: &ResponsesToolBridge) -> Result<Value> {
    let mut accumulator = GeminiSseAccumulator::new(model);
    for chunk in chunks {
        accumulator.ingest_frame(&chunk.to_string(), false)?;
    }
    accumulator.into_responses(model, bridge)
}

fn completed(parts: Value) -> Value {
    json!({"candidates":[{"index":0,"content":{"role":"model","parts":parts},"finishReason":"STOP"}]})
}

fn sse_events(body: &str) -> Vec<Value> {
    let mut cursor = SseCursor::default();
    let mut events = Vec::new();
    while let Some(frame) = take_next_sse_frame(body.as_bytes(), &mut cursor) {
        if let Some(data) = sse_frame_data(frame).unwrap() {
            events.push(serde_json::from_str(&data).unwrap());
        }
    }
    events
}

#[test]
fn gemini_endpoints_keep_prefixes_and_encode_model_paths() {
    for (base, expected) in [
        ("https://example.test", "https://example.test/v1beta/models"),
        (
            "https://example.test/api/v1beta/",
            "https://example.test/api/v1beta/models",
        ),
        (
            "https://example.test/v1/models",
            "https://example.test/v1/models",
        ),
        (
            "https://example.test/api%20space/v1beta/models/old:streamGenerateContent?key=private&alt=sse#debug",
            "https://example.test/api%20space/v1beta/models",
        ),
        (
            "https://example.test/v1beta/models/old:generateContent",
            "https://example.test/v1beta/models",
        ),
    ] {
        assert_eq!(gemini_models_endpoint(base).unwrap(), expected);
        assert_eq!(
            gemini_content_endpoint(base, "models/gemini-test", false).unwrap(),
            format!("{expected}/gemini-test:generateContent")
        );
        assert_eq!(
            gemini_content_endpoint(base, "gemini-test", true).unwrap(),
            format!("{expected}/gemini-test:streamGenerateContent?alt=sse")
        );
    }
    for model in [
        "",
        "..",
        "models/",
        "../other",
        "model?key=secret",
        "model#fragment",
    ] {
        assert!(gemini_content_endpoint("https://example.test", model, true).is_err());
    }
    let encoded = gemini_content_endpoint("https://example.test", "model name", false).unwrap();
    assert!(encoded.ends_with("/model%20name:generateContent"));
}

#[test]
fn gemini_headers_use_only_route_google_credentials() {
    let mut profile = ProviderProfile::new("Gemini");
    profile.api_key = "gemini-key".into();
    profile.upstream_protocol = UPSTREAM_PROTOCOL_GEMINI.into();
    let headers = prepare_upstream_headers(&profile, UpstreamProtocol::Gemini).unwrap();
    assert_eq!(headers["x-goog-api-key"], "gemini-key");
    assert!(headers["x-goog-api-key"].is_sensitive());
    assert!(!headers.contains_key(AUTHORIZATION));
    assert!(!headers.contains_key("x-api-key"));
    profile
        .model_request_headers
        .insert("x-goog-api-key".into(), String::new());
    assert_eq!(
        prepare_upstream_headers(&profile, UpstreamProtocol::Gemini).unwrap()["x-goog-api-key"],
        "gemini-key"
    );
    profile
        .model_request_headers
        .insert("x-goog-api-key".into(), "custom-key".into());
    assert_eq!(
        prepare_upstream_headers(&profile, UpstreamProtocol::Gemini).unwrap()["x-goog-api-key"],
        "custom-key"
    );
    profile
        .model_request_headers
        .insert("Authorization".into(), "Bearer other".into());
    assert!(prepare_upstream_headers(&profile, UpstreamProtocol::Gemini).is_err());
    assert!(
        prepare_upstream_websocket_url(UpstreamProtocol::Gemini, "https://example.test").is_err()
    );
    assert_eq!(
        ProtocolBridge::from_upstream_protocol(UpstreamProtocol::Gemini),
        ProtocolBridge::ResponsesToGemini
    );
}

#[test]
fn gemini_request_converts_system_images_and_generation_options() {
    let converted = request(json!({
        "model":"gemini-2.5-flash", "stream":true, "instructions":"Keep answers concise",
        "input":[
            {"role":"developer","content":"Answer in Chinese"},
            {"role":"user","content":[
                {"type":"input_text","text":"Describe the image"},
                {"type":"input_image","image_url":"data:image/png;base64,aGVsbG8="},
                {"type":"input_image","image_url":"https://example.test/image.png"}
            ]}
        ],
        "reasoning":{"effort":"high"}, "max_output_tokens":20000,
        "temperature":0.5, "top_p":0.9, "top_k":10, "seed":7,
        "stop":["END"],
        "text":{"format":{"type":"json_schema","name":"answer","schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}}
    }));
    assert_eq!(
        converted["systemInstruction"]["parts"],
        json!([{"text":"Keep answers concise"},{"text":"Answer in Chinese"}])
    );
    assert_eq!(converted["contents"][0]["role"], "user");
    assert_eq!(
        converted["contents"][0]["parts"][1],
        json!({"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}})
    );
    assert_eq!(
        converted["contents"][0]["parts"][2],
        json!({"fileData":{"fileUri":"https://example.test/image.png"}})
    );
    assert_eq!(
        converted["generationConfig"]["thinkingConfig"],
        json!({"includeThoughts":true,"thinkingBudget":8192})
    );
    assert_eq!(converted["generationConfig"]["maxOutputTokens"], 20000);
    assert_eq!(converted["generationConfig"]["topP"], 0.9);
    assert_eq!(converted["generationConfig"]["topK"], 10);
    assert_eq!(
        converted["generationConfig"]["stopSequences"],
        json!(["END"])
    );
    assert_eq!(
        converted["generationConfig"]["responseMimeType"],
        "application/json"
    );
    assert_eq!(
        converted["generationConfig"]["responseJsonSchema"]["required"],
        json!(["text"])
    );
    assert!(converted.get("model").is_none());
    assert!(converted.get("stream").is_none());
    assert!(converted.get("messages").is_none());
}

#[test]
fn gemini_thinking_uses_model_specific_controls() {
    for (model, effort, expected) in [
        (
            "gemini-2.5-pro",
            "none",
            json!({"includeThoughts":true,"thinkingBudget":128}),
        ),
        (
            "gemini-2.5-flash",
            "none",
            json!({"includeThoughts":true,"thinkingBudget":0}),
        ),
        (
            "gemini-3-pro-preview",
            "medium",
            json!({"includeThoughts":true,"thinkingLevel":"HIGH"}),
        ),
        (
            "gemini-3-flash-preview",
            "medium",
            json!({"includeThoughts":true,"thinkingLevel":"MEDIUM"}),
        ),
        (
            "gemini-4-argon",
            "xhigh",
            json!({"includeThoughts":true,"thinkingLevel":"HIGH"}),
        ),
    ] {
        let value = request(json!({"model":model,"input":"hello","reasoning":{"effort":effort}}));
        assert_eq!(value["generationConfig"]["thinkingConfig"], expected);
    }
    assert!(
        request(json!({"model":"gemini-2.0-flash","input":"hello"}))
            .get("generationConfig")
            .is_none()
    );
}

#[test]
fn gemini_tools_keep_schemas_choices_namespaces_and_custom_calls() {
    let converted = responses_to_gemini_request(&json!({
        "model":"gemini-3-flash-preview", "input":"read",
        "tools":[
            {"type":"namespace","name":"files","tools":[{"type":"function","name":"read","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}}]},
            {"type":"custom","name":"patch","description":"Apply patch text"}
        ],
        "tool_choice":"required", "parallel_tool_calls":true,
    })).unwrap();
    let declarations = converted.body["tools"][0]["functionDeclarations"]
        .as_array()
        .unwrap();
    assert_eq!(declarations.len(), 2);
    assert_eq!(
        declarations[0]["parametersJsonSchema"]["required"],
        json!(["path"])
    );
    assert_eq!(
        converted.body["toolConfig"]["functionCallingConfig"]["mode"],
        "ANY"
    );
    let output = response(
        &[completed(json!([
            {"functionCall":{"name":declarations[0]["name"],"args":{"path":"a.rs"}}},
            {"functionCall":{"name":declarations[1]["name"],"args":{"input":"patch contents"}}}
        ]))],
        "gemini-3-flash-preview",
        &converted.tool_bridge,
    )
    .unwrap();
    assert_eq!(output["output"][0]["name"], "read");
    assert_eq!(output["output"][0]["namespace"], "files");
    assert_eq!(output["output"][1]["type"], "custom_tool_call");
    assert_eq!(output["output"][1]["input"], "patch contents");
    let chosen = request(json!({
        "model":"gemini-test","input":"read",
        "tools":[{"type":"function","name":"read","parameters":{"type":"object"}}],
        "tool_choice":{"type":"function","name":"read"}
    }));
    assert_eq!(
        chosen["toolConfig"]["functionCallingConfig"],
        json!({"mode":"ANY","allowedFunctionNames":["read"]})
    );
}

#[test]
fn gemini_history_replays_signatures_and_matches_parallel_results_by_id() {
    let parts = json!([
        {"text":"Inspect both files", "thought":true},
        {"text":"Reading files"},
        {"functionCall":{"id":"provider-call","name":"read","args":{"path":"a.rs"}},"thoughtSignature":"c2lnbmF0dXJlLTE="},
        {"functionCall":{"name":"read","args":{"path":"b.rs"}}}
    ]);
    let output = response(
        &[completed(parts.clone())],
        "gemini-3-flash-preview",
        &ResponsesToolBridge::default(),
    )
    .unwrap();
    assert_eq!(
        output["output"][0]["summary"][0]["text"],
        "Inspect both files"
    );
    assert!(output["output"][0].get("content").is_none());
    let calls = output["output"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "function_call")
        .collect::<Vec<_>>();
    let mut input = vec![json!({"role":"user","content":"Read two files"})];
    input.extend(output["output"].as_array().unwrap().clone());
    input.push(
        json!({"type":"function_call_output","call_id":calls[1]["call_id"],"output":"second"}),
    );
    input.push(
        json!({"type":"function_call_output","call_id":calls[0]["call_id"],"output":"first"}),
    );
    let converted = request(json!({"model":"gemini-3-flash-preview","input":input}));
    assert_eq!(converted["contents"][1]["parts"], parts);
    assert_eq!(
        converted["contents"][2]["parts"][0]["functionResponse"],
        json!({"id":"provider-call","name":"read","response":{"output":"first"}})
    );
    assert_eq!(
        converted["contents"][2]["parts"][1]["functionResponse"],
        json!({"name":"read","response":{"output":"second"}})
    );
}

#[test]
fn gemini_history_rejects_changed_signed_content_and_invalid_state() {
    let output = response(
        &[completed(json!([
            {"text":"original","thoughtSignature":"c2ln"}
        ]))],
        "gemini-test",
        &ResponsesToolBridge::default(),
    )
    .unwrap();
    let mut input = output["output"].clone();
    input[1]["content"][0]["text"] = json!("changed");
    assert!(
        responses_to_gemini_request(&json!({"model":"gemini-test","input":input}))
            .unwrap_err()
            .to_string()
            .contains("签名")
    );
    assert!(
        responses_to_gemini_request(&json!({"model":"gemini-test","input":[
            {"type":"reasoning","encrypted_content":"codey-gemini-v1:invalid"},
            {"role":"user","content":"hello"}
        ]}))
        .is_err()
    );
}

#[test]
fn gemini_state_is_not_forwarded_to_other_models_or_native_responses() {
    let output = response(&[completed(json!([
        {"text":"summary","thought":true},
        {"functionCall":{"id":"call-one","name":"lookup","args":{}},"thoughtSignature":"private-provider-state"}
    ]))], "gemini-original", &ResponsesToolBridge::default()).unwrap();
    let mut input = output["output"].as_array().unwrap().clone();
    input.push(json!({"type":"function_call_output","call_id":"call-one","output":"done"}));
    let converted = request(json!({"model":"gemini-other","input":input}));
    assert!(!converted.to_string().contains("private-provider-state"));
    assert_eq!(
        converted["contents"][0]["parts"][0]["thoughtSignature"],
        "skip_thought_signature_validator"
    );
    let mut native = json!({"model":"native-model","input":input});
    assert!(normalize_native_responses_context(&mut native, false));
    assert!(native["input"][0].get("encrypted_content").is_none());
    assert_eq!(native["input"][0]["summary"][0]["text"], "summary");
}

#[test]
fn gemini_tool_images_stay_inside_the_function_response() {
    let converted = request(json!({"model":"gemini-test","input":[
        {"type":"function_call","call_id":"image","name":"screenshot","arguments":"{}"},
        {"type":"function_call_output","call_id":"image","output":[
            {"type":"input_text","text":"Screenshot"},
            {"type":"input_image","image_url":"data:image/png;base64,aGVsbG8="}
        ]}
    ]}));
    assert_eq!(converted["contents"].as_array().unwrap().len(), 2);
    assert_eq!(
        converted["contents"][1]["parts"][0]["functionResponse"]["response"],
        json!({"output":"Screenshot"})
    );
    assert_eq!(
        converted["contents"][1]["parts"][0]["functionResponse"]["parts"][0]["inlineData"]["data"],
        "aGVsbG8="
    );
}

#[test]
fn gemini_rejects_unrepresentable_requests_before_sending() {
    for body in [
        json!({"model":"gemini-test","input":"hello","previous_response_id":"unknown"}),
        json!({"model":"gemini-test","input":"hello","tools":[{"type":"web_search"}]}),
        json!({"model":"gemini-test","input":"hello","tools":[{"type":"function","name":"read"}],"parallel_tool_calls":false}),
        json!({"model":"gemini-test","input":[{"type":"function_call","call_id":"missing","name":"read","arguments":"[]"}]}),
        json!({"model":"gemini-test","input":[{"type":"function_call_output","call_id":"unknown","output":"result"}]}),
        json!({"model":"gemini-test","input":[{"type":"function_call","call_id":"missing","name":"read","arguments":"{}"}]}),
        json!({"model":"gemini-test","input":"hello","max_output_tokens":0}),
        json!({"model":"gemini-test","input":"hello","logprobs":true}),
        json!({"model":"gemini-test","input":"hello","tool_choice":"required"}),
    ] {
        assert!(responses_to_gemini_request(&body).is_err(), "{body}");
    }
}

#[test]
fn gemini_sse_keeps_final_empty_signature_and_late_usage() {
    let frames = [
        json!({"modelVersion":"gemini-actual","candidates":[{"index":0,"content":{"parts":[{"text":"hello "}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":1}}),
        json!({"candidates":[{"index":0,"content":{"parts":[{"text":"world"}]}}]}),
        completed(json!([{"text":"","thoughtSignature":"c2ln"}])),
        json!({"usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":4,"candidatesTokenCount":3,"thoughtsTokenCount":2,"totalTokenCount":15}}),
    ];
    let bytes = frames
        .iter()
        .map(|frame| format!("data: {frame}\r\n\r\n"))
        .collect::<String>();
    let mut accumulator = GeminiSseAccumulator::new("gemini-alias");
    parse_sse_frames(bytes.as_bytes(), &mut accumulator).unwrap();
    let output = accumulator
        .into_responses("gemini-alias", &ResponsesToolBridge::default())
        .unwrap();
    assert_eq!(output["output_text"], "hello world");
    assert_eq!(output["model"], "gemini-actual");
    assert_eq!(output["usage"]["input_tokens"], 10);
    assert_eq!(output["usage"]["input_tokens_details"]["cached_tokens"], 4);
    assert_eq!(output["usage"]["output_tokens"], 5);
    assert_eq!(
        output["usage"]["output_tokens_details"]["reasoning_tokens"],
        2
    );
    assert_eq!(output["usage"]["total_tokens"], 15);
    let mut input = output["output"].as_array().unwrap().clone();
    input.push(json!({"role":"user","content":"next"}));
    let next = request(json!({"model":"gemini-alias","input":input}));
    assert_eq!(
        next["contents"][0]["parts"],
        json!([{"text":"hello "},{"text":"world"},{"text":"","thoughtSignature":"c2ln"}])
    );
}

#[test]
fn gemini_terminal_validation_never_reports_truncation_or_errors_as_success() {
    let bridge = ResponsesToolBridge::default();
    for value in [
        json!({"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}),
        json!({"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow down"}}),
        completed(json!([{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}}])),
        completed(json!([{"functionCall":{"name":"tool","partialArgs":[]}}])),
        json!({"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL"}]}),
        json!({"candidates":[]}),
    ] {
        assert!(
            response(std::slice::from_ref(&value), "gemini-test", &bridge).is_err(),
            "{value}"
        );
    }
    for (value, reason) in [
        (
            json!({"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"MAX_TOKENS"}]}),
            "max_output_tokens",
        ),
        (
            json!({"promptFeedback":{"blockReason":"SAFETY"}}),
            "content_filter",
        ),
        (
            json!({"candidates":[{"finishReason":"SAFETY"}]}),
            "content_filter",
        ),
    ] {
        let result = response(&[value], "gemini-test", &bridge).unwrap();
        assert_eq!(result["status"], "incomplete");
        assert_eq!(result["incomplete_details"]["reason"], reason);
    }
}

#[test]
fn gemini_stream_errors_preserve_status_retry_semantics_and_redact_keys() {
    let (config, provider, model) = gemini_router_config("https://example.test/v1beta".into());
    let resolved = RouterSnapshot::from_config(&config)
        .target_for_model(&model_alias(&provider, &model))
        .unwrap();
    for (status, code, expected) in [
        (400, "INVALID_ARGUMENT", "invalid_prompt"),
        (401, "UNAUTHENTICATED", "invalid_prompt"),
        (403, "PERMISSION_DENIED", "invalid_prompt"),
        (429, "RESOURCE_EXHAUSTED", "rate_limit_exceeded"),
        (503, "UNAVAILABLE", "upstream_stream_error"),
    ] {
        let mut accumulator = GeminiSseAccumulator::new(&model);
        let error = accumulator.ingest_frame(&json!({"error":{"code":status,"status":code,"message":"upstream rejected key sk-upstream"}}).to_string(), false).unwrap_err();
        let failure = streaming_response_failure(&error, &resolved.route, None);
        let event = failure.normalized_event();
        assert_eq!(event["response"]["error"]["code"], expected, "{event}");
        assert_eq!(event["response"]["error"]["codey"]["httpStatus"], status);
        assert!(!event.to_string().contains("sk-upstream"));
    }
    assert!(is_context_length_error(
        &json!({"error":{"code":400,"message":"The input token count (120) exceeds the maximum number of tokens allowed (100)."}})
    ));
}

fn gemini_router_config(base: String) -> (CodeyConfig, String, String) {
    let (mut config, provider, model) = super::tests::router_config(base);
    config.profiles[0].upstream_protocol = UPSTREAM_PROTOCOL_GEMINI.into();
    config.profiles[0].normalize();
    (config, provider, model)
}

async fn write_upstream(stream: &mut TcpStream, body: &str, content_type: &str) {
    stream.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

#[tokio::test]
async fn gemini_route_converts_json_sse_and_mislabeled_streams() {
    for downstream_stream in [false, true] {
        for upstream_sse in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request_preserving_query(&mut socket)
                    .await
                    .unwrap();
                assert_eq!(
                    request.path,
                    "/api/v1beta/models/provider-model:streamGenerateContent?alt=sse"
                );
                assert_eq!(
                    incoming_header(&request, "x-goog-api-key"),
                    Some("sk-upstream")
                );
                assert!(incoming_header(&request, "authorization").is_none());
                assert!(incoming_header(&request, "x-api-key").is_none());
                assert!(incoming_header(&request, "chatgpt-account-id").is_none());
                let body: Value = serde_json::from_slice(&request.body).unwrap();
                assert_eq!(body["contents"][0]["parts"][0]["text"], "hello");
                assert!(body.get("model").is_none());
                assert!(body.get("stream").is_none());
                let chunk = completed(json!([{"text":"你好"}]));
                let body = if upstream_sse {
                    format!("data: {chunk}\n\n")
                } else {
                    chunk.to_string()
                };
                write_upstream(&mut socket, &body, "application/json").await;
            });
            let (config, provider, model) =
                gemini_router_config(format!("http://{address}/api/v1beta"));
            let router = LocalRouter::start(&config).await.unwrap();
            let endpoint = router.endpoint();
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap();
            let result = client.post(format!("{}/responses", endpoint.base_url)).bearer_auth(&endpoint.token)
                .header("x-goog-api-key", "incoming-key").header("chatgpt-account-id", "private-account")
                .json(&json!({"model":model_alias(&provider,&model),"input":"hello","stream":downstream_stream})).send().await.unwrap();
            assert_eq!(result.status(), reqwest::StatusCode::OK);
            let body = result.text().await.unwrap();
            let result: Value = if downstream_stream {
                let events = sse_events(&body);
                events
                    .iter()
                    .find(|event| event["type"] == "response.completed")
                    .unwrap_or_else(|| panic!("{body}"))
                    .get("response")
                    .unwrap()
                    .clone()
            } else {
                serde_json::from_str(&body).unwrap()
            };
            assert_eq!(result["status"], "completed");
            assert_eq!(result["output_text"], "你好");
            server.await.unwrap();
            router.stop().await.unwrap();
        }
    }
}

#[tokio::test]
async fn gemini_route_emits_text_before_upstream_finishes_and_replays_the_signature() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release, wait) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_http_request_preserving_query(&mut socket)
            .await
            .unwrap();
        socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n").await.unwrap();
        let first = json!({"candidates":[{"content":{"parts":[{"text":"early text"}]}}]});
        write_chunked_frame(
            &mut socket,
            format!("data: {first}\n\n").as_bytes(),
            "test stream",
        )
        .await
        .unwrap();
        wait.await.unwrap();
        let last = completed(json!([{"text":"","thoughtSignature":"c2ln"}]));
        write_chunked_frame(
            &mut socket,
            format!("data: {last}\n\n").as_bytes(),
            "test stream",
        )
        .await
        .unwrap();
        socket.write_all(b"0\r\n\r\n").await.unwrap();
        let (mut next, _) = listener.accept().await.unwrap();
        let request = read_http_request_preserving_query(&mut next).await.unwrap();
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(
            body["contents"][1]["parts"],
            json!([{"text":"early text"},{"text":"","thoughtSignature":"c2ln"}])
        );
        write_upstream(
            &mut next,
            &completed(json!([{"text":"next answer"}])).to_string(),
            "application/json",
        )
        .await;
    });
    let (config, provider, model) = gemini_router_config(format!("http://{address}"));
    let router = LocalRouter::start(&config).await.unwrap();
    let endpoint = router.endpoint();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let mut result = client
        .post(format!("{}/responses", endpoint.base_url))
        .bearer_auth(&endpoint.token)
        .json(&json!({"model":model_alias(&provider,&model),"input":"hello","stream":true}))
        .send()
        .await
        .unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(chunk) = result.chunk().await.unwrap() {
            bytes.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&bytes).contains("response.output_text.delta") {
                return;
            }
        }
        panic!("stream ended without early text");
    })
    .await
    .unwrap();
    release.send(()).unwrap();
    while let Some(chunk) = result.chunk().await.unwrap() {
        bytes.extend_from_slice(&chunk);
    }
    let events = sse_events(std::str::from_utf8(&bytes).unwrap());
    let completed = &events
        .iter()
        .find(|event| event["type"] == "response.completed")
        .unwrap()["response"];
    let mut input = vec![json!({"role":"user","content":"hello"})];
    input.extend(completed["output"].as_array().unwrap().clone());
    input.push(json!({"role":"user","content":"next"}));
    let result: Value = client
        .post(format!("{}/responses", endpoint.base_url))
        .bearer_auth(&endpoint.token)
        .json(&json!({"model":model_alias(&provider,&model),"input":input}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(result["output_text"], "next answer");
    server.await.unwrap();
    router.stop().await.unwrap();
}

#[tokio::test]
async fn gemini_websocket_continuation_restores_signed_tool_history() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for round in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request_preserving_query(&mut socket)
                .await
                .unwrap();
            assert_eq!(
                request.path,
                "/v1beta/models/provider-model:streamGenerateContent?alt=sse"
            );
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            assert!(body.get("previous_response_id").is_none());
            let parts = if round == 0 {
                assert_eq!(body["contents"][0]["parts"][0]["text"], "look up");
                json!([{"functionCall":{"id":"lookup-one","name":"lookup","args":{"query":"hello"}},"thoughtSignature":"c2ln"}])
            } else {
                assert_eq!(body["contents"][0]["parts"][0]["text"], "look up");
                assert_eq!(body["contents"][1]["parts"][0]["thoughtSignature"], "c2ln");
                assert_eq!(
                    body["contents"][2]["parts"][0]["functionResponse"],
                    json!({"id":"lookup-one","name":"lookup","response":{"output":"found"}})
                );
                json!([{"text":"done"}])
            };
            write_upstream(
                &mut socket,
                &format!("data: {}\n\n", completed(parts)),
                "text/event-stream",
            )
            .await;
        }
    });
    let (config, provider, model) = gemini_router_config(format!("http://{address}"));
    let router = LocalRouter::start(&config).await.unwrap();
    let mut socket = super::tests::connect_router_websocket(&router.endpoint()).await;
    let mut previous = Value::Null;
    for round in 0..2 {
        let mut request = json!({
            "type":"response.create", "model":model_alias(&provider,&model), "stream":true,
            "input":if round == 0 { json!("look up") } else { json!([{"type":"function_call_output","call_id":"lookup-one","output":"found"}]) },
            "tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{"query":{"type":"string"}}}}]
        });
        if round != 0 {
            request["previous_response_id"] = previous.clone();
        }
        socket
            .send(WebSocketMessage::Text(request.to_string().into()))
            .await
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame = socket.next().await.unwrap().unwrap();
                if let WebSocketMessage::Text(text) = frame {
                    let event: Value = serde_json::from_str(text.as_str()).unwrap();
                    assert!(
                        !matches!(
                            event["type"].as_str(),
                            Some("response.failed" | "response.incomplete" | "error")
                        ),
                        "{event}"
                    );
                    if event["type"] == "response.completed" {
                        break event["response"].clone();
                    }
                }
            }
        })
        .await
        .unwrap();
        previous = result["id"].clone();
        if round == 1 {
            assert_eq!(result["output_text"], "done");
        }
    }
    socket.close(None).await.unwrap();
    server.await.unwrap();
    router.stop().await.unwrap();
}

#[tokio::test]
async fn gemini_route_reports_truncated_stream_as_failed() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_http_request_preserving_query(&mut socket)
            .await
            .unwrap();
        let partial = json!({"candidates":[{"content":{"parts":[{"text":"partial"}]}}]});
        write_upstream(
            &mut socket,
            &format!("data: {partial}\n\n"),
            "text/event-stream",
        )
        .await;
    });
    let (config, provider, model) = gemini_router_config(format!("http://{address}"));
    let router = LocalRouter::start(&config).await.unwrap();
    let endpoint = router.endpoint();
    let body = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
        .post(format!("{}/responses", endpoint.base_url))
        .bearer_auth(&endpoint.token)
        .json(&json!({"model":model_alias(&provider,&model),"input":"hello","stream":true}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(body.contains("response.failed"), "{body}");
    assert!(!body.contains("response.completed"), "{body}");
    server.await.unwrap();
    router.stop().await.unwrap();
}

#[tokio::test]
async fn gemini_route_compaction_uses_a_normal_generation_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_http_request_preserving_query(&mut socket)
            .await
            .unwrap();
        assert_eq!(
            request.path,
            "/v1beta/models/provider-model:streamGenerateContent?alt=sse"
        );
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert!(body.get("tools").is_none());
        assert!(body.to_string().contains("交接摘要"));
        write_upstream(
            &mut socket,
            &completed(json!([{"text":"Task summary"}])).to_string(),
            "application/json",
        )
        .await;
    });
    let (config, provider, model) = gemini_router_config(format!("http://{address}"));
    let router = LocalRouter::start(&config).await.unwrap();
    let endpoint = router.endpoint();
    let result: Value = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(10)).build().unwrap()
        .post(format!("{}/responses", endpoint.base_url)).bearer_auth(&endpoint.token)
        .json(&json!({"model":model_alias(&provider,&model),"input":[{"role":"user","content":"Summarize this task"},{"type":"compaction_trigger"}]}))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(result["output"][0]["type"], "compaction", "{result}");
    assert_eq!(
        codey_summary_message(&result["output"][0])
            .unwrap()
            .unwrap()["content"][0]["text"],
        "Task summary"
    );
    server.await.unwrap();
    router.stop().await.unwrap();
}
