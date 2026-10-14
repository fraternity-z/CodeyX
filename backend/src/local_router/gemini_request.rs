use base64::Engine as _;

use super::*;

pub(crate) const GEMINI_HISTORY_PREFIX: &str = "codey-gemini-v1:";

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeminiHistory {
    pub(crate) model: String,
    pub(crate) parts: Vec<Value>,
    pub(crate) call_ids: Vec<String>,
}

impl GeminiHistory {
    pub(crate) fn encode(&self) -> Result<String> {
        bounded_json_bytes(self, MAX_REQUEST_BYTES)?;
        let bytes = serde_json::to_vec(self).context("序列化 Gemini 思考状态失败")?;
        Ok(format!(
            "{GEMINI_HISTORY_PREFIX}{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    fn from_item(item: &Value) -> Result<Option<Self>> {
        let Some(encoded) = item
            .get("encrypted_content")
            .and_then(Value::as_str)
            .filter(|_| item["type"] == "reasoning")
            .and_then(|value| value.strip_prefix(GEMINI_HISTORY_PREFIX))
        else {
            return Ok(None);
        };
        anyhow::ensure!(
            encoded.len() <= MAX_REQUEST_BYTES,
            "Gemini 思考状态超过安全上限"
        );
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .context("Gemini 思考状态编码无效")?;
        let state: Self = serde_json::from_slice(&bytes).context("Gemini 思考状态格式无效")?;
        for part in &state.parts {
            validate_gemini_part(part)?;
        }
        anyhow::ensure!(
            state
                .parts
                .iter()
                .filter(|part| part.get("functionCall").is_some())
                .count()
                == state.call_ids.len(),
            "Gemini 思考状态中的工具配对无效"
        );
        Ok(Some(state))
    }
}

pub(crate) fn gemini_models_endpoint(base_url: &str) -> Result<String> {
    let mut url = normalized_endpoint_url(base_url)?;
    let mut path = url.path().trim_end_matches('/').to_string();
    if let Some((base, method)) = path.rsplit_once("/models/") {
        anyhow::ensure!(
            method.ends_with(":generateContent") || method.ends_with(":streamGenerateContent"),
            "Gemini API URL 必须是服务地址或 generateContent 端点"
        );
        path = base.to_string();
    } else if let Some(base) = path.strip_suffix("/models") {
        path = base.to_string();
    }
    for suffix in ["/chat/completions", "/responses", "/messages"] {
        if let Some(base) = strip_ascii_case_suffix(&path, suffix) {
            path = base.to_string();
            break;
        }
    }
    if !has_version_suffix(path.rsplit('/').next().unwrap_or_default()) {
        path.push_str("/v1beta");
    }
    path.push_str("/models");
    url.set_path(&path);
    Ok(url.to_string())
}

pub(crate) fn gemini_content_endpoint(base_url: &str, model: &str, stream: bool) -> Result<String> {
    let model = model.trim().strip_prefix("models/").unwrap_or(model.trim());
    anyhow::ensure!(
        !model.is_empty() && !matches!(model, "." | "..") && !model.contains(['/', '?', '#']),
        "Gemini 模型名称无效"
    );
    let mut url = reqwest::Url::parse(&gemini_models_endpoint(base_url)?)?;
    let method = if stream {
        "streamGenerateContent"
    } else {
        "generateContent"
    };
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Gemini API URL 不能包含模型路径"))?
        .push(&format!("{model}:{method}"));
    if stream {
        url.query_pairs_mut().append_pair("alt", "sse");
    }
    Ok(url.to_string())
}

pub(crate) fn responses_to_gemini_request(body: &Value) -> Result<ConvertedResponsesRequest> {
    let ConvertedResponsesRequest {
        body: chat,
        mut tool_bridge,
        ..
    } = responses_to_chat_completions_request(body)?;
    let chat = chat
        .as_object()
        .context("Responses 请求无法归一化为消息对象")?;
    for field in [
        "logit_bias",
        "logprobs",
        "top_logprobs",
        "web_search_options",
    ] {
        anyhow::ensure!(
            !chat.contains_key(field),
            "Gemini 暂不支持 Responses 字段 {field}"
        );
    }
    let model = chat["model"].as_str().context("缺少 model 字段")?;
    let (system, contents) = gemini_contents(body, model, &mut tool_bridge)?;
    let mut gemini = json!({"contents":contents});
    if !system.is_empty() {
        gemini["systemInstruction"] = json!({"parts":system});
    }
    let mut generation = serde_json::Map::new();
    for (source, target) in [
        ("temperature", "temperature"),
        ("top_p", "topP"),
        ("presence_penalty", "presencePenalty"),
        ("frequency_penalty", "frequencyPenalty"),
        ("seed", "seed"),
        ("max_tokens", "maxOutputTokens"),
    ] {
        if let Some(value) = chat.get(source) {
            anyhow::ensure!(value.is_number(), "Gemini 字段 {source} 必须是数字");
            if source == "max_tokens" {
                anyhow::ensure!(
                    value.as_u64().is_some_and(|value| value > 0),
                    "max_output_tokens 必须为正整数"
                );
            }
            generation.insert(target.into(), value.clone());
        }
    }
    if let Some(top_k) = body.get("top_k") {
        anyhow::ensure!(top_k.is_number(), "top_k 必须是数字");
        generation.insert("topK".into(), top_k.clone());
    }
    if let Some(stop) = chat.get("stop") {
        generation.insert("stopSequences".into(), anthropic_stop_sequences(stop)?);
    }
    if let Some(format) = chat.get("response_format") {
        match format["type"].as_str() {
            Some("text") => {}
            Some("json_object") => {
                generation.insert("responseMimeType".into(), json!("application/json"));
            }
            Some("json_schema") => {
                let schema = format
                    .pointer("/json_schema/schema")
                    .context("结构化输出缺少 schema")?;
                generation.insert("responseMimeType".into(), json!("application/json"));
                generation.insert("responseJsonSchema".into(), schema.clone());
            }
            _ => anyhow::bail!("Gemini 不支持当前结构化输出格式"),
        }
    }
    if let Some(thinking) =
        gemini_thinking_config(model, chat.get("reasoning_effort").and_then(Value::as_str))?
    {
        generation.insert("thinkingConfig".into(), thinking);
    }
    if !generation.is_empty() {
        gemini["generationConfig"] = Value::Object(generation);
    }
    if let Some(tools) = chat
        .get("tools")
        .and_then(Value::as_array)
        .filter(|tools| !tools.is_empty())
    {
        let declarations = tools.iter().map(|tool| {
            let function = tool.get("function").and_then(Value::as_object).context("Gemini 只支持 function 工具")?;
            let name = function.get("name").and_then(Value::as_str).context("工具缺少 name")?;
            let mut schema = function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object","properties":{}}));
            normalize_tool_parameter_root(&mut schema);
            Ok(json!({
                "name":name,
                "description":function.get("description").and_then(Value::as_str).unwrap_or_default(),
                "parametersJsonSchema":schema,
            }))
        }).collect::<Result<Vec<_>>>()?;
        let choice = chat
            .get("tool_choice")
            .or_else(|| chat.get("function_call"));
        let mut calling = match choice {
            None => json!({"mode":"AUTO"}),
            Some(Value::String(mode)) => match mode.as_str() {
                "auto" => json!({"mode":"AUTO"}),
                "none" => json!({"mode":"NONE"}),
                "required" => json!({"mode":"ANY"}),
                _ => anyhow::bail!("Gemini 不支持 tool_choice={mode}"),
            },
            Some(choice) => {
                let name = choice
                    .pointer("/function/name")
                    .or_else(|| choice.get("name"))
                    .and_then(Value::as_str)
                    .context("Gemini tool_choice 缺少函数名称")?;
                anyhow::ensure!(
                    declarations.iter().any(|tool| tool["name"] == name),
                    "tool_choice 指定了未声明的工具"
                );
                json!({"mode":"ANY","allowedFunctionNames":[name]})
            }
        };
        anyhow::ensure!(
            chat.get("parallel_tool_calls").and_then(Value::as_bool) != Some(false)
                || calling["mode"] == "NONE",
            "Gemini 暂不支持禁用并行工具调用"
        );
        gemini["tools"] = json!([{"functionDeclarations":declarations}]);
        gemini["toolConfig"] = json!({"functionCallingConfig":calling.take()});
    } else if let Some(choice) = chat
        .get("tool_choice")
        .or_else(|| chat.get("function_call"))
    {
        anyhow::ensure!(
            matches!(choice.as_str(), Some("auto" | "none")),
            "Gemini 强制工具调用需要先声明工具"
        );
    }
    Ok(ConvertedResponsesRequest {
        body: gemini,
        tool_bridge,
        chat_reasoning_summaries: Vec::new(),
    })
}

fn gemini_thinking_config(model: &str, effort: Option<&str>) -> Result<Option<Value>> {
    let model = model.to_ascii_lowercase();
    let supported =
        model.contains("gemini-2.5") || model.contains("gemini-3") || model.contains("gemini-4");
    if !supported && effort.is_none() {
        return Ok(None);
    }
    let mut thinking = json!({"includeThoughts":true});
    let Some(effort) = effort.filter(|effort| !effort.is_empty() && *effort != "auto") else {
        return Ok(Some(thinking));
    };
    if model.contains("gemini-2.5") {
        let budget = match effort {
            "none" | "minimal" if model.contains("pro") => 128,
            "none" | "minimal" => 0,
            "low" => 1024,
            "medium" => 4096,
            "high" => 8192,
            "xhigh" => 16384,
            _ => anyhow::bail!("Gemini 不支持思考强度 {effort}"),
        };
        thinking["thinkingBudget"] = json!(budget);
    } else {
        let level = match effort {
            "none" | "minimal" | "low" => "LOW",
            "medium" if model.contains("gemini-3-pro") => "HIGH",
            "medium" => "MEDIUM",
            "high" | "xhigh" => "HIGH",
            _ => anyhow::bail!("Gemini 不支持思考强度 {effort}"),
        };
        thinking["thinkingLevel"] = json!(level);
    }
    Ok(Some(thinking))
}

fn gemini_contents(
    body: &Value,
    model: &str,
    bridge: &mut ResponsesToolBridge,
) -> Result<(Vec<Value>, Vec<Value>)> {
    let (input, _) = responses_input_without_additional_tools(body.get("input"))?;
    let items = match input.as_ref() {
        Some(Value::Array(items)) => items.as_slice(),
        Some(item) => std::slice::from_ref(item),
        None => &[],
    };
    let mut builder = GeminiContents::default();
    if let Some(instructions) = body
        .get("instructions")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        builder.system.push(json!({"text":instructions}));
    }
    let mut index = 0;
    while index < items.len() {
        if let Some(state) = GeminiHistory::from_item(&items[index])?
            && model_id::equal(
                state.model.trim_start_matches("models/"),
                model.trim_start_matches("models/"),
            )
        {
            let mut end = index + 1;
            let mut messages = Vec::new();
            while let Some(item) = items.get(end).filter(|item| gemini_assistant_item(item)) {
                append_chat_message_item(item, &mut messages, bridge)?;
                end += 1;
            }
            let mut actual = Vec::new();
            for message in &messages {
                actual.extend(gemini_assistant_parts(message)?);
            }
            let mut expected = state.parts.clone();
            let mut call_ids = state.call_ids.iter();
            for part in &mut expected {
                if let Some(call) = part.get_mut("functionCall") {
                    call["id"] = json!(call_ids.next().context("Gemini 思考状态缺少调用 ID")?);
                }
            }
            anyhow::ensure!(
                gemini_visible_parts(&actual) == gemini_visible_parts(&expected),
                "Gemini 签名对应的消息或工具调用已改变，无法安全恢复思考状态"
            );
            builder.model_parts(state.parts, state.call_ids, true)?;
            index = end;
            continue;
        }
        let mut messages = Vec::new();
        append_chat_message_item(&items[index], &mut messages, bridge)?;
        let mut messages = messages.into_iter().peekable();
        while let Some(message) = messages.next() {
            if message["role"] == "tool" {
                let images = if messages.peek().is_some_and(is_tool_image_message) {
                    messages
                        .next()
                        .and_then(|message| message.get("content").cloned())
                } else {
                    None
                };
                builder.tool_result(&message, images.as_ref())?;
            } else {
                builder.message(&message)?;
            }
        }
        index += 1;
    }
    anyhow::ensure!(
        builder.pending.is_empty(),
        "Gemini 历史中的工具调用缺少对应结果"
    );
    anyhow::ensure!(
        !builder.contents.is_empty(),
        "缺少可转换为 Gemini contents 的 input"
    );
    Ok((builder.system, builder.contents))
}

fn gemini_assistant_item(item: &Value) -> bool {
    matches!(
        item["type"].as_str(),
        Some("function_call" | "custom_tool_call" | "tool_search_call")
    ) || item["role"] == "assistant" && matches!(item["type"].as_str(), None | Some("message"))
}

fn gemini_visible_parts(parts: &[Value]) -> (String, Vec<Value>) {
    let mut text = String::new();
    let mut calls = Vec::new();
    for part in parts {
        if part["thought"] != true {
            if let Some(value) = part.get("text").and_then(Value::as_str) {
                text.push_str(value);
            }
            if let Some(call) = part.get("functionCall") {
                calls.push(json!({"id":call.get("id"),"name":call.get("name"),"args":call.get("args").cloned().unwrap_or_else(|| json!({}))}));
            }
        }
    }
    (text, calls)
}

fn gemini_assistant_parts(message: &Value) -> Result<Vec<Value>> {
    anyhow::ensure!(
        message["role"] == "assistant",
        "Gemini 思考状态未对应助手消息"
    );
    let mut parts = gemini_content_parts(message.get("content"))?;
    anyhow::ensure!(
        message.get("function_call").is_none(),
        "Gemini 不支持没有调用 ID 的历史 function_call"
    );
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let id = call["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .context("工具调用缺少 ID")?;
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .context("工具调用缺少 name")?;
            let args = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let args: Value = serde_json::from_str(args).context("Gemini 工具参数不是有效 JSON")?;
            anyhow::ensure!(args.is_object(), "Gemini 工具参数必须是 JSON 对象");
            parts.push(json!({"functionCall":{"id":id,"name":name,"args":args}}));
        }
    }
    Ok(parts)
}

