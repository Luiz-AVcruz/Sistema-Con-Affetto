use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::webview::{DownloadEvent, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl};
use tauri_plugin_dialog::DialogExt;
use url::Url;

const DEFAULT_PORT: u16 = 3335;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

struct BackendProcess {
    child: Mutex<Option<Child>>,
    export_jobs: Arc<ExportJobs>,
    stopping: AtomicBool,
    exit_started: AtomicBool,
    exit_ready: AtomicBool,
    exit_code: AtomicI32,
}

#[derive(Debug, PartialEq, Eq)]
enum ExitRequest {
    Ready,
    Waiting,
    StartShutdown,
}

struct ExportState {
    shutting_down: bool,
    active: usize,
}

struct ExportJobs {
    state: Mutex<ExportState>,
    idle: Condvar,
}

struct ExportJob {
    jobs: Arc<ExportJobs>,
}

impl ExportJobs {
    fn new() -> Self {
        Self {
            state: Mutex::new(ExportState {
                shutting_down: false,
                active: 0,
            }),
            idle: Condvar::new(),
        }
    }

    fn is_accepting(&self) -> bool {
        self.state
            .lock()
            .map(|state| !state.shutting_down)
            .unwrap_or(false)
    }

    fn try_start(self: &Arc<Self>) -> Option<ExportJob> {
        let mut state = self.state.lock().ok()?;
        if state.shutting_down {
            return None;
        }
        state.active += 1;
        Some(ExportJob { jobs: self.clone() })
    }

    fn begin_shutdown(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.shutting_down = true;
    }

    fn wait_until_idle(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while state.active > 0 {
            state = self
                .idle
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

impl Drop for ExportJob {
    fn drop(&mut self) {
        let mut state = self
            .jobs
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.active = state.active.saturating_sub(1);
        if state.active == 0 {
            self.jobs.idle.notify_all();
        }
    }
}

impl BackendProcess {
    fn begin_exit(&self) -> ExitRequest {
        if self.exit_ready.load(Ordering::SeqCst) {
            return ExitRequest::Ready;
        }
        self.export_jobs.begin_shutdown();
        if self.exit_started.swap(true, Ordering::SeqCst) {
            ExitRequest::Waiting
        } else {
            ExitRequest::StartShutdown
        }
    }

    fn stop(&self) -> Result<(), String> {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let mut child_slot = self
            .child
            .lock()
            .map_err(|_| "Falha ao acessar o processo do caixa.".to_owned())?;
        let Some(child) = child_slot.as_mut() else {
            return Ok(());
        };
        if child
            .try_wait()
            .map_err(|error| format!("Não foi possível verificar o servidor local: {error}"))?
            .is_some()
        {
            return Ok(());
        }

        // SIGTERM deixa o servidor encerrar conexões e fechar o banco SQLite antes de sair.
        let signal_result = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
        if signal_result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!(
                    "Não foi possível encerrar o servidor local: {error}"
                ));
            }
        }

        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            if child
                .try_wait()
                .map_err(|error| format!("Não foi possível aguardar o servidor local: {error}"))?
                .is_some()
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }

        child.kill().map_err(|error| format!("O servidor local não respondeu ao SIGTERM e o encerramento forçado falhou: {error}"))?;
        child.wait().map_err(|error| {
            format!("Não foi possível concluir o encerramento do servidor local: {error}")
        })?;
        Ok(())
    }

    fn monitor(self: Arc<Self>, app: AppHandle) {
        thread::spawn(move || loop {
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            match self.child.lock() {
                Ok(mut guard) => match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            self.exit_code.store(1, Ordering::SeqCst);
                            self.stopping.store(true, Ordering::SeqCst);
                            eprintln!("O servidor local encerrou inesperadamente ({status}).");
                            let _ = app.exit(1);
                            return;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            eprintln!("Falha ao verificar o servidor local: {error}");
                            self.exit_code.store(1, Ordering::SeqCst);
                            self.stopping.store(true, Ordering::SeqCst);
                            let _ = app.exit(1);
                            return;
                        }
                    },
                    None => return,
                },
                Err(_) => {
                    eprintln!("Falha ao acessar o processo do servidor local.");
                    self.exit_code.store(1, Ordering::SeqCst);
                    let _ = app.exit(1);
                    return;
                }
            };
            thread::sleep(Duration::from_millis(250));
        });
    }
}

