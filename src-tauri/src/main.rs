#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Backend olarak calisan Node surecinin tutamaci. Uygulama kapanirken
/// bu surec acikta kalirsa izleme arka planda sessizce devam eder.
#[derive(Default)]
struct Backend(Mutex<Option<Child>>);

const DEFAULT_PORT: u16 = 7331;
const BACKEND_TIMEOUT: Duration = Duration::from_secs(40);

/// Tercihen 7331; mesgulse isletim sisteminin verdigi bos port.
fn pick_port() -> u16 {
    if TcpListener::bind(("127.0.0.1", DEFAULT_PORT)).is_ok() {
        return DEFAULT_PORT;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(DEFAULT_PORT)
}

fn first_existing(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.exists())
}

/// Tauri'nin yol API'si Windows'ta `\\?\C:\...` (extended-length) uretir.
/// Rust ve Win32 bunu kabul eder, Node'un modul cozucusu etmez: `C:` bolumunu
/// dizin sanip EISDIR ile cikar. Node'a verilen her yol sade forma indirilir.
fn plain_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

/// Node calistiricisi: once paketle gelen sidecar, sonra gelistirme
/// dizini, en son PATH uzerindeki node.
fn resolve_node(app: &AppHandle) -> Option<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from));
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    let mut candidates = Vec::new();
    if let Some(dir) = &exe_dir {
        candidates.push(dir.join("recai-node.exe"));
        candidates.push(dir.join("recai-node-x86_64-pc-windows-msvc.exe"));
    }
    candidates.push(manifest_dir.join("binaries/recai-node-x86_64-pc-windows-msvc.exe"));
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("recai-node.exe"));
    }

    first_existing(candidates)
        .map(plain_path)
        .or_else(|| Some(PathBuf::from("node.exe")))
}

/// server.js'in bulundugu kok dizin: kurulumda resources/app, gelistirmede proje koku.
fn resolve_app_root(app: &AppHandle) -> Option<PathBuf> {
    let manifest_parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from);

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("app"));
    }
    if let Some(parent) = manifest_parent {
        candidates.push(parent);
    }

    candidates
        .into_iter()
        .find(|path| path.join("src").join("server.js").exists())
        .map(plain_path)
}

/// Yazilabilir veri dizini. Program Files altina kurulunca proje klasoru
/// yazilabilir degildir; kayitlar her zaman kullanici profiline gider.
fn resolve_data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| plain_path(dir.join("data")))
}

/// Kabuk gunlugu. Backend hicbir zaman sessizce dusmemeli; her adim
/// data dizinindeki shell.log dosyasina yazilir.
fn log_line(data_dir: &PathBuf, message: &str) {
    use std::io::Write;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("shell.log"))
    {
        let _ = writeln!(file, "[{stamp}] {message}");
    }
}

/// Backend'i "kill on job close" isaretli bir Windows Job Object'e baglar.
/// Kabuk duzgun kapanirsa `RunEvent::Exit` zaten oldurur; kabuk cokerse ya da
/// Gorev Yoneticisi'nden zorla kapatilirsa cekirdek isi devralir. Boylece
/// RECAI, yakalamak icin var oldugu oksuz surecin kendisini uretmez.
#[cfg(windows)]
fn bind_to_job(child: &Child) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JobObjectExtendedLimitInformation,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("Job Object olusturulamadi.".into());
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            return Err("Job Object sinirlari ayarlanamadi.".into());
        }

        if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
            return Err("Backend Job Object'e baglanamadi.".into());
        }
        // `job` bilerek kapatilmaz: tutamac kabuk sureciyle birlikte yasar ve
        // surec oldugunde cekirdek isi kapatip backend'i sonlandirir.
    }
    Ok(())
}

