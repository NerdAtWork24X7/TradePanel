//! Locked-down launch configuration for the bundled Pi process.
//!
//! Security properties enforced here (not by prompt text):
//! * the child gets a cleared environment, so Hyperliquid keys and unrelated
//!   developer secrets never reach the model host,
//! * only one provider key is injected, from the OS keyring,
//! * only the five read-only analysis tools are declared,
//! * built-in tools, skills, MCP, prompt templates, project instructions and
//!   project trust are all disabled; explicit extensions are limited to the
//!   bundled analysis extension and the user-installed extension folder.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;

use super::paths::AiPaths;
use super::runtime::AiRuntime;

pub const TOOL_ALLOWLIST: &str =
    "panel_market_context,panel_indicators,panel_portfolio,panel_order_ticket,panel_submit_trade_plan";

/// Environment variables copied from the host. Everything else is dropped.
const ENV_ALLOWLIST: [&str; 20] = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

pub struct Launch<'a> {
    pub runtime: &'a AiRuntime,
    pub paths: &'a AiPaths,
    pub provider: &'a str,
    pub model: &'a str,
    pub thinking: &'a str,
    /// `None` starts an ephemeral in-memory session (used for connectivity probes).
    pub session_id: Option<&'a str>,
    /// Override the bundled analysis prompt (probe only).
    pub system_prompt: Option<&'a str>,
}

pub fn provider_env_var(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        "google" => Some("GEMINI_API_KEY"),
        "openrouter" => Some("OPENROUTER_API_KEY"),
        "deepseek" => Some("DEEPSEEK_API_KEY"),
        "groq" => Some("GROQ_API_KEY"),
        "xai" => Some("XAI_API_KEY"),
        "mistral" => Some("MISTRAL_API_KEY"),
        "cerebras" => Some("CEREBRAS_API_KEY"),
        "together" => Some("TOGETHER_API_KEY"),
        "fireworks" => Some("FIREWORKS_API_KEY"),
        "nvidia" => Some("NVIDIA_API_KEY"),
        "moonshot" => Some("MOONSHOT_API_KEY"),
        "zai" => Some("ZAI_API_KEY"),
        "opencode" => Some("OPENCODE_API_KEY"),
        "huggingface" => Some("HF_TOKEN"),
        _ => None,
    }
}

pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "Anthropic",
        "openai" => "OpenAI",
        "google" => "Google Gemini",
        "openrouter" => "OpenRouter",
        "deepseek" => "DeepSeek",
        "groq" => "Groq",
        "xai" => "xAI",
        "mistral" => "Mistral",
        "cerebras" => "Cerebras",
        "together" => "Together AI",
        "fireworks" => "Fireworks AI",
        "nvidia" => "NVIDIA NIM",
        "moonshot" => "Moonshot AI",
        "zai" => "ZAI",
        "opencode" => "OpenCode Zen",
        "huggingface" => "Hugging Face",
        _ => "Unknown provider",
    }
}

#[cfg(test)]
pub fn allowed_providers() -> Vec<&'static str> {
    vec![
        "anthropic",
        "openai",
        "google",
        "openrouter",
        "deepseek",
        "groq",
        "xai",
        "mistral",
        "cerebras",
        "together",
        "fireworks",
        "nvidia",
        "moonshot",
        "zai",
        "opencode",
        "huggingface",
    ]
}

#[cfg(test)]
pub fn is_allowed_provider(provider: &str) -> bool {
    allowed_providers().contains(&provider)
}

/// Build the argument vector. Kept pure so the isolation flags are unit-tested.
pub fn args(launch: &Launch<'_>) -> Vec<String> {
    let mut args: Vec<String> = vec!["--mode".into(), "rpc".into()];
    if !launch.provider.is_empty() {
        args.push("--provider".into());
        args.push(launch.provider.into());
    }
    if !launch.model.is_empty() {
        args.push("--model".into());
        args.push(launch.model.into());
    }
    if !launch.thinking.is_empty() {
        args.push("--thinking".into());
        args.push(launch.thinking.into());
    }
    args.extend([
        "--no-context-files".into(),
        "--no-skills".into(),
        "--no-prompt-templates".into(),
        "--no-extensions".into(),
        "--no-mcp".into(),
        "--no-builtin-tools".into(),
        "--no-approve".into(),
        "--extension".into(),
        launch.runtime.extension.to_string_lossy().into_owned(),
    ]);
    // Load every extension the user installed in the app-data or Pi global
    // extension folder. Filenames are not hardcoded; the allow-list below still
    // bounds the tools the model can call.
    for extension in launch.paths.extension_files() {
        args.push("--extension".into());
        args.push(extension.to_string_lossy().into_owned());
    }
    args.extend([
        "--tools".into(),
        TOOL_ALLOWLIST.into(),
        "--system-prompt".into(),
        launch
            .system_prompt
            .map(str::to_string)
            .unwrap_or_else(|| launch.runtime.system_prompt.to_string_lossy().into_owned()),
    ]);
    match launch.session_id {
        Some(id) => {
            args.push("--session-dir".into());
            args.push(launch.paths.sessions.to_string_lossy().into_owned());
            args.push("--session-id".into());
            args.push(id.into());
        }
        None => args.push("--no-session".into()),
    }
    args
}

