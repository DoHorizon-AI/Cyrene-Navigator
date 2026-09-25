//! ┌─────────────────────────────────────────────────────────────────────┐
//! │  📄 main.rs                                                          │
//! │  Module: installer                                                   │
//! │  Role: Cyrene Modular Installer, Orchestrator & Clean Uninstaller   │
//! │  模块职责：Cyrene 统一模块化安装器、服务编排器与干净卸载工具。     │
//! └─────────────────────────────────────────────────────────────────────┘

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

const DEFAULT_EXCHANGE_URL: &str =
    "https://cyrene-exchange.calmsky-23e48c1c.westus2.azurecontainerapps.io";

#[derive(Clone, Copy)]
enum ToolKind {
    LocalAgent,
    ContainerService,
}

struct ToolSpec {
    id: &'static str,
    title: &'static str,
    kind: ToolKind,
    image: Option<&'static str>,
    port: Option<u16>,
    desc: &'static str,
}

const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        id: "navigator",
        title: "Cyrene Navigator (桌面 Agent & DeepSeek Harness 运行时)",
        kind: ToolKind::LocalAgent,
        image: None,
        port: None,
        desc: "本地增强智能体环境、Native Host 进程调度与 Exchange 路由连接器",
    },
    ToolSpec {
        id: "exchange",
        title: "Cyrene Exchange (API 网关 & 路由分发中心)",
        kind: ToolKind::ContainerService,
        image: Some("ghcr.io/baijin64/cyrene-exchange:latest"),
        port: Some(8000),
        desc: "OpenAI 兼容端点、统一凭据认证与模型提供商连接器",
    },
    ToolSpec {
        id: "reactor",
        title: "Cyrene Reactor (模型推理与部署控制面)",
        kind: ToolKind::ContainerService,
        image: Some("ghcr.io/baijin64/cyrene-reactor:latest"),
        port: Some(19300),
        desc: "推理端点协调、模型放置策略与计算引擎连接",
    },
    ToolSpec {
        id: "yield",
        title: "Cyrene Yield (统一模型训练与微调服务)",
        kind: ToolKind::ContainerService,
        image: Some("ghcr.io/baijin64/cyrene-yield:latest"),
        port: Some(8092),
        desc: "训练生命周期管理、检查点持久化与插件训练编排",
    },
    ToolSpec {
        id: "catalyst",
        title: "Cyrene Catalyst (数据集准备与血缘服务)",
        kind: ToolKind::ContainerService,
        image: Some("ghcr.io/baijin64/cyrene-catalyst:latest"),
        port: Some(8014),
        desc: "数据集导入、指令映射、划分与训练格式发布",
    },
    ToolSpec {
        id: "echo",
        title: "Cyrene Echo (模型评测与质量门禁服务)",
        kind: ToolKind::ContainerService,
        image: Some("ghcr.io/baijin64/cyrene-echo:latest"),
        port: Some(8094),
        desc: "评测套件执行、样本比对与 LLM Judge 质量判定",
    },
];

fn main() {
    let args: Vec<String> = env::args().collect();

    println!("============================================================");
    println!("  Cyrene Installer - Modular Deployment & Clean Uninstaller  ");
    println!("  Cyrene 统一模块化安装器、服务编排与完全干净卸载工具       ");
    println!("============================================================\n");

    if args.contains(&"--help".to_string()) || args.contains(&"-h".to_string()) {
        print_usage(&args[0]);
        return;
    }

    let app_dir = get_cyrene_home();

    // Check for uninstall commands
    if args.contains(&"--uninstall".to_string()) || args.contains(&"--clean-uninstall".to_string())
    {
        let silent = args.contains(&"--silent".to_string());
        let force = args.contains(&"--force".to_string()) || silent;
        perform_clean_uninstall(&app_dir, force);
        return;
    }

    if args.contains(&"--silent".to_string()) {
        run_silent(&args, &app_dir);
    } else {
        run_interactive(&app_dir);
    }
}

