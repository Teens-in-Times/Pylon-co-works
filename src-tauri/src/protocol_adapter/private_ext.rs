//! Closed provider-specific parser/builder boundary.
use agent_client_protocol_schema::v1::{CreateElicitationRequest, ElicitationScope};
use pylon_acp::{plan_policy, question_policy};
use serde_json::Value;

use crate::error::PylonError;
use crate::permission::InteractionAnswerInput;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivateBridge {
    GrokExtQuestions,
    PiSelectAsk,
    GrokExitPlan,
    /// #98：`elicitation/create` 通用协议桥——按方法名路由，不绑定任何
    /// provider。请求保持 raw（message/requestedSchema 原样观测），应答按
    /// ESM 风格 action 三值（accept/decline/cancel），不伪造 option 或成功。
    Elicitation,
}

impl PrivateBridge {
    /// 交互队列 canonical kind（#230：dispatcher admit 与 CLI
    /// interaction_list 投影共用此单一映射，防漂移）。
    pub fn queue_kind(self) -> &'static str {
        match self {
            Self::GrokExitPlan => "approval",
            Self::Elicitation => "elicitation",
            Self::GrokExtQuestions | Self::PiSelectAsk => "ask-user",
        }
    }
}

/// Validate Codeg-compatible private interaction request shapes before the
/// generic dispatcher rejects an unsupported bridge. This is deliberately a
/// fail-closed parser seam: it never fabricates an answer or RPC response.
pub fn validate_request(method: &str, params: &Value) -> Result<(), String> {
    match method {
        "_x.ai/ask_user_question" => {
            parse_questions(PrivateBridge::GrokExtQuestions, params).map(|_| ())
        }
        "pi/select_ask" => parse_questions(PrivateBridge::PiSelectAsk, params).map(|_| ()),
        "_x.ai/exit_plan_mode" => parse_exit_plan(PrivateBridge::GrokExitPlan, params).map(|_| ()),
        "elicitation/create" => parse_elicitation(params).map(|_| ()),
        _ => Ok(()),
    }
}

/// `elicitation/create` 参数校验：message 必须是 string（可缺省）、
/// requestedSchema 缺省或 object、`mode` 显式给出时只能是 `"form"`。
/// #349 B2：Pylon 仅广告 form 模式（initialize_plan 只注入
/// `elicitation:{form:{}}`），官方语义「未广告的 mode 视为不支持，agent
/// 不得发起」——url 等其它 mode 在此 fail-closed（调用方按 -32602 拒绝），
/// 不再静默放行；缺省 `mode` 视为旧式隐式 form，保持兼容。
pub fn parse_elicitation(params: &Value) -> Result<(), String> {
    if !params.is_object() {
        return Err("elicitation/create params must be an object".into());
    }
    if let Some(mode) = params.get("mode").and_then(Value::as_str) {
        if mode != "form" {
            return Err(format!(
                "elicitation/create mode `{mode}` is not advertised (only form is supported)"
            ));
        }
    }
    if let Some(message) = params.get("message") {
        if !message.is_string() {
            return Err("elicitation/create message must be a string".into());
        }
    }
    if let Some(schema) = params.get("requestedSchema") {
        if !schema.is_object() {
            return Err("elicitation/create requestedSchema must be an object".into());
        }
    }
    Ok(())
}

/// #356：request-scoped elicitation 的 scope 投影结论。`Session` 携带投影出的
/// 非空 sessionId（与既有会话内路径同构）；`Request` 是会话外（auth/config
/// 阶段）elicitation——wire 上没有 sessionId，宿主以空串入队、身份由
/// requestId+agentId 收口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElicitationScopeProjection {
    Session { session_id: String },
    Request,
}

/// #356：空 `sessionId` 的 elicitation/create 走官方 typed
/// `CreateElicitationRequest` 解析并按 scope 投影。解析失败（mode/message/
/// requestedSchema/scope 任一不符合官方形状）回 Err，调用方按参数类错误
/// （-32602）拒绝；`Session` scope 的 id 为显式空串时同样 Err——空串在前后端
/// 三道门均当缺失，入队只会让 agent 挂等一个永不来的响应。未广告的
/// `mode:"url"` 在 [`parse_elicitation`] 已 fail-closed，不会到达本函数。
pub fn project_elicitation_scope(params: &Value) -> Result<ElicitationScopeProjection, String> {
    let request: CreateElicitationRequest =
        serde_json::from_value(params.clone()).map_err(|error| {
            format!("elicitation/create params do not match the official shape: {error}")
        })?;
    match request.scope() {
        ElicitationScope::Session(session) => {
            let session_id = session.session_id.0.to_string();
            if session_id.is_empty() {
                return Err("elicitation/create session scope carries an empty sessionId".into());
            }
            Ok(ElicitationScopeProjection::Session { session_id })
        }
        ElicitationScope::Request(_) => Ok(ElicitationScopeProjection::Request),
        // #[non_exhaustive]：schema 未来可能新增 scope 变体——fail-closed 拒绝
        // （issue 措辞「未知变体 fail-closed 拒绝」）。
        _ => Err("elicitation/create scope variant is not supported by this host".into()),
    }
}