struct GeminiPendingCall {
    local_id: String,
    name: String,
    upstream_id: Option<String>,
    response: Option<Value>,
}

#[derive(Default)]
struct GeminiContents {
    system: Vec<Value>,
    contents: Vec<Value>,
    pending: Vec<GeminiPendingCall>,
}

impl GeminiContents {
    fn push(&mut self, role: &str, parts: Vec<Value>) {
        if parts.is_empty() {
            return;
        }
        if let Some(last) = self.contents.last_mut().filter(|last| last["role"] == role) {
            last["parts"]
                .as_array_mut()
                .expect("Gemini parts array")
                .extend(parts);
        } else {
            self.contents.push(json!({"role":role,"parts":parts}));
        }
    }

    fn message(&mut self, message: &Value) -> Result<()> {
        match message["role"].as_str() {
            Some("system") => self
                .system
                .extend(gemini_content_parts(message.get("content"))?),
            Some("user") => {
                anyhow::ensure!(
                    self.pending.is_empty(),
                    "Gemini 工具调用结果不完整，不能插入用户消息"
                );
                self.push("user", gemini_content_parts(message.get("content"))?);
            }
            Some("assistant") => {
                let parts = gemini_assistant_parts(message)?;
                let ids = parts
                    .iter()
                    .filter_map(|part| {
                        part.pointer("/functionCall/id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect();
                self.model_parts(parts, ids, false)?;
            }
            _ => anyhow::bail!("Gemini 不支持当前消息角色"),
        }
        Ok(())
    }

    fn model_parts(&mut self, mut parts: Vec<Value>, ids: Vec<String>, signed: bool) -> Result<()> {
        anyhow::ensure!(
            self.pending.iter().all(|call| call.response.is_none()),
            "Gemini 并行工具结果尚未全部返回"
        );
        let mut ids = ids.into_iter();
        for part in &mut parts {
            if let Some(call) = part.get("functionCall") {
                let local_id = ids.next().context("Gemini 工具调用缺少本地 ID")?;
                anyhow::ensure!(
                    !local_id.is_empty()
                        && !self.pending.iter().any(|call| call.local_id == local_id),
                    "Gemini 工具调用 ID 重复或为空"
                );
                self.pending.push(GeminiPendingCall {
                    local_id,
                    name: call["name"]
                        .as_str()
                        .context("Gemini 工具调用缺少 name")?
                        .into(),
                    upstream_id: call.get("id").and_then(Value::as_str).map(str::to_string),
                    response: None,
                });
                if !signed {
                    part["thoughtSignature"] = json!("skip_thought_signature_validator");
                }
            }
        }
        self.push("model", parts);
        Ok(())
    }

    fn tool_result(&mut self, message: &Value, images: Option<&Value>) -> Result<()> {
        let id = message["tool_call_id"]
            .as_str()
            .context("tool 消息缺少 tool_call_id")?;
        let pending = self
            .pending
            .iter_mut()
            .find(|call| call.local_id == id)
            .context("Gemini 工具结果没有对应的调用")?;
        anyhow::ensure!(pending.response.is_none(), "Gemini 工具结果重复");
        let content = message["content"].as_str().unwrap_or_default();
        let value = serde_json::from_str::<Value>(content).unwrap_or_else(|_| json!(content));
        let response = if value.is_object() {
            value
        } else {
            json!({"output":value})
        };
        let mut result = json!({"name":pending.name,"response":response});
        if let Some(id) = &pending.upstream_id {
            result["id"] = json!(id);
        }
        if let Some(images) = images {
            result["parts"] = json!(gemini_content_parts(Some(images))?);
        }
        pending.response = Some(json!({"functionResponse":result}));
        if self.pending.iter().all(|call| call.response.is_some()) {
            let parts = std::mem::take(&mut self.pending)
                .into_iter()
                .filter_map(|call| call.response)
                .collect();
            self.push("user", parts);
        }
        Ok(())
    }
}

fn gemini_content_parts(content: Option<&Value>) -> Result<Vec<Value>> {
    match content {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(text)) => Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![json!({"text":text})]
        }),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|part| match part["type"].as_str() {
                Some("text") => {
                    Ok(json!({"text":part["text"].as_str().context("文本内容缺少 text")?}))
                }
                Some("image_url") => gemini_image_part(&part["image_url"]),
                _ => anyhow::bail!("Gemini 不支持当前消息内容类型"),
            })
            .collect(),
        _ => anyhow::bail!("Gemini 消息内容必须是字符串或数组"),
    }
}

fn gemini_image_part(image: &Value) -> Result<Value> {
    let uri = image
        .as_str()
        .or_else(|| image.get("url").and_then(Value::as_str))
        .context("图片缺少 URL")?;
    if let Some(data) = uri.strip_prefix("data:") {
        let (mime, data) = data
            .split_once(";base64,")
            .context("Gemini 图片 data URL 必须使用 base64")?;
        anyhow::ensure!(
            matches!(
                mime,
                "image/png"
                    | "image/jpeg"
                    | "image/jpg"
                    | "image/webp"
                    | "image/heic"
                    | "image/heif"
                    | "image/gif"
                    | "image/avif"
            ),
            "Gemini 不支持图片类型 {mime}"
        );
        anyhow::ensure!(!data.is_empty(), "Gemini 图片 data URL 缺少数据");
        return Ok(json!({"inlineData":{"mimeType":mime,"data":data}}));
    }
    let url = reqwest::Url::parse(uri).context("Gemini 图片 URL 无效")?;
    anyhow::ensure!(
        matches!(url.scheme(), "https" | "http") && url.host_str().is_some(),
        "Gemini 图片 URL 必须是 HTTP(S) 或 base64 data URL"
    );
    Ok(json!({"fileData":{"fileUri":uri}}))
}