fn resource_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CAIXA_DESKTOP_RESOURCES") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return Ok(path);
        }
        return Err(format!(
            "Pasta de recursos do Caixa não existe: {}",
            path.display()
        ));
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("Não foi possível localizar o aplicativo: {error}"))?;
    if let Some(parent) = executable.parent() {
        let candidate = parent.join("resources");
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        for candidate in [resource_dir.join("resources"), resource_dir] {
            if candidate.join("server.mjs").is_file() {
                return Ok(candidate);
            }
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    if development.is_dir() {
        return Ok(development);
    }
    Err("Os arquivos do aplicativo estão incompletos. Execute a preparação desktop antes de abrir o caixa.".into())
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CAIXA_DB") {
        return Ok(PathBuf::from(path));
    }
    let app_data = app.path().app_data_dir().map_err(|error| {
        format!("Não foi possível localizar a pasta de dados do caixa: {error}")
    })?;
    fs::create_dir_all(&app_data)
        .map_err(|error| format!("Não foi possível criar a pasta de dados do caixa: {error}"))?;
    Ok(app_data.join("caixa.sqlite"))
}

fn spawn_backend(resources: &Path, db: &Path) -> Result<(Child, u16), String> {
    let node = resources.join("bin/node");
    let server = resources.join("server.mjs");
    let frontend = resources.join("frontend");
    if !node.is_file() || !server.is_file() || !frontend.join("index.html").is_file() {
        return Err("Os recursos do caixa estão incompletos. Execute `npm run prepare:resources -w @caixa/desktop`.".into());
    }
    if let Some(parent) = db.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Não foi possível preparar a pasta do banco: {error}"))?;
    }

    let port = match std::env::var("CAIXA_DESKTOP_PORT") {
        Ok(value) => value
            .parse::<u16>()
            .map_err(|_| "CAIXA_DESKTOP_PORT precisa ser uma porta válida.".to_owned())?,
        Err(_) => DEFAULT_PORT,
    };
    if port < 1024 {
        return Err("A porta do aplicativo precisa ser maior ou igual a 1024.".into());
    }

    let parent_pid = std::process::id() as libc::pid_t;
    let mut command = Command::new(node);
    command
        .arg(server)
        .env("PORT", port.to_string())
        .env("CAIXA_DESKTOP", "1")
        .env("CAIXA_DB", db)
        .env("CAIXA_FRONTEND", frontend)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Se o Tauri for interrompido diretamente pelo sistema, o kernel também sinaliza
    // o Node filho. A checagem do PID fecha a corrida entre fork e instalação do sinal.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent_pid {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "o aplicativo pai encerrou durante a inicialização",
                ));
            }
            Ok(())
        });
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Não foi possível iniciar o servidor do caixa: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Não foi possível ler a inicialização do servidor local.".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Não foi possível ler os erros do servidor local.".to_owned())?;
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u16, String>>();

    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) if line.starts_with("CAIXA_READY ") => {
                    let parsed = serde_json::from_str::<ReadyMarker>(&line[12..])
                        .map(|marker| marker.port)
                        .map_err(|error| {
                            format!("O servidor enviou um marcador inválido: {error}")
                        });
                    let _ = ready_tx.send(parsed);
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = ready_tx.send(Err(format!(
                        "Erro lendo a inicialização do servidor: {error}"
                    )));
                    return;
                }
            }
        }
        let _ = ready_tx.send(Err(
            "O servidor encerrou antes de confirmar que estava pronto.".into(),
        ));
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().flatten() {
            eprintln!("[caixa-local] {line}");
        }
    });

    match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(actual_port)) if actual_port == port && actual_port >= 1024 => {
            Ok((child, actual_port))
        }
        Ok(Ok(_)) => {
            terminate_failed_start(&mut child);
            Err(format!("O servidor confirmou uma porta diferente da porta estável {port}; a janela foi bloqueada para preservar os rascunhos."))
        }
        Ok(Err(error)) => {
            terminate_failed_start(&mut child);
            Err(format!("Não foi possível iniciar o servidor do caixa: {error}. Confirme que a porta {port} está livre."))
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            terminate_failed_start(&mut child);
            Err(format!("O servidor do caixa não respondeu em {} segundos. A porta {port} pode estar ocupada.", STARTUP_TIMEOUT.as_secs()))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            terminate_failed_start(&mut child);
            Err("A inicialização do servidor local foi interrompida.".into())
        }
    }
}

#[derive(serde::Deserialize)]
struct ReadyMarker {
    port: u16,
}

fn terminate_failed_start(child: &mut Child) {
    let _ = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Clone, Copy)]
enum ExportKind {
    Sales,
    Fairs,
    Days,
    Backup,
}

