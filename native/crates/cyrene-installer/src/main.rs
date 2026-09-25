//! ┌─────────────────────────────────────────────────────────────────────┐
//! │  📄 main.rs                                                          │
//! │  Module: cyrene_installer                                           │
//! │  Role: Navigator Modular MSIX Installer & Service Orchestrator      │
//! │  模块职责：Cyrene Navigator 模块化安装器与服务部署编排器。         │
//! └─────────────────────────────────────────────────────────────────────┘

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

const DEFAULT_EXCHANGE_URL: &str = "https://cyrene-exchange.calmsky-23e48c1c.westus2.azurecontainerapps.io";

struct ServiceTool {
    name: &'static str,
    title: &'static str,
    image: &'static str,
    port: u16,
    desc: &'static str,
}

const TOOLS: &[ServiceTool] = &[
    ServiceTool {
        name: "exchange",
        title: "Cyrene Exchange (API 网关 & 路由分发)",
        image: "ghcr.io/baijin64/cyrene-exchange:latest",
        port: 8000,
        desc: "OpenAI 兼容端点、统一凭据认证与模型提供商连接器",
    },
    ServiceTool {
        name: "reactor",
        title: "Cyrene Reactor (模型推理与部署控制面)",
        image: "ghcr.io/baijin64/cyrene-reactor:latest",
        port: 19300,
        desc: "推理端点协调、模型放置策略与计算引擎连接",
    },
    ServiceTool {
        name: "yield",
        title: "Cyrene Yield (统一模型训练与微调服务)",
        image: "ghcr.io/baijin64/cyrene-yield:latest",
        port: 8092,
        desc: "训练生命周期管理、检查点持久化与插件训练编排",
    },
    ServiceTool {
        name: "catalyst",
        title: "Cyrene Catalyst (数据集准备与血缘服务)",
        image: "ghcr.io/baijin64/cyrene-catalyst:latest",
        port: 8014,
        desc: "数据集导入、指令映射、划分与训练格式发布",
    },
    ServiceTool {
        name: "echo",
        title: "Cyrene Echo (模型评测与质量门禁服务)",
        image: "ghcr.io/baijin64/cyrene-echo:latest",
        port: 8094,
        desc: "评测套件执行、样本比对与 LLM Judge 质量判定",
    },
];

fn main() {
    let args: Vec<String> = env::args().collect();

    println!("============================================================");
    println!("  Cyrene Navigator - Modular Installer & Tool Orchestrator  ");
    println!("  Cyrene 模块化安装器与 Agent 本地环境部署工具             ");
    println!("============================================================\n");

    if args.contains(&"--help".to_string()) || args.contains(&"-h".to_string()) {
        print_usage(&args[0]);
        return;
    }

    if args.contains(&"--silent".to_string()) {
        run_silent(&args);
    } else {
        run_interactive();
    }
}

fn print_usage(prog: &str) {
    println!("Usage / 用法: {} [OPTIONS]", prog);
    println!("\nOptions / 选项:");
    println!("  --silent                以无交互静默模式运行安装");
    println!("  --install-agent         安装/配置本地 DeepSeek Harness Agent 环境");
    println!("  --exchange-url <URL>    设置 Exchange 网关端点 (默认: {})", DEFAULT_EXCHANGE_URL);
    println!("  --exchange-token <KEY>  设置统一访问 API Key 凭据");
    println!("  --deploy-tools <NAMES>  以逗号分隔下载部署的服务: all 或 exchange,reactor,yield,catalyst,echo");
    println!("  --generate-compose <PATH> 生成统一 docker-compose.yml 部署清单");
    println!("  -h, --help              显示帮助信息\n");
}

fn run_interactive() {
    let app_dir = get_cyrene_home();
    println!("📍 Cyrene 配置文件与环境存储路径: {}", app_dir.display());

    let mut exchange_url = DEFAULT_EXCHANGE_URL.to_string();
    let mut exchange_token = String::new();
    let mut selected_tools: BTreeSet<usize> = BTreeSet::new();

    loop {
        println!("\n--- [ 安装器功能导航 / Installer Menu ] ---");
        println!("1. [核心功能] 配置并安装 Agent 本地执行环境 (DeepSeek Harness + Native Host)");
        println!("2. [网关配置] 配置 Exchange 端点与统一认证凭据 (当前: {})", exchange_url);
        println!("3. [按需选装] 远程下载部署其他五个核心工具 (Exchange, Reactor, Yield, Catalyst, Echo)");
        println!("4. [一键部署] 生成 docker-compose.yml 并拉取选定服务镜像");
        println!("5. [完成退出] 保存配置并退出安装器");
        print!("\n请选择操作 [1-5]: ");
        io::stdout().flush().unwrap();

        let mut input = String::new();
        if io::stdin().read_line(&mut input).is_err() {
            break;
        }
        let choice = input.trim();

        match choice {
            "1" => {
                println!("\n>> 正在配置 Agent 本地执行环境...");
                setup_agent_core(&app_dir, &exchange_url, &exchange_token);
            }
            "2" => {
                println!("\n>> 配置 Exchange 端点:");
                println!("   默认端点: {}", DEFAULT_EXCHANGE_URL);
                print!("   请输入 Exchange URL (回车保持默认): ");
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

                save_exchange_config(&app_dir, &exchange_url, &exchange_token);
                println!("   ✅ Exchange 端点已保存为: {}", exchange_url);
            }
            "3" => {
                menu_select_tools(&mut selected_tools);
            }
            "4" => {
                if selected_tools.is_empty() {
                    println!("\n⚠️ 尚未勾选任何需要部署的后端工具，是否部署全部 5 个工具？(y/n): ");
                    let mut confirm = String::new();
                    io::stdin().read_line(&mut confirm).unwrap();
                    if confirm.trim().eq_ignore_ascii_case("y") {
                        for i in 0..TOOLS.len() {
                            selected_tools.insert(i);
                        }
                    } else {
                        continue;
                    }
                }
                deploy_selected_tools(&app_dir, &selected_tools);
            }
            "5" => {
                println!("\n🎉 安装与配置完成！感谢使用 Cyrene Navigator。");
                break;
            }
            _ => {
                println!("无效选项，请输入 1 到 5。");
            }
        }
    }
}

