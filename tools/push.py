import argparse
import json
import shlex
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath

project_path = Path(__file__).resolve().parent.parent

ssh_host = "pemoarts@s101.cal.pl"
ssh_user = "pemoarts"
public_remote_path = PurePosixPath(
    "/home/pemoarts/domains/burnit.chat/public_html"
)
node_remote_path = PurePosixPath(
    "/home/pemoarts/domains/burnit.chat/node_app"
)

expected_public_remote_path = PurePosixPath(
    "/home/pemoarts/domains/burnit.chat/public_html"
)
expected_node_remote_path = PurePosixPath(
    "/home/pemoarts/domains/burnit.chat/node_app"
)
expected_node_process_title = (
    "lsnode:/home/pemoarts/domains/burnit.chat/node_app/"
)
node_healthcheck_url = "https://burnit.chat/ws/"
node_websocket_healthcheck_url = "wss://burnit.chat/ws/"
expected_node_health = {
    "service": "burnit.chat-relay",
    "status": "ok",
}


def public_files():
    yield project_path / ".htaccess", PurePosixPath(".htaccess")
    yield project_path / "config.js", PurePosixPath("config.js")
    yield project_path / "index.php", PurePosixPath("index.php")
    yield project_path / "info.php", PurePosixPath("info.php")
    yield project_path / "set-language.php", PurePosixPath("set-language.php")
    yield project_path / "index.html", PurePosixPath("index.html")
    yield project_path / "index.en.html", PurePosixPath("index.en.html")
    yield project_path / "jak-to-dziala.html", PurePosixPath("jak-to-dziala.html")
    yield project_path / "how-it-works.html", PurePosixPath("how-it-works.html")
    yield project_path / "lib" / "locale.php", PurePosixPath("lib/locale.php")
    yield project_path / "data" / "pl-ip-ranges.json", PurePosixPath("data/pl-ip-ranges.json")
    for source in sorted((project_path / "assets").rglob("*")):
        if source.is_file():
            yield source, PurePosixPath("assets") / source.relative_to(
                project_path / "assets"
            ).as_posix()


def node_files():
    yield project_path / "server" / "node-relay.cjs", PurePosixPath("app.cjs")
    yield project_path / "package.json", PurePosixPath("package.json")
    yield project_path / "package-lock.json", PurePosixPath("package-lock.json")


def validate_deployment_targets():
    targets = (public_remote_path, node_remote_path)
    if (
        public_remote_path != expected_public_remote_path
        or node_remote_path != expected_node_remote_path
        or any("drabinka.app" in str(target).lower() for target in targets)
        or any("/domains/burnit.chat/" not in str(target) for target in targets)
        or ssh_user != "pemoarts"
        or ssh_host != f"{ssh_user}@s101.cal.pl"
        or expected_node_process_title
        != f"lsnode:{expected_node_remote_path}/"
        or node_healthcheck_url != "https://burnit.chat/ws/"
        or node_websocket_healthcheck_url != "wss://burnit.chat/ws/"
    ):
        raise RuntimeError(
            "Przerwano: cele wdrożenia nie należą wyłącznie do domeny burnit.chat."
        )

    required_sources = [
        project_path / "index.html",
        project_path / "index.en.html",
        project_path / "jak-to-dziala.html",
        project_path / "how-it-works.html",
        project_path / "index.php",
        project_path / "info.php",
        project_path / "set-language.php",
        project_path / "lib" / "locale.php",
        project_path / "data" / "pl-ip-ranges.json",
        project_path / "server" / "node-relay.cjs",
        project_path / "package.json",
        project_path / "package-lock.json",
        project_path / "tools" / "ws-healthcheck.cjs",
    ]
    missing = [str(path) for path in required_sources if not path.is_file()]
    if missing:
        raise RuntimeError(
            "Przerwano: brakuje wymaganych plików projektu:\n- "
            + "\n- ".join(missing)
        )


def ensure_remote_directory(remote_directory, dry_run, created_directories):
    if remote_directory in created_directories:
        return

    if dry_run:
        print(f"[dry-run] Katalog: {ssh_host}:{remote_directory}")
    else:
        subprocess.run(
            [
                "ssh",
                ssh_host,
                f"mkdir -p -- {shlex.quote(str(remote_directory))}",
            ],
            check=True,
        )
    created_directories.add(remote_directory)


def upload_files(files, remote_root, dry_run, created_directories):
    for source, relative_target in files:
        target = remote_root / relative_target
        ensure_remote_directory(target.parent, dry_run, created_directories)

        if dry_run:
            print(f"[dry-run] Plik: {source} -> {ssh_host}:{target}")
            continue

        print(f"Wysyłanie: {relative_target}...")
        subprocess.run(
            ["scp", str(source), f"{ssh_host}:{target}"],
            check=True,
        )