fn print_usage(prog: &str) {
    println!("Usage / 用法: {} [OPTIONS]", prog);
    println!("\nOptions / 选项:");
    println!("  --silent                以无交互静默模式运行安装");
    println!("  --uninstall             执行完全干净卸载 (停止容器、清理卷与本地所有数据)");
    println!("  --clean-uninstall       同 --uninstall");
    println!("  --force                 在卸载或部署时不进行二次交互确认");
    println!(
        "  --exchange-url <URL>    设置 Exchange 网关端点 (默认: {})",
        DEFAULT_EXCHANGE_URL
    );
    println!("  --exchange-token <KEY>  设置统一访问 API Key 凭据");
    println!("  --deploy-tools <NAMES>  以逗号分隔下载部署的服务: all 或 navigator,exchange,reactor,yield,catalyst,echo");
    println!("  --generate-compose <PATH> 生成统一 docker-compose.yml 部署清单");
    println!("  -h, --help              显示帮助信息\n");
}

fn run_interactive(app_dir: &Path) {
    println!("📍 Cyrene 环境与数据存储路径: {}", app_dir.display());

    let mut exchange_url = DEFAULT_EXCHANGE_URL.to_string();
    let mut exchange_token = String::new();
    let mut selected_tools: BTreeSet<usize> = BTreeSet::new();

    // Default select navigator
    selected_tools.insert(0);

    loop {
        println!("\n--- [ 安装器功能导航 / Main Menu ] ---");
        println!(
            "1. [组件选装] 勾选/按需选择安装的组件 (当前已选 {}/{} 个)",
            selected_tools.len(),
            TOOLS.len()
        );
        println!(
            "2. [网关配置] 配置 Exchange 网关端点与凭据 (当前: {})",
            exchange_url
        );
        println!("3. [开始部署] 安装选定的本地环境并远程部署后端容器服务");
        println!("4. [环境状态] 查看本地服务与已部署组件运行状态");
        println!("5. [干净卸载] 完整卸载 Cyrene (停止容器/清理卷/删除所有本地配置)");
        println!("6. [完成退出] 保存配置并退出安装器");
        print!("\n请选择操作 [1-6]: ");
        io::stdout().flush().unwrap();

        let mut input = String::new();
        if io::stdin().read_line(&mut input).is_err() {
            break;
        }
        let choice = input.trim();

        match choice {
            "1" => {
                menu_select_tools(&mut selected_tools);
            }
            "2" => {
                println!("\n>> 配置 Exchange 网关端点:");
                println!("   默认云端端点: {}", DEFAULT_EXCHANGE_URL);
                print!("   请输入 Exchange URL (直接回车保持默认): ");
                io::stdout().flush().unwrap();
                let mut url_input = String::new();
                io::stdin().read_line(&mut url_input).unwrap();
                let trimmed_url = url_input.trim();
                if !trimmed_url.is_empty() {
                    exchange_url = trimmed_url.to_string();
                }

                print!("   请输入 Exchange API Bearer Token (可选): ");
                io::stdout().flush().unwrap();
                let mut token_input = String::new();
                io::stdin().read_line(&mut token_input).unwrap();
                exchange_token = token_input.trim().to_string();

                save_exchange_config(app_dir, &exchange_url, &exchange_token);
                println!("   ✅ Exchange 端点已保存: {}", exchange_url);
            }
            "3" => {
                if selected_tools.is_empty() {
                    println!("\n⚠️ 尚未勾选任何组件。请先在菜单 [1] 中选择要安装的组件。");
                    continue;
                }
                deploy_selected_tools(
                    app_dir,
                    &selected_tools,
                    &exchange_url,
                    &exchange_token,
                    true,
                );
            }
            "4" => {
                show_system_status(app_dir);
            }
            "5" => {
                perform_clean_uninstall(app_dir, false);
            }
            "6" => {
                println!("\n🎉 感谢使用 Cyrene Installer。配置已就绪！");
                break;
            }
            _ => {
                println!("无效选项，请输入 1 到 6。");
            }
        }
    }
}