/// Build the isolated child environment. The provider key is passed by the
/// caller (sourced from the OS keyring) and is the only credential present.
pub fn env_pairs(launch: &Launch<'_>, provider_key: &str) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = ENV_ALLOWLIST
        .iter()
        .filter_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| ((*name).to_string(), value))
        })
        .collect();
    env.push((
        "HOME".into(),
        launch.paths.root.to_string_lossy().into_owned(),
    ));
    env.push((
        "PI_CODING_AGENT_DIR".into(),
        launch.paths.agent.to_string_lossy().into_owned(),
    ));
    env.push((
        "PI_CODING_AGENT_SESSION_DIR".into(),
        launch.paths.sessions.to_string_lossy().into_owned(),
    ));
    env.push(("PI_SKIP_VERSION_CHECK".into(), "1".into()));
    env.push(("PI_TELEMETRY".into(), "0".into()));
    env.push((
        "TRADEPANEL_AI_CONTEXT_FILE".into(),
        launch.paths.context_file.to_string_lossy().into_owned(),
    ));
    // The Pi Scope extension authenticates against a local dashboard token.
    // The child HOME is isolated, so hand it the token *file* path rather than
    // the token itself.
    if let Some(path) = scope_token_file() {
        env.push((
            "SCOPE_TOKEN_FILE".into(),
            path.to_string_lossy().into_owned(),
        ));
    }
    if let Ok(url) = std::env::var("OBS_SERVER_URL") {
        if !url.is_empty() {
            env.push(("OBS_SERVER_URL".into(), url));
        }
    }
    if !provider_key.is_empty() {
        if let Some(name) = provider_env_var(launch.provider) {
            env.push((name.to_string(), provider_key.to_string()));
        }
    }
    env
}

/// Locate the Pi Scope dashboard token file without leaking the token into the
/// child environment. The isolated child HOME does not point at the real user
/// home, so the standard install location is resolved here.
fn scope_token_file() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SCOPE_TOKEN_FILE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let path = PathBuf::from(home).join(".pi-scope").join("scope_token");
    path.is_file().then_some(path)
}

