use super::*;

pub(crate) fn validate_gemini_part(part: &Value) -> Result<()> {
    let object = part.as_object().context("Gemini part 必须是对象")?;
    anyhow::ensure!(
        object.keys().all(|key| matches!(
            key.as_str(),
            "text" | "functionCall" | "thought" | "thoughtSignature" | "partMetadata"
        )),
        "Gemini 返回了无法转换的媒体或内置工具内容"
    );
    anyhow::ensure!(
        part.get("thoughtSignature").is_none_or(Value::is_string),
        "Gemini thoughtSignature 必须是字符串"
    );
    anyhow::ensure!(
        part.get("thought").is_none_or(Value::is_boolean),
        "Gemini thought 必须是布尔值"
    );
    if let Some(call) = part.get("functionCall") {
        let call = call.as_object().context("Gemini functionCall 必须是对象")?;
        anyhow::ensure!(
            call.keys()
                .all(|key| matches!(key.as_str(), "id" | "name" | "args")),
            "Gemini 返回了不支持的工具参数增量"
        );
        anyhow::ensure!(
            part.get("text").is_none() && part["thought"] != true,
            "Gemini functionCall part 同时包含文本或思考内容"
        );
        anyhow::ensure!(
            call.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty()),
            "Gemini functionCall 缺少 name"
        );
        anyhow::ensure!(
            call.get("args").is_none_or(Value::is_object),
            "Gemini functionCall.args 必须是对象"
        );
        anyhow::ensure!(
            call.get("id").is_none_or(Value::is_string),
            "Gemini functionCall.id 必须是字符串"
        );
    } else {
        anyhow::ensure!(
            part.get("text").is_none_or(Value::is_string),
            "Gemini text 必须是字符串"
        );
        anyhow::ensure!(
            part.get("text").is_some() || part.get("thoughtSignature").is_some(),
            "Gemini part 缺少可转换的文本或工具调用"
        );
    }
    Ok(())
}

pub(crate) struct GeminiSseAccumulator {
    model: String,
    parts: Vec<Value>,
    call_ids: Vec<String>,
    finish_reason: Option<String>,
    usage: serde_json::Map<String, Value>,
    done: bool,
}

impl GeminiSseAccumulator {
    pub(crate) fn new(model: &str) -> Self {
        Self {
            model: model.into(),
            parts: Vec::new(),
            call_ids: Vec::new(),
            finish_reason: None,
            usage: serde_json::Map::new(),
            done: false,
        }
    }