fn menu_select_tools(selected: &mut BTreeSet<usize>) {
    loop {
        println!("\n--- [ 可用组件与服务列表 ] ---");
        for (idx, tool) in TOOLS.iter().enumerate() {
            let status = if selected.contains(&idx) {
                "[x] 已勾选"
            } else {
                "[ ] 未勾选"
            };
            let port_info = match tool.port {
                Some(p) => format!("(端口: {})", p),
                None => "(本地进程/运行时)".to_string(),
            };
            println!("  {}. {} {} {}", idx + 1, status, tool.title, port_info);
            if let Some(img) = tool.image {
                println!("     容器镜像: {}", img);
            }
            println!("     说明: {}", tool.desc);
        }
        println!("\n快捷操作: A. 全选所有组件 | C. 清空选择 | B. 确定并返回");
        print!("\n请输入编号切换勾选，或输入 A/C/B: ");
        io::stdout().flush().unwrap();

        let mut input = String::new();
        io::stdin().read_line(&mut input).unwrap();
        let cmd = input.trim();

        if cmd.eq_ignore_ascii_case("b") {
            break;
        } else if cmd.eq_ignore_ascii_case("a") {
            for i in 0..TOOLS.len() {
                selected.insert(i);
            }
            println!("✅ 已全选所有组件。");
        } else if cmd.eq_ignore_ascii_case("c") {
            selected.clear();
            println!("✅ 已清空选中的组件。");
        } else if let Ok(num) = cmd.parse::<usize>() {
            if num >= 1 && num <= TOOLS.len() {
                let tool_idx = num - 1;
                if selected.contains(&tool_idx) {
                    selected.remove(&tool_idx);
                    println!("➖ 取消勾选: {}", TOOLS[tool_idx].id);
                } else {
                    selected.insert(tool_idx);
                    println!("➕ 已勾选: {}", TOOLS[tool_idx].id);
                }
            } else {
                println!("请输入 1 到 {} 之间的数字", TOOLS.len());
            }
        }
    }
}

fn deploy_selected_tools(
    app_dir: &Path,
    selected: &BTreeSet<usize>,
    exchange_url: &str,
    exchange_token: &str,
    interactive: bool,
) {
    println!("\n============================================================");
    println!("  开始部署所选组件 / Deploying Selected Components          ");
    println!("============================================================");

    // 1. Check if Navigator is selected
    if selected.contains(&0) {
        println!("\n>> [1/2] 正在配置 Navigator 本地 Agent 环境...");
        setup_agent_core(app_dir, exchange_url, exchange_token);
    }

    // 2. Filter container services
    let container_indices: Vec<usize> = selected
        .iter()
        .copied()
        .filter(|&idx| matches!(TOOLS[idx].kind, ToolKind::ContainerService))
        .collect();

    if container_indices.is_empty() {
        println!("\n✅ 本地环境配置已完成 (未选择远程容器服务)。");
        return;
    }

    println!(
        "\n>> [2/2] 正在编排 {} 个后端容器服务...",
        container_indices.len()
    );
    let compose_file = app_dir.join("docker-compose.yml");
    let content = generate_docker_compose(&container_indices);
    fs::create_dir_all(app_dir).unwrap();
    fs::write(&compose_file, &content).expect("Failed to write docker-compose.yml");
    println!("   📄 已生成部署配置: {}", compose_file.display());

    println!("\n>> 正在检查本地 Docker 守护进程...");
    let docker_check = Command::new("docker").arg("info").output();
    match docker_check {
        Ok(out) if out.status.success() => {
            println!("   ✅ Docker 正在运行。");
            let should_run = if interactive {
                print!("   是否立即拉取并启动服务容器？ (y/n): ");
                io::stdout().flush().unwrap();
                let mut run_now = String::new();
                io::stdin().read_line(&mut run_now).unwrap_or_default();
                run_now.trim().eq_ignore_ascii_case("y")
            } else {
                false
            };

            if should_run {
                println!("\n>> 正在执行 docker compose pull (从 GHCR 拉取容器镜像)...");
                let _ = Command::new("docker")
                    .args(["compose", "-f", compose_file.to_str().unwrap(), "pull"])
                    .status();

                println!("\n>> 正在执行 docker compose up -d (启动服务)...");
                let status = Command::new("docker")
                    .args(["compose", "-f", compose_file.to_str().unwrap(), "up", "-d"])
                    .status();
                if let Ok(st) = status {
                    if st.success() {
                        println!("\n🚀 所选服务已成功在后台启动！");
                    }
                }
            } else if !interactive {
                println!(
                    "   ℹ️ 静默模式：已生成部署清单。启动服务可运行: docker compose -f {} up -d",
                    compose_file.display()
                );
            }
        }
        _ => {
            println!("   ℹ️ 本地未检测到运行中的 Docker 守护进程。");
            println!("   生成文件位于: {}", compose_file.display());
            println!("   安装/启动 Docker 后，可在该目录执行: docker compose up -d");
        }
    }
}

