//! Locked-down launch configuration for the bundled Pi process.
//!
//! Security properties enforced here (not by prompt text):
//! * the child gets a cleared environment, so exchange keys and unrelated
//!   developer secrets never reach the model host;
//! * only one provider key is injected, read from the OS keyring by the host;
//! * only the five read-only analysis tools are declared;
//! * built-in tools, skills, MCP, prompt templates, project instructions and
//!   project trust are all disabled; the only extension is the bundled
//!   analysis extension.

use std::path::Path;

use super::paths::PiPaths;
use super::runtime::PiRuntime;

pub const PROVIDER_ID: &str = "tradepanel";
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
    pub runtime: &'a PiRuntime,
    pub paths: &'a PiPaths,
    pub provider: &'a str,
    pub model: &'a str,
    /// The provider key from the OS keyring; empty for a keyless loopback server.
    pub provider_key: &'a str,
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
        "--tools".into(),
        TOOL_ALLOWLIST.into(),
        "--system-prompt".into(),
        launch.runtime.system_prompt.to_string_lossy().into_owned(),
        "--no-session".into(),
    ]);
    args
}

/// Host variables (proxy, CA bundles, locale, temp dirs) that child processes
/// may inherit.
pub fn sanitized_env() -> Vec<(String, String)> {
    ENV_ALLOWLIST
        .iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| ((*name).to_string(), value)))
        .collect()
}

/// Build the isolated child environment. The provider key is the only
/// credential present.
pub fn env_pairs(launch: &Launch<'_>) -> Vec<(String, String)> {
    let mut env = sanitized_env();
    env.push(("HOME".into(), launch.paths.root.to_string_lossy().into_owned()));
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
    if !launch.provider_key.is_empty() {
        env.push(("TRADEPANEL_API_KEY".into(), launch.provider_key.into()));
    }
    env
}

/// The child's working directory: empty, so no `AGENTS.md` or project files
/// can be discovered.
pub fn working_dir<'a>(launch: &'a Launch<'a>) -> &'a Path {
    &launch.paths.workspace
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn runtime() -> PiRuntime {
        PiRuntime {
            target: "linux-x64".into(),
            root: PathBuf::from("/rt"),
            node: PathBuf::from("/rt/node/node"),
            pi_cli: PathBuf::from("/rt/pi/cli.js"),
            npm_cli: None,
            extension: PathBuf::from("/rt/pi/extensions/tradepanel-analysis.mjs"),
            system_prompt: PathBuf::from("/rt/pi/prompts/analysis.md"),
            node_version: None,
            pi_version: None,
        }
    }

    fn paths() -> PiPaths {
        PiPaths {
            root: PathBuf::from("/data/ai"),
            agent: PathBuf::from("/data/ai/agent"),
            sessions: PathBuf::from("/data/ai/sessions"),
            workspace: PathBuf::from("/data/ai/workspace"),
            context_file: PathBuf::from("/data/ai/context.json"),
        }
    }

    #[test]
    fn every_dangerous_capability_is_disabled() {
        let rt = runtime();
        let p = paths();
        let args = args(&Launch {
            runtime: &rt,
            paths: &p,
            provider: PROVIDER_ID,
            model: "gpt-4o-mini",
            provider_key: "sk-test",
        });
        for flag in [
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--no-extensions",
            "--no-mcp",
            "--no-builtin-tools",
            "--no-approve",
            "--no-session",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}");
        }
        assert_eq!(args.iter().filter(|a| *a == "--tools").count(), 1);
        let tools = args[args.iter().position(|a| a == "--tools").unwrap() + 1].clone();
        assert_eq!(tools, TOOL_ALLOWLIST);
        assert!(args.contains(&"/rt/pi/extensions/tradepanel-analysis.mjs".to_string()));
        assert!(args.contains(&"/rt/pi/prompts/analysis.md".to_string()));
        assert!(!args.iter().any(|a| a.contains("bash") || a.contains("codemode")));
    }

    #[test]
    fn the_child_gets_only_the_provider_key_and_host_furniture() {
        let rt = runtime();
        let p = paths();
        let env = env_pairs(&Launch {
            runtime: &rt,
            paths: &p,
            provider: PROVIDER_ID,
            model: "m",
            provider_key: "sk-secret",
        });
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(map.get("TRADEPANEL_API_KEY").map(String::as_str), Some("sk-secret"));
        assert_eq!(map.get("HOME").map(String::as_str), Some("/data/ai"));
        assert_eq!(map.get("PI_CODING_AGENT_DIR").map(String::as_str), Some("/data/ai/agent"));
        assert_eq!(
            map.get("TRADEPANEL_AI_CONTEXT_FILE").map(String::as_str),
            Some("/data/ai/context.json")
        );
        // No credential-shaped variable leaks in (the keyring key is the only one).
        for name in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HL_PRIVATE_KEY", "AWS_SECRET_ACCESS_KEY"] {
            assert!(!map.contains_key(name), "{name} leaked");
        }
    }

    #[test]
    fn a_keyless_loopback_launch_injects_no_key_variable() {
        let rt = runtime();
        let p = paths();
        let env = env_pairs(&Launch {
            runtime: &rt,
            paths: &p,
            provider: PROVIDER_ID,
            model: "m",
            provider_key: "",
        });
        assert!(env.iter().all(|(name, _)| name != "TRADEPANEL_API_KEY"));
    }
}