    fn ingest(&mut self, event: &Value) -> Result<Vec<(Value, Option<String>)>> {
        check_upstream_stream_failure(event)?;
        anyhow::ensure!(event.is_object(), "Gemini 响应必须是 JSON 对象");
        if let Some(model) = event
            .get("modelVersion")
            .and_then(Value::as_str)
            .filter(|model| !model.is_empty())
        {
            self.model = model.into();
        }
        if let Some(usage) = event.get("usageMetadata").and_then(Value::as_object) {
            self.usage.extend(usage.clone());
        }
        if event
            .pointer("/promptFeedback/blockReason")
            .and_then(Value::as_str)
            .is_some_and(|reason| !reason.is_empty() && reason != "BLOCK_REASON_UNSPECIFIED")
        {
            self.finish_reason = Some("SAFETY".into());
        }
        let Some(candidates) = event.get("candidates") else {
            anyhow::ensure!(
                event.get("usageMetadata").is_some() || event.get("promptFeedback").is_some(),
                "Gemini 响应缺少 candidates"
            );
            return Ok(Vec::new());
        };
        let candidates = candidates
            .as_array()
            .context("Gemini candidates 必须是数组")?;
        let mut first = candidates.iter().filter(|candidate| {
            candidate
                .get("index")
                .is_none_or(|index| index.as_u64() == Some(0))
        });
        let Some(candidate) = first.next() else {
            return Ok(Vec::new());
        };
        anyhow::ensure!(first.next().is_none(), "Gemini 返回了重复的候选索引");
        let parts = match candidate.pointer("/content/parts") {
            Some(parts) => parts
                .as_array()
                .context("Gemini content.parts 必须是数组")?
                .as_slice(),
            None => &[],
        };
        anyhow::ensure!(
            self.finish_reason.is_none() || parts.is_empty(),
            "Gemini 在终态后继续返回内容"
        );
        let mut additions = Vec::new();
        for part in parts {
            validate_gemini_part(part)?;
            let call_id = if let Some(call) = part.get("functionCall") {
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("call_codey_{}", Uuid::new_v4()));
                anyhow::ensure!(!self.call_ids.contains(&id), "Gemini 返回重复的工具调用 ID");
                self.call_ids.push(id.clone());
                Some(id)
            } else {
                None
            };
            self.parts.push(part.clone());
            additions.push((part.clone(), call_id));
        }
        if let Some(reason) = candidate
            .get("finishReason")
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty() && *reason != "FINISH_REASON_UNSPECIFIED")
        {
            if let Some(previous) = self.finish_reason.as_deref() {
                anyhow::ensure!(previous == reason, "Gemini 返回了冲突的终态");
            }
            self.finish_reason = Some(reason.into());
        }
        Ok(additions)
    }

    fn incomplete_reason(&self) -> Result<Option<&'static str>> {
        match self.finish_reason.as_deref() {
            Some("STOP") => {
                anyhow::ensure!(
                    self.parts
                        .iter()
                        .any(|part| part.get("functionCall").is_some()
                            || part["thought"] != true
                                && part
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .is_some_and(|text| !text.is_empty())),
                    "Gemini 完成响应没有可用内容"
                );
                Ok(None)
            }
            Some("MAX_TOKENS" | "CONTINUATION") => Ok(Some("max_output_tokens")),
            Some(
                "SAFETY"
                | "RECITATION"
                | "BLOCKLIST"
                | "PROHIBITED_CONTENT"
                | "SPII"
                | "IMAGE_SAFETY"
                | "IMAGE_PROHIBITED_CONTENT"
                | "IMAGE_RECITATION"
                | "ESCALATION"
                | "PUP_LIMITED_DISABLED",
            ) => Ok(Some("content_filter")),
            Some(reason) => anyhow::bail!("Gemini 生成未成功完成：{reason}"),
            None => anyhow::bail!("Gemini 响应在 finishReason 终态前断开"),
        }
    }

    fn history(&self, model: &str) -> Result<Option<String>> {
        self.parts
            .iter()
            .any(|part| {
                part.get("thoughtSignature")
                    .and_then(Value::as_str)
                    .is_some_and(|signature| !signature.is_empty())
            })
            .then(|| {
                GeminiHistory {
                    model: model.into(),
                    parts: self.parts.clone(),
                    call_ids: self.call_ids.clone(),
                }
                .encode()
            })
            .transpose()
    }

    fn usage(&self) -> Option<Value> {
        (!self.usage.is_empty())
            .then(|| gemini_usage_to_responses_usage(&Value::Object(self.usage.clone())))
    }

    pub(crate) fn into_responses(self, model: &str, bridge: &ResponsesToolBridge) -> Result<Value> {
        let incomplete = self.incomplete_reason()?;
        let history = self.history(model)?;
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut calls = Vec::new();
        let mut call_ids = self.call_ids.iter();
        for part in &self.parts {
            if let Some(value) = part.get("text").and_then(Value::as_str) {
                if part["thought"] == true {
                    reasoning.push_str(value);
                } else {
                    text.push_str(value);
                }
            }
            if let Some(call) = part.get("functionCall") {
                calls.push(json!({
                    "id":call_ids.next().context("Gemini 工具调用缺少 ID")?,
                    "type":"function",
                    "function":{"name":call["name"],"arguments":serde_json::to_string(call.get("args").unwrap_or(&json!({})))?},
                }));
            }
        }
        let mut message = json!({"role":"assistant","content":text,"tool_calls":calls});
        if !reasoning.is_empty() || history.is_some() {
            message["reasoning_content"] = json!(reasoning);
        }
        let mut response = chat_completion_to_responses_body_with_tool_bridge(
            json!({
                "id":format!("resp_codey_{}", Uuid::new_v4()),
                "choices":[{"message":message,"finish_reason":match incomplete {Some("max_output_tokens") => "length", Some(_) => "content_filter", None => "stop"}}],
            }),
            &self.model,
            bridge,
        )?;
        if let Some(history) = history {
            let item = &mut response["output"][0];
            *item = responses_reasoning_item_with_state(
                item["id"].as_str().unwrap_or_default(),
                &reasoning,
                "completed",
                &history,
            );
        }
        if let Some(usage) = self.usage() {
            response["usage"] = usage;
        }
        Ok(response)
    }
}

impl SseFrameAccumulator for GeminiSseAccumulator {
    const PROTOCOL_LABEL: &'static str = "Gemini";
    const READ_OPERATION: &'static str = "读取 Gemini SSE 流失败";

    fn ingest_frame(&mut self, data: &str, trailing: bool) -> Result<()> {
        if data.trim() == "[DONE]" {
            self.incomplete_reason()?;
            self.done = true;
            return Ok(());
        }
        self.ingest(&sse_json_frame(data, Self::PROTOCOL_LABEL, trailing)?)?;
        Ok(())
    }

    fn finished(&self) -> bool {
        self.done
    }
}

pub(crate) fn gemini_usage_to_responses_usage(usage: &Value) -> Value {
    let count = |key| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let input = count("promptTokenCount").saturating_add(count("toolUsePromptTokenCount"));
    let thoughts = count("thoughtsTokenCount");
    let output = count("candidatesTokenCount").saturating_add(thoughts);
    json!({
        "input_tokens":input,
        "input_tokens_details":{"cached_tokens":count("cachedContentTokenCount")},
        "output_tokens":output,
        "output_tokens_details":{"reasoning_tokens":thoughts},
        "total_tokens":usage.get("totalTokenCount").and_then(Value::as_u64).unwrap_or_else(|| input.saturating_add(output)),
    })
}