/// elicitation 应答形状：action ∈ accept/decline/cancel；accept 携带 content
/// （用户 freeform/表单值，原样透传，宿主不解释 schema 语义）。
pub fn build_elicitation_response(action: &str, content: Option<&Value>) -> Result<Value, String> {
    match action {
        "accept" => Ok(serde_json::json!({
            "action": "accept",
            "content": content.cloned().unwrap_or(serde_json::json!({})),
        })),
        "decline" => Ok(serde_json::json!({"action": "decline"})),
        "cancel" => Ok(serde_json::json!({"action": "cancel"})),
        other => Err(format!("elicitation action unsupported: {other}")),
    }
}

/// #569：私有桥应答构造单点（原 inline 于 permission.rs `respond_interaction`
/// 的 match 三臂，行为逐字保留）。kind 不参与构造——路由权威是账本按
/// request_id 的登记（#436 裁决：kind 定位为诊断元数据，后端不复核）。入口是
/// admit 已校验的登记形状：bridge + 原始 params + 已解析 question specs；
/// 构造失败一律 Err，不伪造成功应答。
pub(crate) fn build_interaction_response(
    bridge: PrivateBridge,
    params: &Value,
    question_specs: Option<&[question_policy::QuestionSpec]>,
    answer: &InteractionAnswerInput,
) -> Result<Value, PylonError> {
    match bridge {
        PrivateBridge::GrokExtQuestions | PrivateBridge::PiSelectAsk => {
            let questions = question_specs.ok_or_else(|| {
                PylonError::Protocol("private question request lost validated specs".into())
            })?;
            let values = answer.values.clone().unwrap_or_default();
            let answers = questions
                .iter()
                .filter_map(|spec| {
                    values.get(&spec.id).map(|value| {
                        let labels = match value {
                            Value::String(label) => vec![label.clone()],
                            Value::Array(items) => items
                                .iter()
                                .filter_map(|item| item.as_str().map(str::to_owned))
                                .collect(),
                            _ => Vec::new(),
                        };
                        question_policy::QuestionAnswerItem {
                            question_id: spec.id.clone(),
                            labels,
                        }
                    })
                })
                .collect();
            let question_answer = question_policy::QuestionAnswer {
                answers,
                declined: answer.option_id.as_deref() == Some("declined"),
            };
            build_question_response(bridge, questions, &question_answer)
                .map_err(PylonError::Protocol)
        }
        PrivateBridge::GrokExitPlan => {
            let _ = parse_exit_plan(bridge, params).map_err(PylonError::Protocol)?;
            Ok(plan_policy::approval_response(
                answer.option_id.as_deref().unwrap_or("keep_planning"),
                answer.text.as_deref().unwrap_or(""),
            ))
        }
        PrivateBridge::Elicitation => {
            // #98：elicitation 应答 = ESM 风格 action 三值。decline/cancel
            // 由前端 optionId 表达；accept 携带 values/text 原样 content。
            // P2-3（评审修复）：optionId 白名单 fail-closed——未知值显式
            // 报错而非静默 accept（不伪造成功）。缺省 optionId + values/text
            // = 自由作答（accept）。
            let action = match answer.option_id.as_deref() {
                None | Some("accept") => "accept",
                Some("declined") => "decline",
                Some("cancel") => "cancel",
                Some(other) => {
                    return Err(PylonError::Protocol(format!(
                        "elicitation action unsupported: {other}"
                    )))
                }
            };
            let content = match (&answer.values, &answer.text) {
                (Some(values), _) if values.is_object() => Some(values.clone()),
                (None, Some(text)) if !text.is_empty() => Some(serde_json::json!({ "text": text })),
                _ => None,
            };
            build_elicitation_response(action, content.as_ref()).map_err(PylonError::Protocol)
        }
    }
}