fn export_kind(url: &Url, expected_port: u16) -> Option<ExportKind> {
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(expected_port)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    match url.path() {
        "/api/export/sales.csv" => Some(ExportKind::Sales),
        "/api/export/fairs.csv" => Some(ExportKind::Fairs),
        "/api/export/days.csv" => Some(ExportKind::Days),
        "/api/backup" => Some(ExportKind::Backup),
        _ => None,
    }
}

impl ExportKind {
    fn filename(self) -> &'static str {
        match self {
            Self::Sales => "vendas-feira.csv",
            Self::Fairs => "resumo-feiras.csv",
            Self::Days => "fechamentos-feira.csv",
            Self::Backup => "caixa-feira.sqlite",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Backup => "Salvar backup do caixa",
            _ => "Exportar dados do caixa",
        }
    }

    fn filter(self) -> (&'static str, &'static [&'static str]) {
        if matches!(self, Self::Backup) {
            ("Banco SQLite", &["sqlite"])
        } else {
            ("Planilha CSV", &["csv"])
        }
    }
}

fn request_export(app: AppHandle, url: Url, kind: ExportKind, db: PathBuf, jobs: Arc<ExportJobs>) {
    if !jobs.is_accepting() {
        show_message(
            &app,
            "Caixa encerrando",
            "A exportação não pode começar enquanto o caixa está encerrando.",
        );
        return;
    }
    let (filter_name, extensions) = kind.filter();
    app.dialog()
        .file()
        .set_title(kind.title())
        .set_file_name(kind.filename())
        .add_filter(filter_name, extensions)
        .save_file(move |selected| {
            let Some(selected) = selected else {
                return;
            };
            let Some(job) = jobs.try_start() else {
                show_message(
                    &app,
                    "Caixa encerrando",
                    "A exportação não pode começar enquanto o caixa está encerrando.",
                );
                return;
            };
            let target = match selected.into_path() {
                Ok(path) => path,
                Err(error) => {
                    show_message(
                        &app,
                        "Não foi possível salvar o arquivo",
                        &error.to_string(),
                    );
                    return;
                }
            };
            let app_after_write = app.clone();
            let spawn = thread::Builder::new()
                .name("caixa-export".into())
                .spawn(move || {
                    let _job = job;
                    let result = download_to_path(&url, &target, &db);
                    match result {
                        Ok(()) => show_message(
                            &app_after_write,
                            "Arquivo salvo",
                            &format!("O arquivo foi salvo em {}.", target.display()),
                        ),
                        Err(error) => {
                            show_message(&app_after_write, "Falha ao salvar arquivo", &error)
                        }
                    }
                });
            if let Err(error) = spawn {
                show_message(&app, "Falha ao iniciar exportação", &error.to_string());
            }
        });
}

fn download_to_path(url: &Url, target: &Path, db: &Path) -> Result<(), String> {
    ensure_export_target_is_not_live_database(target, db)?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Não foi possível preparar o download: {error}"))?;
    let response = client
        .get(url.clone())
        .send()
        .map_err(|error| format!("Não foi possível ler os dados para exportação: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "O servidor local respondeu com o status {}.",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("O arquivo exportado não pôde ser lido: {error}"))?;
    let parent = target
        .parent()
        .ok_or_else(|| "O caminho escolhido não tem uma pasta válida.".to_owned())?;
    if target.file_name().is_none() {
        return Err("O caminho escolhido não tem um nome de arquivo.".into());
    }
    let (temporary, mut file) = create_export_temp_file(parent)?;
    let write_result = (|| {
        file.write_all(&bytes)
            .map_err(|error| format!("Não foi possível gravar o arquivo: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Não foi possível concluir a gravação do arquivo: {error}"))?;
        fs::rename(&temporary, target).map_err(|error| {
            format!("Não foi possível colocar o arquivo no caminho escolhido: {error}")
        })?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn create_export_temp_file(parent: &Path) -> Result<(PathBuf, File), String> {
    for _ in 0..128 {
        let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary_name = format!(
            ".caixa-feira-export-{}-{sequence}.partial",
            std::process::id()
        );
        let temporary = parent.join(temporary_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Não foi possível criar o arquivo temporário: {error}"
                ))
            }
        }
    }
    Err("Não foi possível reservar um nome temporário exclusivo para a exportação.".into())
}

fn normalize_path_for_comparison(path: &Path) -> Result<PathBuf, String> {
    match fs::canonicalize(path) {
        Ok(canonical) => Ok(canonical),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let filename = path
                .file_name()
                .ok_or_else(|| "O caminho escolhido não tem um nome de arquivo.".to_owned())?;
            let parent = fs::canonicalize(parent)
                .map_err(|error| format!("Não foi possível resolver a pasta escolhida: {error}"))?;
            Ok(parent.join(filename))
        }
        Err(error) => Err(format!(
            "Não foi possível verificar o caminho escolhido: {error}"
        )),
    }
}

fn append_sqlite_suffix(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let filename = path
        .file_name()
        .ok_or_else(|| "O caminho do banco não tem um nome de arquivo válido.".to_owned())?;
    let mut filename = filename.to_os_string();
    filename.push(suffix);
    Ok(path.with_file_name(filename))
}

fn same_file_identity(left: &Path, right: &Path) -> bool {
    let (Ok(left), Ok(right)) = (fs::metadata(left), fs::metadata(right)) else {
        return false;
    };
    left.dev() == right.dev() && left.ino() == right.ino()
}

fn ensure_export_target_is_not_live_database(target: &Path, db: &Path) -> Result<(), String> {
    let destination = normalize_path_for_comparison(target)?;
    let normalized_db = normalize_path_for_comparison(db)?;
    let mut protected = vec![normalized_db.clone()];

    // SQLite cria os arquivos auxiliares junto ao caminho informado na conexão.
    // Inclui o caminho original e o canônico para cobrir banco aberto por symlink.
    for base in [db, normalized_db.as_path()] {
        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = append_sqlite_suffix(base, suffix)?;
            protected.push(normalize_path_for_comparison(&sidecar)?);
        }
    }

    let aliases_live_file = protected.iter().any(|path| {
        path.as_path() == destination.as_path() || same_file_identity(&destination, path)
    });
    if aliases_live_file {
        return Err("Escolha outro destino: esse caminho aponta para o banco ativo do caixa ou para um arquivo SQLite em uso.".into());
    }
    Ok(())
}