pub(crate) async fn read_gemini_as_responses(
    prepared: &mut PreparedUpstreamResponse,
    model: &str,
    bridge: &ResponsesToolBridge,
    probe: Option<&RouteRequestLogProbe>,
) -> Result<Value> {
    let mut accumulator = GeminiSseAccumulator::new(model);
    if prepared.is_sse {
        collect_sse_frames(prepared, &mut accumulator, probe).await?;
    } else {
        let body = read_bounded_prepared_upstream_body(
            prepared,
            MAX_UPSTREAM_RESPONSE_BYTES,
            "读取 Gemini 上游响应失败",
            probe,
        )
        .await?;
        let value: Value = serde_json::from_slice(&body).context("Gemini 上游响应不是有效 JSON")?;
        if let Some(chunks) = value.as_array() {
            for chunk in chunks {
                accumulator.ingest(chunk)?;
            }
        } else {
            accumulator.ingest(&value)?;
        }
    }
    observe_upstream_response_model(probe, &json!({"model":accumulator.model}));
    accumulator.into_responses(model, bridge)
}

pub(crate) async fn stream_gemini_as_responses<D: ResponsesDownstream + ?Sized>(
    downstream: &mut D,
    mut prepared: PreparedUpstreamResponse,
    model: &str,
    route: &RouteTarget,
    bridge: &ResponsesToolBridge,
) -> Result<()> {
    let mut output = ResponsesSseState::new(model, bridge);
    let retry_advice = prepared.retry_advice.clone();
    prepared.retained.get_or_insert_with(Default::default);
    output.start(downstream).await?;
    let events = output.reasoning_delta("");
    output.write_events(downstream, events).await?;
    let mut accumulator = GeminiSseAccumulator::new(model);
    let probe = downstream.request_log_probe().cloned();
    let result: Result<()> = async {
        let mut buffer = Vec::new();
        let mut cursor = SseCursor::default();
        while let Some(chunk) = await_upstream(
            downstream,
            read_prepared_upstream_chunk(&mut prepared, "读取 Gemini SSE 流失败", probe.as_ref()),
        )
        .await??
        {
            compact_sse_buffer(&mut buffer, &mut cursor);
            buffer.extend_from_slice(&chunk);
            ensure_sse_buffer_within_limit(&buffer, cursor.consumed)?;
            while let Some(frame) = take_next_sse_frame(&buffer, &mut cursor) {
                if let Some(data) = sse_frame_data(frame)? {
                    emit_gemini_frame(&mut accumulator, &mut output, downstream, &data, false)
                        .await?;
                    if accumulator.finished() {
                        break;
                    }
                }
            }
            if accumulator.finished() {
                break;
            }
        }
        if !accumulator.finished()
            && !buffer[cursor.consumed..]
                .iter()
                .all(u8::is_ascii_whitespace)
            && let Some(data) = sse_frame_data(&buffer[cursor.consumed..])?
        {
            emit_gemini_frame(&mut accumulator, &mut output, downstream, &data, true).await?;
        }
        let incomplete = accumulator.incomplete_reason()?;
        output.reasoning_encrypted_content = accumulator.history(model)?;
        output.model = accumulator.model.clone();
        observe_upstream_response_model(probe.as_ref(), &json!({"model":accumulator.model}));
        if output.message.is_none() && output.tools.is_empty() {
            let events = output.ensure_message();
            output.write_events(downstream, events).await?;
        }
        output
            .finish(downstream, accumulator.usage(), incomplete)
            .await
    }
    .await;
    if let Err(error) = result {
        if error.is::<DownstreamClosed>() {
            return Err(error);
        }
        observe_upstream_stream_error(probe.as_ref(), &error, route);
        let failure = streaming_response_failure(&error, route, retry_advice);
        let _ = output
            .fail_with_error(
                downstream,
                failure.normalized_event()["response"]["error"].clone(),
            )
            .await;
        return Err(error);
    }
    Ok(())
}

async fn emit_gemini_frame<D: ResponsesDownstream + ?Sized>(
    accumulator: &mut GeminiSseAccumulator,
    output: &mut ResponsesSseState<'_>,
    downstream: &mut D,
    data: &str,
    trailing: bool,
) -> Result<()> {
    if data.trim() == "[DONE]" {
        return accumulator.ingest_frame(data, trailing);
    }
    let first_call = accumulator.call_ids.len();
    let additions = accumulator.ingest(&sse_json_frame(data, "Gemini", trailing)?)?;
    let mut call_index = first_call;
    let mut events = Vec::new();
    for (part, call_id) in additions {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            events.extend(if part["thought"] == true {
                output.reasoning_delta(text)
            } else {
                output.text_delta(text)
            });
        }
        if let Some(call) = part.get("functionCall") {
            let arguments = serde_json::to_string(call.get("args").unwrap_or(&json!({})))?;
            events.extend(output.tool_delta(
                call_index,
                call_id.as_deref(),
                call["name"].as_str(),
                Some(&arguments),
                None,
            )?);
            call_index += 1;
        }
    }
    output.write_events(downstream, events).await
}