fn menu_select_tools(selected: &mut BTreeSet<usize>) {
    loop {
        println!("\n--- [ 可选部署的五个后端工具列表 ] ---");
        for (idx, tool) in TOOLS.iter().enumerate() {
            let status = if selected.contains(&idx) { "[x] 已勾选" } else { "[ ] 未勾选" };
            println!("  {}. {} {} (默认端口: {})", idx + 1, status, tool.title, tool.port);
            println!("     镜像: {}", tool.image);
            println!("     说明: {}", tool.desc);
        }
        println!("  A. 全选全部 5 个工具");
        println!("  C. 清空所选");
        println!("  B. 返回主菜单");

        print!("\n请输入工具序号切换勾选状态，或输入 A/C/B: ");
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
            println!("✅ 已全选 5 个工具。");
        } else if cmd.eq_ignore_ascii_case("c") {
            selected.clear();
            println!("✅ 已清空选中的工具。");
        } else if let Ok(num) = cmd.parse::<usize>() {
            if num >= 1 && num <= TOOLS.len() {
                let tool_idx = num - 1;
                if selected.contains(&tool_idx) {
                    selected.remove(&tool_idx);
                    println!("➖ 取消勾选: {}", TOOLS[tool_idx].name);
                } else {
                    selected.insert(tool_idx);
                    println!("➕ 已勾选: {}", TOOLS[tool_idx].name);
                }
            } else {
                println!("请输入 1 到 {} 之间的数字", TOOLS.len());
            }
        }
    }
}

fn deploy_selected_tools(app_dir: &Path, selected: &BTreeSet<usize>) {
    let compose_file = app_dir.join("docker-compose.yml");
    let content = generate_docker_compose(selected);
    fs::write(&compose_file, &content).expect("Failed to write docker-compose.yml");
    println!("\n📄 已在以下位置生成 docker-compose.yml:\n   {}", compose_file.display());

    println!("\n>> 正在检查本地 Docker 环境...");
    let docker_check = Command::new("docker").arg("info").output();
    match docker_check {
        Ok(out) if out.status.success() => {
            println!("✅ 检测到本地 Docker 正在运行。");
            print!("是否立即拉取镜像并启动这些服务？ (y/n): ");
            io::stdout().flush().unwrap();
            let mut run_now = String::new();
            io::stdin().read_line(&mut run_now).unwrap();
            if run_now.trim().eq_ignore_ascii_case("y") {
                println!("\n>> 正在执行 docker compose pull...");
                let _ = Command::new("docker")
                    .args(["compose", "-f", compose_file.to_str().unwrap(), "pull"])
                    .status();

                println!("\n>> 正在执行 docker compose up -d...");
                let status = Command::new("docker")
                    .args(["compose", "-f", compose_file.to_str().unwrap(), "up", "-d"])
                    .status();
                if let Ok(st) = status {
                    if st.success() {
                        println!("\n🚀 所选服务已成功在后台启动！");
                    }
                }
            }
        }
        _ => {
            println!("ℹ️ 本地未运行 Docker 守护进程。");
            println!("   您可以随时进入 {} 运行:", app_dir.display());
            println!("   docker compose up -d");
        }
    }
}

fn generate_docker_compose(selected: &BTreeSet<usize>) -> String {
    let mut out = String::from("version: '3.8'\n\nservices:\n");
    for &idx in selected {
        let tool = &TOOLS[idx];
        out.push_str(&format!("  cyrene-{}:\n", tool.name));
        out.push_str(&format!("    image: {}\n", tool.image));
        out.push_str(&format!("    container_name: cyrene-{}\n", tool.name));
        out.push_str("    restart: unless-stopped\n");
        out.push_str("    ports:\n");
        out.push_str(&format!("      - \"{}:{}\"\n", tool.port, tool.port));
        out.push_str("    volumes:\n");
        out.push_str(&format!("      - ./data/{}:/data\n\n", tool.name));
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
    println!("   ✅ 默认连接 Exchange 端点: {}/v1/chat/completions", exchange_url.trim_end_matches('/'));
}

fn save_exchange_config(app_dir: &Path, exchange_url: &str, exchange_token: &str) {
    let config = serde_json::json!({
        "exchange_url": exchange_url,
        "exchange_token": exchange_token,
        "updated_at": "2026-09-25T15:50:00Z"
    });
    fs::create_dir_all(app_dir).unwrap();
    fs::write(app_dir.join("exchange_credentials.json"), serde_json::to_string_pretty(&config).unwrap()).unwrap();
}

fn run_silent(args: &[String]) {
    let app_dir = get_cyrene_home();
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

    if args.contains(&"--install-agent".to_string()) {
        setup_agent_core(&app_dir, &exchange_url, &exchange_token);
    }

    save_exchange_config(&app_dir, &exchange_url, &exchange_token);

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
                    if let Some(pos) = TOOLS.iter().position(|t| t.name == name) {
                        selected.insert(pos);
                    }
                }
            }
        }
    }

    if !selected.is_empty() {
        deploy_selected_tools(&app_dir, &selected);
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