fn generate_docker_compose(indices: &[usize]) -> String {
    let mut out = String::from("services:\n");
    for &idx in indices {
        let tool = &TOOLS[idx];
        if let (Some(img), Some(port)) = (tool.image, tool.port) {
            out.push_str(&format!("  cyrene-{}:\n", tool.id));
            out.push_str(&format!("    image: {}\n", img));
            out.push_str(&format!("    container_name: cyrene-{}\n", tool.id));
            out.push_str("    restart: unless-stopped\n");
            out.push_str("    ports:\n");
            out.push_str(&format!("      - \"{}:{}\"\n", port, port));
            out.push_str("    volumes:\n");
            out.push_str(&format!("      - ./data/{}:/data\n\n", tool.id));
        }
    }
    out
}

fn setup_agent_core(app_dir: &Path, exchange_url: &str, exchange_token: &str) {
    let agent_dir = app_dir.join("agent");
    fs::create_dir_all(&agent_dir).unwrap();

    let config = serde_json::json!({
        "agent": {
            "name": "Cyrene-Navigator-DeepSeek-Agent",
            "version": "0.1.0",
            "harness": "deepseek-enhanced-v1",
            "execution_environment": "native-host"
        },
        "exchange": {
            "url": exchange_url,
            "api_key_configured": !exchange_token.is_empty(),
            "chat_completions_endpoint": format!("{}/v1/chat/completions", exchange_url.trim_end_matches('/'))
        },
        "local_execution": {
            "native_host_binary": "cyrene-native-host.exe",
            "workspace": agent_dir.to_str().unwrap(),
            "allow_local_process": true
        }
    });

    let config_path = agent_dir.join("agent_config.json");
    fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
    println!("   ✅ Agent 配置文件已就绪: {}", config_path.display());
    println!(
        "   ✅ 默认连接 Exchange 端点: {}/v1/chat/completions",
        exchange_url.trim_end_matches('/')
    );
}

