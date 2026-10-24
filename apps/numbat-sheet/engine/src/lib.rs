use numbat::markup::{Formatter, PlainTextFormatter};
use numbat::module_importer::BuiltinModuleImporter;
use numbat::resolver::CodeSource;
use numbat::value::Value;
use numbat::{
    Context, FormatOptions, InterpreterResult, NumbatError, RuntimeErrorKind, TypeCheckError,
};
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
pub struct Engine {
    prelude: Context,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        let mut prelude = Context::new(BuiltinModuleImporter::default());
        let _ = prelude
            .interpret("use prelude", CodeSource::Internal)
            .expect("the bundled prelude loads");
        Self { prelude }
    }

    #[must_use]
    pub fn session(&self) -> Session {
        Session {
            ctx: self.prelude.clone(),
        }
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
pub struct Session {
    ctx: Context,
}

/// A value has no `code` and both renderings; an error has a `code` and Numbat's message as `text`.
#[wasm_bindgen(getter_with_clone)]
pub struct CellOutcome {
    pub code: Option<String>,
    pub text: String,
    pub full: Option<String>,
}

#[wasm_bindgen]
impl Session {
    pub fn define(&mut self, name: &str, expr: &str) -> CellOutcome {
        match self.evaluate(name, expr) {
            Ok((display, full)) => CellOutcome {
                code: None,
                text: display,
                full: Some(full),
            },
            Err((code, message)) => CellOutcome {
                code: Some(code.to_owned()),
                text: message,
                full: None,
            },
        }
    }
}

impl Session {
    fn evaluate(
        &mut self,
        name: &str,
        expr: &str,
    ) -> Result<(String, String), (&'static str, String)> {
        let numbat = |e: Box<NumbatError>| (code(&e), message(&e));
        let _ = self
            .ctx
            .interpret(&format!("let {name} = {expr}"), CodeSource::Text)
            .map_err(numbat)?;
        let value = match self
            .ctx
            .interpret(name, CodeSource::Text)
            .map_err(numbat)?
            .1
        {
            InterpreterResult::Value(value) => value,
            InterpreterResult::Continue => Value::String("".into()),
        };
        if let Value::FunctionReference(_) = value {
            return Err(("#ERROR", format!("{expr} is a function, not a value")));
        }
        let show = |significant_digits| match &value {
            Value::String(s) => s.to_string(),
            value => PlainTextFormatter
                .format(
                    &value.pretty_print_with(&FormatOptions {
                        significant_digits,
                        ..FormatOptions::default()
                    }),
                    false,
                )
                .to_string(),
        };
        Ok((show(6), show(15)))
    }
}

fn code(error: &NumbatError) -> &'static str {
    match error {
        NumbatError::TypeCheckError(TypeCheckError::IncompatibleDimensions(_)) => "#UNIT",
        NumbatError::TypeCheckError(TypeCheckError::UnknownIdentifier(..)) => "#NAME",
        NumbatError::TypeCheckError(TypeCheckError::DivisionByZeroInConstEvalExpression(_)) => {
            "#DIV/0"
        }
        NumbatError::RuntimeError(e) if matches!(e.kind, RuntimeErrorKind::DivisionByZero) => {
            "#DIV/0"
        }
        NumbatError::ResolverError(_) => "#SYNTAX",
        _ => "#ERROR",
    }
}

fn message(error: &NumbatError) -> String {
    match error {
        // This Display carries only the two sides; the operation lives in a diagnostic label.
        NumbatError::TypeCheckError(TypeCheckError::IncompatibleDimensions(e)) => {
            format!("Incompatible dimensions in {}\n{error}", e.operation)
        }
        _ => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn define(session: &mut Session, name: &str, expr: &str) -> (Option<String>, String) {
        let out = session.define(name, expr);
        (out.code, out.text)
    }

    fn value(text: &str) -> (Option<String>, String) {
        (None, text.into())
    }

    #[test]
    fn cells_show_values_and_conversions() {
        let engine = Engine::new();
        let mut s = engine.session();
        assert_eq!(define(&mut s, "B1", "26.2 mi"), value("26.2 mi"));
        assert_eq!(define(&mut s, "B2", "3 h + 30 min"), value("210 min"));
        assert_eq!(define(&mut s, "B3", "B1 / B2 -> mph"), value("7.48571 mph"));
        assert_eq!(define(&mut s, "B4", "B1 → km"), value("42.1648 km"));
        assert_eq!(
            s.define("B5", "B3").full,
            Some("7.48571428571429 mph".into())
        );
        assert_eq!(define(&mut s, "B6", "\"label\""), value("label"));
    }

    #[test]
    fn errors_carry_a_code_and_numbat_message() {
        let engine = Engine::new();
        let mut s = engine.session();
        let _ = s.define("B1", "26.2 mi");
        let (code, mismatch) = define(&mut s, "C1", "B1 + 3 h");
        assert_eq!(code.as_deref(), Some("#UNIT"));
        assert!(
            mismatch.starts_with("Incompatible dimensions in addition\n"),
            "{mismatch}"
        );
        assert!(mismatch.contains("Time"), "{mismatch}");
        for (expr, code) in [
            ("B1 -> s", "#UNIT"),
            ("distance", "#NAME"),
            ("(3", "#SYNTAX"),
            ("1 m / 0", "#DIV/0"),
            ("\"a\" + 1", "#ERROR"),
            ("time", "#ERROR"),
        ] {
            assert_eq!(
                define(&mut s, "C2", expr).0.as_deref(),
                Some(code),
                "{expr}"
            );
        }
    }

    #[test]
    fn sessions_do_not_share_bindings() {
        let engine = Engine::new();
        let _ = engine.session().define("B1", "1 m");
        assert_eq!(
            define(&mut engine.session(), "B2", "B1"),
            (Some("#NAME".into()), "Unknown identifier 'B1'.".into())
        );
    }
}
