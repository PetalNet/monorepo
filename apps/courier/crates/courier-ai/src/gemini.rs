//! Gemini wire types and schema sanitization.
//!
//! Gemini's `generateContent` API speaks a different shape than the `OpenAI`
//! chat-completions API; the chat loop converts to these types when the
//! configured provider is `gemini`. [`sanitize_schema`] rewrites JSON-Schema
//! tool definitions into the subset Gemini accepts (uppercased scalar types,
//! no `$schema`/`additionalProperties`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
pub struct GeminiBody {
    pub contents: Vec<Content>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Tools>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_instruction: Option<Content>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Content {
    pub role: String,
    pub parts: Vec<Part>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum Part {
    Text {
        text: String,
    },
    FunctionCall {
        #[serde(rename = "functionCall")]
        function_call: FunctionCall,
    },
    FunctionResponse {
        #[serde(rename = "functionResponse")]
        function_response: FunctionResponse,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FunctionCall {
    pub name: String,
    pub args: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FunctionResponse {
    pub name: String,
    pub response: Value,
}

#[derive(Serialize)]
pub struct Tools {
    pub function_declarations: Vec<FunctionDeclaration>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDeclaration {
    pub name: String,
    pub description: Option<String>,
    pub parameters: Value,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeminiResponse {
    pub candidates: Option<Vec<Candidate>>,
}

#[derive(Deserialize, Debug)]
pub struct Candidate {
    pub content: Content,
}

/// Rewrite a JSON-Schema tool definition into the subset Gemini accepts.
pub fn sanitize_schema(v: Value) -> Value {
    match v {
        Value::Object(mut map) => {
            map.remove("$schema");
            map.remove("additionalProperties");

            if let Some(t) = map.remove("type") {
                let new_type = match t {
                    Value::String(s) => Value::String(s.to_uppercase()),
                    Value::Array(arr) => arr.first().and_then(Value::as_str).map_or_else(
                        || Value::String("STRING".to_owned()),
                        |s| Value::String(s.to_uppercase()),
                    ),
                    Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => {
                        Value::String("OBJECT".to_owned())
                    }
                };
                map.insert("type".to_owned(), new_type);
            }

            // Recurse
            for v in map.values_mut() {
                *v = sanitize_schema(v.clone());
            }

            Value::Object(map)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(sanitize_schema).collect()),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => v,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_sanitize_schema() {
        let schema = json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "query": {
                    "type": ["string", "null"],
                    "description": "Search query"
                },
                "limit": {
                    "type": "number"
                }
            }
        });

        let sanitized = sanitize_schema(schema);

        let obj = sanitized.as_object().unwrap();
        assert!(!obj.contains_key("$schema"));
        assert!(!obj.contains_key("additionalProperties"));

        let props = obj.get("properties").unwrap().as_object().unwrap();
        let query = props.get("query").unwrap().as_object().unwrap();
        assert_eq!(query.get("type").unwrap(), &json!("STRING"));

        let limit = props.get("limit").unwrap().as_object().unwrap();
        // sanitize_schema uppercases scalar types, so "number" -> Gemini's "NUMBER".
        assert_eq!(limit.get("type").unwrap(), &json!("NUMBER"));
    }
}