pub fn parse_questions(
    bridge: PrivateBridge,
    params: &Value,
) -> Result<Vec<question_policy::QuestionSpec>, String> {
    match bridge {
        PrivateBridge::GrokExtQuestions | PrivateBridge::PiSelectAsk => {
            let specs = question_policy::parse_questions(params)?;
            question_policy::validate_specs(&specs)?;
            Ok(specs)
        }
        PrivateBridge::GrokExitPlan | PrivateBridge::Elicitation => {
            Err("plan/elicitation bridge does not accept questions".into())
        }
    }
}
/// Serialize the provider-specific response shape documented by Codeg. Grok
/// correlates answers by question text; pi expects an option id (or cancelled).
pub fn build_question_response(
    bridge: PrivateBridge,
    questions: &[question_policy::QuestionSpec],
    answer: &question_policy::QuestionAnswer,
) -> Result<Value, String> {
    let outcome = question_policy::build_outcome(questions, answer);
    match bridge {
        PrivateBridge::GrokExtQuestions => {
            if outcome.declined {
                return Ok(serde_json::json!({"outcome":"skip_interview"}));
            }
            let mut answers = serde_json::Map::new();
            for item in outcome.answers {
                let value = if item.multi_select {
                    Value::Array(item.selected.into_iter().map(Value::String).collect())
                } else if let Some(label) = item.selected.into_iter().next() {
                    Value::String(label)
                } else {
                    continue;
                };
                answers.insert(item.question, value);
            }
            Ok(serde_json::json!({"outcome":"accepted","answers":answers,"partial_answers":{}}))
        }
        PrivateBridge::PiSelectAsk => {
            let option = outcome
                .answers
                .first()
                .and_then(|item| item.selected.first())
                .cloned();
            Ok(match option {
                Some(option_id) => serde_json::json!({"optionId": option_id}),
                None => serde_json::json!({"cancelled":true}),
            })
        }
        PrivateBridge::GrokExitPlan | PrivateBridge::Elicitation => {
            Err("plan/elicitation bridge does not accept question answers".into())
        }
    }
}
pub fn parse_exit_plan(bridge: PrivateBridge, params: &Value) -> Result<(String, String), String> {
    match bridge {
        PrivateBridge::GrokExitPlan => plan_policy::parse_exit_plan_request(params),
        _ => Err("question bridge does not accept plans".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_question_bridge_reuses_shared_policy() {
        let questions = parse_questions(PrivateBridge::GrokExtQuestions, &serde_json::json!({"questions":[{"question":"Pick","header":"Choice","options":[{"label":"A"},{"label":"B"}]}]})).unwrap();
        let answer = question_policy::QuestionAnswer {
            answers: vec![question_policy::QuestionAnswerItem {
                question_id: questions[0].id.clone(),
                labels: vec!["A".into()],
            }],
            declined: false,
        };
        let outcome =
            build_question_response(PrivateBridge::GrokExtQuestions, &questions, &answer).unwrap();
        assert_eq!(outcome["answers"]["Pick"], "A");
    }
    #[test]
    fn private_plan_bridge_reuses_shared_policy() {
        assert_eq!(
            parse_exit_plan(
                PrivateBridge::GrokExitPlan,
                &serde_json::json!({"toolCallId":"t"})
            )
            .unwrap()
            .1,
            "t"
        );
    }

    /// #569：应答构造单点（原 permission.rs inline 行为逐字钉住）——
    /// ask-user 桥按 spec.id 提取 label(s)。
    #[test]
    fn build_interaction_response_routes_question_answers() {
        let questions = parse_questions(
            PrivateBridge::GrokExtQuestions,
            &serde_json::json!({"questions":[{"question":"Pick","header":"Choice","options":[{"label":"A"},{"label":"B"}]}]}),
        )
        .unwrap();
        let response = build_interaction_response(
            PrivateBridge::GrokExtQuestions,
            &serde_json::json!({}),
            Some(&questions),
            &InteractionAnswerInput {
                option_id: None,
                text: None,
                values: Some(serde_json::json!({ (questions[0].id.clone()): "A" })),
            },
        )
        .unwrap();
        assert_eq!(response["outcome"], "accepted");
        assert_eq!(response["answers"]["Pick"], "A");
    }

    /// #569：declined 走 skip_interview；登记丢失 specs 时 fail-closed 报错。
    #[test]
    fn build_interaction_response_question_declined_and_lost_specs() {
        let declined = build_interaction_response(
            PrivateBridge::GrokExtQuestions,
            &serde_json::json!({}),
            Some(&[]),
            &InteractionAnswerInput {
                option_id: Some("declined".into()),
                text: None,
                values: None,
            },
        )
        .unwrap();
        assert_eq!(declined, serde_json::json!({"outcome":"skip_interview"}));
        let lost = build_interaction_response(
            PrivateBridge::GrokExtQuestions,
            &serde_json::json!({}),
            None,
            &InteractionAnswerInput {
                option_id: None,
                text: None,
                values: None,
            },
        )
        .unwrap_err();
        assert!(lost.to_string().contains("lost validated specs"));
    }

    /// #569：exit-plan 桥——缺省 keep_planning，optionId 覆盖 outcome，text 进 feedback。
    #[test]
    fn build_interaction_response_exit_plan_defaults_and_overrides() {
        let params = serde_json::json!({"toolCallId":"t"});
        let keep = build_interaction_response(
            PrivateBridge::GrokExitPlan,
            &params,
            None,
            &InteractionAnswerInput {
                option_id: None,
                text: Some("need more time".into()),
                values: None,
            },
        )
        .unwrap();
        assert_eq!(
            keep,
            serde_json::json!({"outcome":"keep_planning","feedback":"need more time"})
        );
        let approved = build_interaction_response(
            PrivateBridge::GrokExitPlan,
            &params,
            None,
            &InteractionAnswerInput {
                option_id: Some("approved".into()),
                text: None,
                values: None,
            },
        )
        .unwrap();
        assert_eq!(approved["outcome"], "approved");
    }

    /// #569：elicitation 桥——自由作答 accept（values 表单 / text 自由文本）、
    /// declined、optionId 白名单 fail-closed。
    #[test]
    fn build_interaction_response_elicitation_actions_and_whitelist() {
        let form = build_interaction_response(
            PrivateBridge::Elicitation,
            &serde_json::json!({}),
            None,
            &InteractionAnswerInput {
                option_id: None,
                text: None,
                values: Some(serde_json::json!({"answer": "detail"})),
            },
        )
        .unwrap();
        assert_eq!(
            form,
            serde_json::json!({"action": "accept", "content": {"answer": "detail"}})
        );
        let freeform = build_interaction_response(
            PrivateBridge::Elicitation,
            &serde_json::json!({}),
            None,
            &InteractionAnswerInput {
                option_id: None,
                text: Some("hello".into()),
                values: None,
            },
        )
        .unwrap();
        assert_eq!(
            freeform,
            serde_json::json!({"action": "accept", "content": {"text": "hello"}})
        );
        let decline = build_interaction_response(
            PrivateBridge::Elicitation,
            &serde_json::json!({}),
            None,
            &InteractionAnswerInput {
                option_id: Some("declined".into()),
                text: None,
                values: None,
            },
        )
        .unwrap();
        assert_eq!(decline, serde_json::json!({"action": "decline"}));
        let unknown = build_interaction_response(
            PrivateBridge::Elicitation,
            &serde_json::json!({}),
            None,
            &InteractionAnswerInput {
                option_id: Some("invent".into()),
                text: None,
                values: None,
            },
        )
        .unwrap_err();
        assert!(unknown
            .to_string()
            .contains("elicitation action unsupported: invent"));
    }

    #[test]
    fn validates_only_known_private_wire_methods() {
        assert!(validate_request(
            "_x.ai/ask_user_question",
            &serde_json::json!({"questions":[{"question":"Pick","header":"Choice","options":[{"label":"A"},{"label":"B"}]}]})
        ).is_ok());
        assert!(validate_request(
            "_x.ai/exit_plan_mode",
            &serde_json::json!({"toolCallId":"t"})
        )
        .is_ok());
        assert!(validate_request("unknown/private", &serde_json::json!(null)).is_ok());
        assert!(validate_request(
            "_x.ai/ask_user_question",
            &serde_json::json!({"questions":[]})
        )
        .is_err());
    }

    /// #98：elicitation/create 走通用桥——不绑定 provider；合法/非法形状与
    /// action 三值应答。
    #[test]
    fn elicitation_bridge_is_provider_free_and_fail_closed() {
        assert!(validate_request(
            "elicitation/create",
            &serde_json::json!({"message": "Provide details", "requestedSchema": {"type": "object"}})
        )
        .is_ok());
        assert!(
            validate_request("elicitation/create", &serde_json::json!({"message": "m"})).is_ok()
        );
        assert!(
            validate_request("elicitation/create", &serde_json::json!({"message": 42})).is_err()
        );
        assert!(validate_request(
            "elicitation/create",
            &serde_json::json!({"requestedSchema": "not-an-object"})
        )
        .is_err());
        assert!(validate_request("elicitation/create", &serde_json::json!([])).is_err());

        assert_eq!(
            build_elicitation_response("accept", Some(&serde_json::json!({"answer": "detail"})))
                .unwrap(),
            serde_json::json!({"action": "accept", "content": {"answer": "detail"}})
        );
        assert_eq!(
            build_elicitation_response("cancel", None).unwrap(),
            serde_json::json!({"action": "cancel"})
        );
        assert!(build_elicitation_response("invent", None).is_err());
    }

    /// #349 B2：未广告的 mode fail-closed（url 显式拒绝；缺省 mode 视为旧式
    /// 隐式 form 保持兼容）。
    #[test]
    fn elicitation_mode_gate_rejects_unadvertised_modes() {
        assert!(parse_elicitation(&serde_json::json!({
            "mode": "form", "message": "m", "requestedSchema": {"type": "object"}
        }))
        .is_ok());
        // 缺省 mode = 旧式隐式 form，兼容放行。
        assert!(parse_elicitation(&serde_json::json!({"message": "m"})).is_ok());
        // url / 自定义 mode 未广告，显式拒绝。
        assert!(parse_elicitation(&serde_json::json!({
            "mode": "url", "elicitationId": "e", "url": "https://x"
        }))
        .is_err());
        assert!(parse_elicitation(&serde_json::json!({"mode": "_vendor.custom"})).is_err());
    }

    /// #356：typed scope 投影——Request scope（无 sessionId、带 requestId）
    /// 放行为 request-scoped；Session scope 取回非空 sessionId；显式空
    /// sessionId 与官方形状缺失（message/requestedSchema/scope）fail-closed。
    #[test]
    fn elicitation_scope_projection_matches_official_shapes() {
        use ElicitationScopeProjection as P;
        // request-scoped：官方 auth/config 阶段形状。
        assert_eq!(
            project_elicitation_scope(&serde_json::json!({
                "mode": "form",
                "requestId": 7,
                "message": "auth configuration needed",
                "requestedSchema": {"type": "object", "properties": {}, "required": []}
            }))
            .unwrap(),
            P::Request
        );
        // session-scoped（经 typed 路径）取回投影 id。
        assert_eq!(
            project_elicitation_scope(&serde_json::json!({
                "mode": "form",
                "sessionId": "peri-s1",
                "message": "m",
                "requestedSchema": {"type": "object"}
            }))
            .unwrap(),
            P::Session {
                session_id: "peri-s1".into()
            }
        );
        // 显式空 sessionId：Session scope 形状成立但 id 为空——fail-closed。
        assert!(project_elicitation_scope(&serde_json::json!({
            "mode": "form", "sessionId": "", "message": "m",
            "requestedSchema": {"type": "object"}
        }))
        .is_err());
        // 无任何 scope：官方形状缺失。
        assert!(project_elicitation_scope(
            &serde_json::json!({"mode": "form", "message": "m", "requestedSchema": {"type": "object"}})
        )
        .is_err());
        // message 官方必填。
        assert!(project_elicitation_scope(
            &serde_json::json!({"mode": "form", "requestId": 1, "requestedSchema": {"type": "object"}})
        )
        .is_err());
        // 审查 P2：string 形态 requestId（RequestId untagged Number/Str）同样
        // 成立——schema 将来收窄 RequestId 时此处先红。
        assert_eq!(
            project_elicitation_scope(&serde_json::json!({
                "mode": "form", "requestId": "req-1",
                "message": "m", "requestedSchema": {"type": "object"}
            }))
            .unwrap(),
            P::Request
        );
        // 审查 P2：sessionId 与 requestId 并存时 untagged 按序 Session 胜出
        // （Request scope 只在 Session 形状不成立时兜底）。
        assert_eq!(
            project_elicitation_scope(&serde_json::json!({
                "mode": "form", "sessionId": "peri-s1", "requestId": 7,
                "message": "m", "requestedSchema": {"type": "object"}
            }))
            .unwrap(),
            P::Session {
                session_id: "peri-s1".into()
            }
        );
    }

    #[test]
    fn builds_codeg_provider_response_shapes() {
        let questions = parse_questions(PrivateBridge::GrokExtQuestions, &serde_json::json!({"questions":[{"question":"Pick","header":"Choice","options":[{"label":"A"},{"label":"B"}]}]})).unwrap();
        let answer = question_policy::QuestionAnswer {
            answers: vec![question_policy::QuestionAnswerItem {
                question_id: questions[0].id.clone(),
                labels: vec!["A".into()],
            }],
            declined: false,
        };
        let grok =
            build_question_response(PrivateBridge::GrokExtQuestions, &questions, &answer).unwrap();
        assert_eq!(grok["outcome"], "accepted");
        assert_eq!(grok["answers"]["Pick"], "A");
        let pi = build_question_response(PrivateBridge::PiSelectAsk, &questions, &answer).unwrap();
        assert_eq!(pi["optionId"], "A");
    }
}