fn show_message(app: &AppHandle, title: &str, message: &str) {
    app.dialog().message(message).title(title).show(|_| {});
}

fn show_startup_error(
    app: &tauri::AppHandle,
    message: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let script = format!(
        "window.__CAIXA_STARTUP_ERROR__ = {};",
        serde_json::to_string(message)?
    );
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("desktop-error.html".into()))
        .title(application_title())
        .inner_size(760.0, 420.0)
        .center()
        .initialization_script(script)
        .build()?;
    Ok(())
}

fn application_title() -> &'static str {
    if std::env::var("CAIXA_NIGHTLY").as_deref() == Ok("1") {
        "Caixa da Feira — Nightly"
    } else {
        "Caixa da Feira"
    }
}

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init());

    builder = builder.setup(|app| {
        let resources = match resource_root(app.handle()) {
            Ok(path) => path,
            Err(message) => { show_startup_error(app.handle(), &message)?; return Ok(()); }
        };
        let db = database_path(app.handle()).map_err(std::io::Error::other)?;
        let (child, port) = match spawn_backend(&resources, &db) {
            Ok(backend) => backend,
            Err(message) => { show_startup_error(app.handle(), &message)?; return Ok(()); }
        };
        let backend = Arc::new(BackendProcess {
            child: Mutex::new(Some(child)), export_jobs: Arc::new(ExportJobs::new()),
            stopping: AtomicBool::new(false), exit_started: AtomicBool::new(false), exit_ready: AtomicBool::new(false), exit_code: AtomicI32::new(0),
        });
        app.manage(backend.clone());

        let url = Url::parse(&format!("http://127.0.0.1:{port}/"))
            .map_err(std::io::Error::other)?;
        let app_handle = app.handle().clone();
        let download_app = app_handle.clone();
        let export_db = db.clone();
        let export_jobs = backend.export_jobs.clone();
        let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
            .title(application_title())
            .inner_size(1180.0, 800.0)
            .maximized(true)
            .min_inner_size(900.0, 620.0)
            .center()
            .window_classname("caixa-da-feira")
            .on_navigation(move |next| next.scheme() == "http" && next.host_str() == Some("127.0.0.1") && next.port() == Some(port))
            .on_download(move |_, event| match event {
                DownloadEvent::Requested { url, .. } => {
                    if let Some(kind) = export_kind(&url, port) {
                        request_export(download_app.clone(), url, kind, export_db.clone(), export_jobs.clone());
                    } else {
                        show_message(&download_app, "Download bloqueado", "O caixa só permite salvar arquivos exportados pelo próprio servidor local.");
                    }
                    false
                }
                DownloadEvent::Finished { .. } => true,
                _ => true,
            })
            .build();

        if let Err(error) = window {
            let _ = backend.stop();
            return Err(std::io::Error::other(format!("Não foi possível abrir a janela do caixa: {error}")).into());
        }
        backend.clone().monitor(app_handle);
        Ok(())
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("falha ao construir o Caixa da Feira");
    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if let Some(state) = app.try_state::<Arc<BackendProcess>>() {
                let backend = state.inner().clone();
                match backend.begin_exit() {
                    ExitRequest::Ready => {}
                    ExitRequest::Waiting => api.prevent_exit(),
                    ExitRequest::StartShutdown => {
                        api.prevent_exit();
                        let app = app.clone();
                        thread::spawn(move || {
                            backend.export_jobs.wait_until_idle();
                            if let Err(error) = backend.stop() {
                                eprintln!("{error}");
                            }
                            backend.exit_ready.store(true, Ordering::SeqCst);
                            let _ = app.exit(backend.exit_code.load(Ordering::SeqCst));
                        });
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..128 {
                let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "caixa-da-feira-test-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("não foi possível criar diretório de teste: {error}"),
                }
            }
            panic!("não foi possível reservar diretório de teste exclusivo");
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn export_destination_protects_database_and_sqlite_sidecars() {
        let directory = TestDirectory::new();
        let db = directory.0.join("caixa.sqlite");
        fs::write(&db, b"database").unwrap();

        assert!(ensure_export_target_is_not_live_database(&db, &db).is_err());
        for suffix in ["-wal", "-shm", "-journal"] {
            let destination = append_sqlite_suffix(&db, suffix).unwrap();
            assert!(
                ensure_export_target_is_not_live_database(&destination, &db).is_err(),
                "{suffix} deveria ser protegido"
            );
        }
        let export = directory.0.join("backup.sqlite");
        assert!(ensure_export_target_is_not_live_database(&export, &db).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn export_destination_protects_symlink_and_hardlink_aliases() {
        let directory = TestDirectory::new();
        let db = directory.0.join("caixa.sqlite");
        fs::write(&db, b"database").unwrap();
        let symlink_alias = directory.0.join("symlink.sqlite");
        std::os::unix::fs::symlink(&db, &symlink_alias).unwrap();
        let hardlink_alias = directory.0.join("hardlink.sqlite");
        fs::hard_link(&db, &hardlink_alias).unwrap();

        assert!(ensure_export_target_is_not_live_database(&symlink_alias, &db).is_err());
        assert!(ensure_export_target_is_not_live_database(&hardlink_alias, &db).is_err());
    }

    #[test]
    fn export_temp_files_are_exclusive_and_distinct_for_parallel_jobs() {
        let directory = TestDirectory::new();
        let (first_path, first) = create_export_temp_file(&directory.0).unwrap();
        let (second_path, second) = create_export_temp_file(&directory.0).unwrap();
        assert_ne!(first_path, second_path);
        assert!(first_path.exists() && second_path.exists());
        drop((first, second));
        fs::remove_file(first_path).unwrap();
        fs::remove_file(second_path).unwrap();
    }

    #[test]
    fn shutdown_rejects_late_exports_and_waits_for_accepted_work() {
        let jobs = Arc::new(ExportJobs::new());
        let accepted = jobs
            .try_start()
            .expect("o trabalho antes do fechamento deve ser aceito");
        let (finished_tx, finished_rx) = mpsc::channel();
        let shutdown_jobs = jobs.clone();
        let shutdown = thread::spawn(move || {
            shutdown_jobs.begin_shutdown();
            shutdown_jobs.wait_until_idle();
            finished_tx.send(()).unwrap();
        });

        let deadline = Instant::now() + Duration::from_secs(1);
        while jobs.is_accepting() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(
            !jobs.is_accepting(),
            "o fechamento deve parar novas admissões"
        );
        assert!(
            jobs.try_start().is_none(),
            "callback tardio não pode criar um job"
        );
        assert!(
            finished_rx.recv_timeout(Duration::from_millis(30)).is_err(),
            "shutdown não pode passar por cima de exportação ativa"
        );

        drop(accepted);
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("shutdown deve continuar após o job terminar");
        shutdown.join().unwrap();
    }

    #[test]
    fn repeated_exit_requests_stay_blocked_until_shutdown_is_ready() {
        let backend = BackendProcess {
            child: Mutex::new(None),
            export_jobs: Arc::new(ExportJobs::new()),
            stopping: AtomicBool::new(false),
            exit_started: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
            exit_code: AtomicI32::new(0),
        };

        assert_eq!(backend.begin_exit(), ExitRequest::StartShutdown);
        assert_eq!(backend.begin_exit(), ExitRequest::Waiting);
        assert!(!backend.export_jobs.is_accepting());

        backend.exit_ready.store(true, Ordering::SeqCst);
        assert_eq!(backend.begin_exit(), ExitRequest::Ready);
    }
}