fn spawn_backend(app: &AppHandle, port: u16) -> Result<(Child, PathBuf), String> {
    let data_dir = resolve_data_dir(app).ok_or("Veri dizini belirlenemedi.")?;
    std::fs::create_dir_all(&data_dir).map_err(|error| format!("Veri dizini olusturulamadi: {error}"))?;

    let node = resolve_node(app).ok_or("Node calistiricisi bulunamadi.")?;
    let root = resolve_app_root(app).ok_or("server.js bulunamadi.")?;
    let script = root.join("src").join("server.js");
    log_line(&data_dir, &format!("node={}", node.display()));
    log_line(&data_dir, &format!("script={}", script.display()));
    log_line(&data_dir, &format!("port={port}"));

    // Backend ciktisi diske akar; teshis edilemeyen cokme birakmaz.
    let log_path = data_dir.join("backend.log");
    let stdout = std::fs::File::create(&log_path)
        .map_err(|error| format!("Backend gunlugu acilamadi: {error}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("Backend gunlugu kopyalanamadi: {error}"))?;

    let mut command = Command::new(&node);
    command
        .arg(&script)
        .current_dir(&root)
        .env("RECAI_PORT", port.to_string())
        .env("RECAI_DATA_DIR", &data_dir)
        .env("RECAI_OPEN_BROWSER", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    match command.spawn() {
        Ok(child) => {
            log_line(&data_dir, &format!("spawn ok pid={}", child.id()));
            #[cfg(windows)]
            match bind_to_job(&child) {
                Ok(()) => log_line(&data_dir, "job object bagli"),
                // Baglanamamak olumcul degil: normal cikista temizlik yine calisir.
                Err(error) => log_line(&data_dir, &format!("job object UYARI: {error}")),
            }
            Ok((child, data_dir))
        }
        Err(error) => {
            log_line(&data_dir, &format!("spawn FAILED: {error}"));
            Err(format!("Backend baslatilamadi: {error}"))
        }
    }
}

/// Port dinlemeye baslayana kadar bekler. Backend cokerse erken cikar.
fn wait_for_backend(port: u16, child: &mut Child) -> Result<(), String> {
    let deadline = Instant::now() + BACKEND_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("Backend beklenmedik sekilde kapandi (kod {status})."));
        }
        if TcpStream::connect_timeout(
            &([127, 0, 0, 1], port).into(),
            Duration::from_millis(400),
        )
        .is_ok()
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("Backend zaman asimina ugradi.".into())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Pencereyi Göster", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Tepsiye Gizle", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Çıkış", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;

    TrayIconBuilder::with_id("recai-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("CCA-RECAI - nöbetteyim")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .manage(Backend::default())
        .setup(|app| {
            let handle = app.handle().clone();

            // Tasarimin kendi baslik cubugu var (logo, menu, dil seridi, pencere
            // dugmeleri). Yerli cerceve acik kalirsa iki baslik cubugu ust uste
            // biner; bu yuzden dekorasyon kapatilir.
            let window = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                .title("CCA-RECAI")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1000.0, 680.0)
                .decorations(false)
                .center()
                .visible(true)
                .build()?;

            build_tray(&handle)?;

            // Pencere kapatma tuşu uygulamayı sonlandırmaz; izleme tepside sürer.
            let close_handle = handle.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(window) = close_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            });

            let port = pick_port();
            std::thread::spawn(move || {
                let (mut child, data_dir) = match spawn_backend(&handle, port) {
                    Ok(started) => started,
                    Err(error) => {
                        report_failure(&handle, &error);
                        return;
                    }
                };

                if let Err(error) = wait_for_backend(port, &mut child) {
                    log_line(&data_dir, &format!("hazir olmadi: {error}"));
                    let _ = child.kill();
                    report_failure(&handle, &error);
                    return;
                }
                log_line(&data_dir, "backend hazir");

                if let Some(state) = handle.try_state::<Backend>() {
                    *state.0.lock().unwrap() = Some(child);
                }
                if let Some(window) = handle.get_webview_window("main") {
                    let url = format!("http://127.0.0.1:{port}");
                    if let Ok(parsed) = url.parse() {
                        let _ = window.navigate(parsed);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("CCA-RECAI baslatilamadi")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Backend>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        });
}

/// Hata durumunda splash ekranina mesaj basar; sessiz basarisizlik birakmaz.
fn report_failure(app: &AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let escaped = message.replace('\\', "\\\\").replace('\'', "\\'");
        let _ = window.eval(format!("window.recaiFailed && window.recaiFailed('{escaped}')"));
    }
}