def running_node_application_processes():
    result = subprocess.run(
        [
            "ssh",
            ssh_host,
            f"ps -u {shlex.quote(ssh_user)} -o pid=,args=",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    processes = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(maxsplit=1)
        if len(fields) != 2:
            continue
        pid_text, title = fields
        if pid_text.isascii() and pid_text.isdigit() and title == expected_node_process_title:
            processes.append(int(pid_text))
    return processes


def signal_node_application_processes(pids, signal):
    if not pids:
        return
    subprocess.run(
        [
            "ssh",
            ssh_host,
            "kill "
            + shlex.quote(f"-{signal}")
            + " -- "
            + " ".join(str(pid) for pid in pids),
        ],
        check=True,
    )


def stop_node_application(dry_run):
    if dry_run:
        print(
            "[dry-run] Procesy Node.js: odczyt i zatrzymanie wyłącznie "
            f"dokładnego procesu {expected_node_process_title}"
        )
        return

    pids = running_node_application_processes()
    if not pids:
        print("Brak działających workerów burnit.chat do zatrzymania.")
        return

    print("Zatrzymywanie workerów burnit.chat: " + ", ".join(map(str, pids)))
    signal_node_application_processes(pids, "TERM")

    deadline = time.monotonic() + 5
    remaining = []
    while time.monotonic() < deadline:
        time.sleep(0.25)
        active = set(running_node_application_processes())
        remaining = [pid for pid in pids if pid in active]
        if not remaining:
            return

    # PID-y są ponownie weryfikowane po dokładnym tytule procesu przed SIGKILL.
    active = set(running_node_application_processes())
    remaining = [pid for pid in remaining if pid in active]
    if remaining:
        print(
            "Wymuszone zatrzymanie workerów burnit.chat: "
            + ", ".join(map(str, remaining))
        )
        signal_node_application_processes(remaining, "KILL")


def restart_node_application(dry_run, created_directories):
    restart_directory = node_remote_path / "tmp"
    restart_file = restart_directory / "restart.txt"
    ensure_remote_directory(restart_directory, dry_run, created_directories)
    if dry_run:
        print(f"[dry-run] Restart Node.js: touch {ssh_host}:{restart_file}")
        return

    print("Restartowanie aplikacji Node.js...")
    subprocess.run(
        [
            "ssh",
            ssh_host,
            f"touch -- {shlex.quote(str(restart_file))}",
        ],
        check=True,
    )


def wait_for_node_application(dry_run):
    if dry_run:
        print(
            "[dry-run] Health check: "
            f"{node_healthcheck_url} -> HTTP 200 {expected_node_health}"
        )
        print(
            "[dry-run] Health check WebSocket: "
            f"{node_websocket_healthcheck_url} -> create -> created -> leave"
        )
        return

    print(f"Sprawdzanie nowej wersji: {node_healthcheck_url}")
    deadline = time.monotonic() + 45
    last_error = "brak odpowiedzi"

    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(
                node_healthcheck_url,
                headers={"User-Agent": "burnit-chat-deploy/1"},
            )
            with urllib.request.urlopen(request, timeout=8) as response:
                body = response.read(1024)
                if response.status != 200:
                    raise RuntimeError(f"HTTP {response.status}")
                payload = json.loads(body.decode("utf-8"))
                if payload != expected_node_health:
                    raise RuntimeError(f"nieoczekiwana odpowiedź: {payload!r}")

            print("Health check nowej wersji: OK")
            break
        except (
            OSError,
            RuntimeError,
            UnicodeDecodeError,
            json.JSONDecodeError,
        ) as error:
            last_error = str(error)
            time.sleep(2)
    else:
        raise RuntimeError(
            "Nowa wersja relaya nie przeszła health checku w ciągu 45 sekund: "
            + last_error
        )

    subprocess.run(
        [
            "node",
            str(project_path / "tools" / "ws-healthcheck.cjs"),
            node_websocket_healthcheck_url,
        ],
        check=True,
        timeout=20,
    )


def deploy(dry_run=False, component="all"):
    validate_deployment_targets()
    mode = "SYMULACJA" if dry_run else "WDROŻENIE"
    print(f"{mode}: projekt burnit.chat ({component})")
    created_directories = set()

    if component in {"all", "public"}:
        upload_files(
            public_files(),
            public_remote_path,
            dry_run,
            created_directories,
        )

    if component in {"all", "node"}:
        upload_files(
            node_files(),
            node_remote_path,
            dry_run,
            created_directories,
        )
        stop_node_application(dry_run)
        restart_node_application(dry_run, created_directories)
        wait_for_node_application(dry_run)

    print("Zakończono.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Wysyła frontend i relay Node.js wyłącznie do domeny burnit.chat."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="wyświetla plan wdrożenia bez uruchamiania ssh ani scp",
    )
    parser.add_argument(
        "--component",
        choices=("all", "public", "node"),
        default="all",
        help="wybiera całość, sam frontend albo samą aplikację Node.js",
    )
    args = parser.parse_args()
    deploy(dry_run=args.dry_run, component=args.component)