pub fn command(launch: &Launch<'_>, provider_key: &str) -> Command {
    let mut command = Command::new(&launch.runtime.node);
    command
        .arg(&launch.runtime.pi_cli)
        .args(args(launch))
        .current_dir(&launch.paths.workspace)
        .env_clear()
        .envs(env_pairs(launch, provider_key))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: JSONL on pipes, no console flash.
        command.creation_flags(0x0800_0000);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> (AiRuntime, AiPaths) {
        let root = PathBuf::from("/tmp/tradepanel-ai-test");
        let runtime = AiRuntime {
            root: root.join("runtime"),
            node: root.join("runtime/node/node"),
            pi_cli: root.join("runtime/pi/cli.js"),
            extension: root.join("runtime/pi/extensions/a.mjs"),
            system_prompt: root.join("runtime/pi/prompts/a.md"),
            settings_service: None,
            node_version: "v22.0.0".into(),
            pi_version: "1.5.0".into(),
            target: "linux-x64".into(),
        };
        let paths = AiPaths {
            root: root.join("ai"),
            agent: root.join("ai/agent"),
            sessions: root.join("ai/sessions"),
            workspace: root.join("ai/workspace"),
            context_file: root.join("ai/context.json"),
            settings_file: root.join("ai/settings.json"),
            conversations_file: root.join("ai/conversations.json"),
        };
        (runtime, paths)
    }

    #[test]
    fn arguments_disable_every_coding_capability() {
        let (runtime, paths) = fixture();
        let args = args(&Launch {
            runtime: &runtime,
            paths: &paths,
            provider: "openai",
            model: "gpt-4o-mini",
            thinking: "medium",
            session_id: Some("ai-123"),
            system_prompt: None,
        });
        for required in [
            "--no-builtin-tools",
            "--no-context-files",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-mcp",
            "--no-approve",
            "--extension",
            "--system-prompt",
            "--session-id",
            "--session-dir",
        ] {
            assert!(args.iter().any(|arg| arg == required), "missing {required}");
        }
        let tools = args
            .iter()
            .position(|arg| arg == "--tools")
            .map(|index| args[index + 1].as_str())
            .unwrap();
        assert_eq!(tools, TOOL_ALLOWLIST);
        for forbidden in [
            "bash", "read", "write", "edit", "grep", "find", "ls", "codemode",
        ] {
            assert!(
                !tools.split(',').any(|tool| tool == forbidden),
                "{forbidden} leaked"
            );
        }
        assert!(args.iter().all(|arg| !arg.contains("bash")));
    }

    #[test]
    fn loads_user_extensions_without_hardcoding_names() {
        let (runtime, mut paths) = fixture();
        let root = std::env::temp_dir().join(format!("tradepanel-ai-ext-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        paths.root = root.clone();
        paths.agent = root.join("agent");
        let launch = Launch {
            runtime: &runtime,
            paths: &paths,
            provider: "openai",
            model: "gpt-4o-mini",
            thinking: "medium",
            session_id: Some("ai-ext"),
            system_prompt: None,
        };

        let before = args(&launch);
        assert_eq!(
            before.iter().filter(|arg| *arg == "--extension").count(),
            1,
            "analysis extension must always load"
        );

        let app_extensions = root.join("extensions");
        let agent_extensions = paths.agent.join("extensions");
        std::fs::create_dir_all(&app_extensions).unwrap();
        std::fs::create_dir_all(&agent_extensions).unwrap();
        std::fs::write(
            app_extensions.join("observability.ts"),
            "export default () => {};\n",
        )
        .unwrap();
        std::fs::write(
            agent_extensions.join("helper.js"),
            "export default () => {};\n",
        )
        .unwrap();
        std::fs::write(app_extensions.join("README.md"), "not an extension\n").unwrap();
        std::fs::write(app_extensions.join("types.d.ts"), "export {};\n").unwrap();

        let args = args(&launch);
        let loaded: Vec<&str> = args
            .iter()
            .enumerate()
            .filter(|(_, arg)| *arg == "--extension")
            .map(|(index, _)| args[index + 1].as_str())
            .collect();
        assert_eq!(loaded.len(), 3, "analysis plus both user extensions");
        assert!(loaded.iter().any(|path| path.ends_with("observability.ts")));
        assert!(loaded.iter().any(|path| path.ends_with("helper.js")));
        assert!(!loaded.iter().any(|path| path.ends_with("README.md")));
        assert!(!loaded.iter().any(|path| path.ends_with("types.d.ts")));
        let tools = args
            .iter()
            .position(|arg| arg == "--tools")
            .map(|index| args[index + 1].as_str())
            .unwrap();
        assert_eq!(tools, TOOL_ALLOWLIST);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ephemeral_probe_has_no_session_and_environment_is_minimal() {
        let (runtime, paths) = fixture();
        let launch = Launch {
            runtime: &runtime,
            paths: &paths,
            provider: "anthropic",
            model: "claude-sonnet-4",
            thinking: "low",
            session_id: None,
            system_prompt: None,
        };
        let args = args(&launch);
        assert!(args.iter().any(|arg| arg == "--no-session"));
        assert!(!args.iter().any(|arg| arg == "--session-id"));

        let env = env_pairs(&launch, "sk-test-key");
        let names: Vec<&str> = env.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"PI_CODING_AGENT_DIR"));
        assert!(names.contains(&"ANTHROPIC_API_KEY"));
        for forbidden in ["HL_PRIVATE_KEY", "HL_ADDRESS", "OPENAI_API_KEY"] {
            assert!(!names.contains(&forbidden), "{forbidden} must not leak");
        }
        assert_eq!(
            env.iter()
                .find(|(name, _)| name == "ANTHROPIC_API_KEY")
                .unwrap()
                .1,
            "sk-test-key"
        );
    }

    #[test]
    fn provider_registry_is_consistent() {
        for provider in allowed_providers() {
            assert!(
                provider_env_var(provider).is_some(),
                "{provider} has no env var"
            );
            assert!(!provider_label(provider).is_empty());
        }
        assert!(!is_allowed_provider("definitely-not-a-provider"));
    }
}

/// Command for the provider settings bridge. It shares the locked-down
/// environment with the analysis process (no trading credentials) and runs in
/// the same empty workspace; the only difference is that it exposes Pi's
/// `ModelRuntime` over JSONL instead of starting an agent session.
pub fn auth_command(runtime: &AiRuntime, paths: &AiPaths) -> Result<Command, String> {
    let service = runtime.settings_service.as_ref().ok_or_else(|| {
        "This AI runtime has no provider settings service. Rebuild the AI runtime.".to_string()
    })?;
    let mut env: Vec<(String, String)> = ENV_ALLOWLIST
        .iter()
        .filter_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| ((*name).to_string(), value))
        })
        .collect();
    env.push(("HOME".into(), paths.root.to_string_lossy().into_owned()));
    env.push((
        "PI_CODING_AGENT_DIR".into(),
        paths.agent.to_string_lossy().into_owned(),
    ));
    env.push(("PI_SKIP_VERSION_CHECK".into(), "1".into()));
    env.push(("PI_TELEMETRY".into(), "0".into()));
    env.push(("PI_OFFLINE".into(), "1".into()));
    env.push(("TRADEPANEL_AI_SETTINGS_SERVICE".into(), "1".into()));
    let mut command = Command::new(&runtime.node);
    command
        .arg(service)
        .current_dir(&paths.workspace)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    Ok(command)
}
