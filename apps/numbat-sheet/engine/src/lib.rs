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
            probe: self.prelude.clone(),
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
    /// A scope with no cells in it, where literals are checked.
    probe: Context,
}

/// A value has no `code` and both renderings; an error has a `code` and Numbat's message as `text`.
/// `missing` names a cell the expression uses that is not defined yet.
#[wasm_bindgen(getter_with_clone)]
pub struct CellOutcome {
    pub code: Option<String>,
    pub text: String,
    pub full: Option<String>,
    pub missing: Option<String>,
}

enum Failure {
    Numbat(Box<NumbatError>),
    NotAValue(String),
}

#[wasm_bindgen]
impl Session {
    /// Numbat's own name resolution finds the cells a formula uses, including inside string
    /// interpolations, so the caller defines each `missing` cell and calls this again.
    pub fn define(&mut self, name: &str, expr: &str) -> CellOutcome {
        let result = evaluate(&mut self.ctx, name, expr);
        forget_last_result(&mut self.ctx);
        outcome(result)
    }

    /// A literal may not use cells, so it must evaluate in a scope that has none.
    pub fn define_literal(&mut self, name: &str, expr: &str) -> CellOutcome {
        let checked = self.probe.interpret(expr, CodeSource::Text);
        forget_last_result(&mut self.probe);
        match checked {
            Ok(_) => self.define(name, expr),
            Err(error) => outcome(Err(Failure::Numbat(error))),
        }
    }
}

/// Numbat keeps the last value in `ans` and `_`. Resetting them after every cell stops one cell
/// from reading another through them, which would hide the dependency.
fn forget_last_result(ctx: &mut Context) {
    let _ = ctx.interpret(r#""""#, CodeSource::Text);
}

/// Binds `name` in a scratch copy of the scope and commits it only once the value is accepted, so
/// a rejected cell leaves nothing for dependents to use.
fn evaluate(ctx: &mut Context, name: &str, expr: &str) -> Result<(String, String), Failure> {
    let mut scratch = ctx.clone();
    let _ = scratch
        .interpret(&format!("let {name} = {expr}"), CodeSource::Text)
        .map_err(Failure::Numbat)?;
    let value = match scratch
        .interpret(name, CodeSource::Text)
        .map_err(Failure::Numbat)?
        .1
    {
        InterpreterResult::Value(Value::FunctionReference(_)) | InterpreterResult::Continue => {
            return Err(Failure::NotAValue(expr.to_owned()));
        }
        InterpreterResult::Value(value) => value,
    };
    *ctx = scratch;
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

fn outcome(result: Result<(String, String), Failure>) -> CellOutcome {
    let error = |code: &str, text| CellOutcome {
        code: Some(code.to_owned()),
        text,
        full: None,
        missing: None,
    };
    match result {
        Ok((display, full)) => CellOutcome {
            code: None,
            text: display,
            full: Some(full),
            missing: None,
        },
        Err(Failure::NotAValue(expr)) => error("#ERROR", format!("{expr} is not a value")),
        Err(Failure::Numbat(e)) => CellOutcome {
            missing: missing_cell(&e),
            ..error(code(&e), message(&e))
        },
    }
}

fn missing_cell(error: &NumbatError) -> Option<String> {
    match error {
        NumbatError::TypeCheckError(TypeCheckError::UnknownIdentifier(_, name, _)) => {
            let digits = name.trim_start_matches(|c: char| c.is_ascii_uppercase());
            let is_cell = digits.len() < name.len()
                && !digits.is_empty()
                && digits.bytes().all(|b| b.is_ascii_digit());
            is_cell.then(|| name.clone())
        }
        _ => None,
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
    fn missing_cells_come_from_numbat_name_resolution() {
        let engine = Engine::new();
        let mut s = engine.session();
        for (expr, missing) in [
            ("B1 * 2", Some("B1")),
            (r#""{B1}""#, Some("B1")),
            (r#""\{B1}""#, Some("B1")),
            (r#""{{B1}} and {C1}""#, Some("C1")),
            (r#""{{B1}}""#, None),
            (r#""B1""#, None),
            ("distance", None),
        ] {
            assert_eq!(s.define("A1", expr).missing.as_deref(), missing, "{expr}");
        }
    }

    #[test]
    fn literals_cannot_use_cells() {
        let engine = Engine::new();
        let mut s = engine.session();
        let _ = s.define("B1", "3 m");
        assert_eq!(s.define_literal("A1", "26.2 mi").text, "26.2 mi");
        assert_eq!(s.define_literal("A2", "B1").code.as_deref(), Some("#NAME"));
        assert_eq!(
            s.define_literal("A3", r#""{B1}""#).code.as_deref(),
            Some("#NAME")
        );
    }

    #[test]
    fn rejected_cells_leave_no_binding() {
        let engine = Engine::new();
        let mut s = engine.session();
        assert_eq!(
            s.define_literal("A1", "abs").code.as_deref(),
            Some("#ERROR")
        );
        assert_eq!(s.define("B1", "A1(-1)").missing.as_deref(), Some("A1"));
        assert_eq!(s.define("A2", "sin").code.as_deref(), Some("#ERROR"));
        assert_eq!(s.define("B2", "A2(1)").missing.as_deref(), Some("A2"));
        assert_eq!(s.define("A3", "1 m + 1 s").code.as_deref(), Some("#UNIT"));
        assert_eq!(s.define("B3", "A3").missing.as_deref(), Some("A3"));
    }

    #[test]
    fn cells_cannot_read_each_other_through_ans() {
        let engine = Engine::new();
        let mut s = engine.session();
        let _ = s.define("A1", "1 m");
        let _ = s.define("A2", "sin");
        assert_ne!(s.define("A3", "ans(1)").code, None);
        let mut s = engine.session();
        let _ = s.define_literal("B1", "1 m");
        assert_ne!(s.define_literal("B2", "ans + 1 m").code, None);
    }

    #[test]
    fn trailing_comments_are_allowed() {
        let engine = Engine::new();
        let mut s = engine.session();
        assert_eq!(s.define_literal("A1", "3 m # distance").text, "3 m");
        assert_eq!(s.define("A2", "A1 * 2 # doubled").text, "6 m");
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
