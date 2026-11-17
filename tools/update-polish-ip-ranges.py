import argparse
import ipaddress
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


SOURCE_URL = "https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-latest"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = PROJECT_ROOT / "data" / "pl-ip-ranges.json"
ALLOWED_STATUSES = {"allocated", "assigned"}


def download_source(url):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "burnit.chat-ip-range-updater/1"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("ascii")


def polish_networks(source):
    ipv4_networks = []
    ipv6_networks = []
    source_serial = ""

    for line in source.splitlines():
        if not line or line.startswith("#"):
            continue

        fields = line.split("|")
        if len(fields) < 7:
            continue

        registry, country, resource_type, value, amount, date, status = fields[:7]
        if (
            registry != "ripencc"
            or country != "PL"
            or resource_type not in {"ipv4", "ipv6"}
            or status not in ALLOWED_STATUSES
        ):
            continue
        if date > source_serial:
            source_serial = date

        if resource_type == "ipv4":
            start = ipaddress.IPv4Address(value)
            end = ipaddress.IPv4Address(int(start) + int(amount) - 1)
            ipv4_networks.extend(ipaddress.summarize_address_range(start, end))
        else:
            ipv6_networks.append(ipaddress.IPv6Network(f"{value}/{amount}", strict=False))

    ipv4 = [
        [int(network.network_address), int(network.broadcast_address)]
        for network in ipaddress.collapse_addresses(ipv4_networks)
    ]
    ipv6 = [
        str(network)
        for network in ipaddress.collapse_addresses(ipv6_networks)
    ]

    return source_serial, ipv4, ipv6


def main():
    parser = argparse.ArgumentParser(
        description="Generuje lokalny wykaz polskich zakresów IP z danych RIPE NCC."
    )
    parser.add_argument("--source", default=SOURCE_URL)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()

    source = download_source(args.source)
    source_serial, ipv4, ipv6 = polish_networks(source)
    payload = {
        "source": SOURCE_URL,
        "source_serial": source_serial,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ipv4": ipv4,
        "ipv6": ipv6,
    }

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Zapisano {output}: "
        f"{len(ipv4)} zakresów IPv4, {len(ipv6)} prefiksów IPv6."
    )


if __name__ == "__main__":
    main()