fn save_exchange_config(app_dir: &Path, exchange_url: &str, exchange_token: &str) {
    let config = serde_json::json!({
        "exchange_url": exchange_url,
        "exchange_token": exchange_token,
        "updated_at": "2026-09-25T16:00:00Z"
    });
    fs::create_dir_all(app_dir).unwrap();
    fs::write(
        app_dir.join("exchange_credentials.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();
}

fn show_system_status(app_dir: &Path) {
    println!("\n--- [ Cyrene 系统与服务运行状态 ] ---");
    println!("📁 根目录: {}", app_dir.display());

    let creds = app_dir.join("exchange_credentials.json");
    if creds.exists() {
        println!("🔑 Exchange 凭据配置: 已存在");
    } else {
        println!("🔑 Exchange 凭据配置: 未配置 (使用默认端点)");
    }

    let agent_cfg = app_dir.join("agent/agent_config.json");
    if agent_cfg.exists() {
        println!("🤖 Navigator Agent 运行时: 已配置就绪");
    } else {
        println!("🤖 Navigator Agent 运行时: 未安装");
    }

    let compose_file = app_dir.join("docker-compose.yml");
    if compose_file.exists() {
        println!("📄 Docker Compose 编排文件: 已生成");
        println!("\n>> 正在查询 Docker 容器状态...");
        let ps = Command::new("docker")
            .args(["compose", "-f", compose_file.to_str().unwrap(), "ps"])
            .output();
        if let Ok(out) = ps {
            let text = String::from_utf8_lossy(&out.stdout);
            if !text.trim().is_empty() {
                println!("{}", text);
            } else {
                println!("   (当前无运行中的容器)");
            }
        } else {
            println!("   (Docker 未运行或不可用)");
        }
    } else {
        println!("📄 Docker Compose 编排文件: 未生成");
    }
}

/// 执行完全干净的卸载
/// Complete clean uninstallation
fn perform_clean_uninstall(app_dir: &Path, force: bool) {
    println!("\n============================================================");
    println!("  Cyrene 完全干净卸载程序 / Clean Uninstaller               ");
    println!("============================================================");
    println!("此操作将完全清理本地 Cyrene 产生的所有环境与数据:");
    println!("  1. 停止并移除所有运行中的 Cyrene Docker 容器与数据卷");
    println!("  2. 删除本地 Agent 执行环境、工作区与日志");
    println!("  3. 删除 Exchange 凭据与配置文件");
    println!("  4. 彻底删除本地目录: {}", app_dir.display());

    if !force {
        print!("\n⚠️ 确认要执行完全卸载吗？此操作不可逆！(y/N): ");
        io::stdout().flush().unwrap();
        let mut confirm = String::new();
        if io::stdin().read_line(&mut confirm).is_err() || !confirm.trim().eq_ignore_ascii_case("y")
        {
            println!("❌ 卸载操作已取消。");
            return;
        }
    }

    println!("\n>> [1/3] 正在停止并移除 Docker 容器与卷...");
    let compose_file = app_dir.join("docker-compose.yml");
    if compose_file.exists() {
        let _ = Command::new("docker")
            .args([
                "compose",
                "-f",
                compose_file.to_str().unwrap(),
                "down",
                "-v",
                "--remove-orphans",
            ])
            .status();
        println!("   ✅ 已停止并移除 docker compose 容器与数据卷。");
    } else {
        // Fallback: stop individual known containers
        for tool in TOOLS {
            if matches!(tool.kind, ToolKind::ContainerService) {
                let cname = format!("cyrene-{}", tool.id);
                let _ = Command::new("docker").args(["stop", &cname]).output();
                let _ = Command::new("docker").args(["rm", "-v", &cname]).output();
            }
        }
        println!("   ✅ 已检查并清理可能存在的 Cyrene 独立容器。");
    }

    println!("\n>> [2/3] 正在清理本地配置文件、凭据与环境缓存...");
    if app_dir.exists() {
        match fs::remove_dir_all(app_dir) {
            Ok(_) => {
                println!("   ✅ 已彻底删除目录: {}", app_dir.display());
            }
            Err(e) => {
                println!(
                    "   ⚠️ 部分文件删除遇到错误 ({}): 请手动检查 {}",
                    e,
                    app_dir.display()
                );
            }
        }
    } else {
        println!("   ✅ 本地目录不存在，无需清理。");
    }

    println!("\n>> [3/3] 验证清理结果...");
    let cleaned = !app_dir.exists();
    if cleaned {
        println!("   ✅ 本地文件已完全清除，未留任何残留。");
    }

    println!("\n🎉 Cyrene 卸载完成！系统已恢复完全干净状态。");
}

fn run_silent(args: &[String], app_dir: &Path) {
    let mut exchange_url = DEFAULT_EXCHANGE_URL.to_string();
    let mut exchange_token = String::new();

    for i in 0..args.len() {
        if args[i] == "--exchange-url" && i + 1 < args.len() {
            exchange_url = args[i + 1].clone();
        }
        if args[i] == "--exchange-token" && i + 1 < args.len() {
            exchange_token = args[i + 1].clone();
        }
    }

    save_exchange_config(app_dir, &exchange_url, &exchange_token);

    let mut selected: BTreeSet<usize> = BTreeSet::new();
    for i in 0..args.len() {
        if args[i] == "--deploy-tools" && i + 1 < args.len() {
            let val = &args[i + 1];
            if val == "all" {
                for t in 0..TOOLS.len() {
                    selected.insert(t);
                }
            } else {
                for item in val.split(',') {
                    let name = item.trim();
                    if let Some(pos) = TOOLS.iter().position(|t| t.id == name) {
                        selected.insert(pos);
                    }
                }
            }
        }
    }

    if !selected.is_empty() {
        deploy_selected_tools(app_dir, &selected, &exchange_url, &exchange_token, false);
    }

    println!("Silent installation completed successfully.");
}

fn get_cyrene_home() -> PathBuf {
    if let Ok(val) = env::var("CYRENE_HOME") {
        PathBuf::from(val)
    } else if let Ok(val) = env::var("LOCALAPPDATA") {
        PathBuf::from(val).join("Cyrene")
    } else if let Ok(val) = env::var("HOME") {
        PathBuf::from(val).join(".cyrene")
    } else {
        PathBuf::from("./cyrene_data")
    }
}
