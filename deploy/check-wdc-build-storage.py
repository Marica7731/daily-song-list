#!/usr/bin/env python3
"""Fail-closed storage accounting for one bounded WDC release build."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path


PROJECT_ROOT = Path("/opt/culua/ytb-song-rank")
VOLUME_PARENT = Path("/var/tmp")
PROJECT_MAX_BYTES = 40_000_000_000
HOST_RESERVE_BYTES = 20_000_000_000
TEMP_VOLUME_BYTES = 32_000_000_000
RELEASE_MAX_BYTES = 16_000_000_000
CONTROL_BACKUP_BYTES = 134_217_728
CONTROL_RE = re.compile(r"dsl-wdc-(?P<run>[0-9]+)-(?P<attempt>[0-9]+)")
VOLUME_RE = re.compile(
    r"dsl-wdc-volume-(?P<run>[0-9]+)-(?P<attempt>[0-9]+)"
)
UNIT_RE = re.compile(r"dsl-wdc-build-[0-9]+-[0-9]+\.service")


def _tree_usage_bytes(
    root: Path, *, skip: Path | None = None
) -> tuple[int, int]:
    """Count allocated and logical bytes together without following links."""
    allocated = 0
    logical = 0
    pending = [root]
    seen: set[tuple[int, int]] = set()
    while pending:
        path = pending.pop()
        if skip is not None and path == skip:
            continue
        entry_stat = path.lstat()
        identity = (entry_stat.st_dev, entry_stat.st_ino)
        if identity in seen:
            continue
        seen.add(identity)
        allocated += entry_stat.st_blocks * 512
        logical += entry_stat.st_size
        if stat.S_ISDIR(entry_stat.st_mode) and not stat.S_ISLNK(entry_stat.st_mode):
            with os.scandir(path) as entries:
                pending.extend(Path(entry.path) for entry in entries)
    return allocated, logical


def _allocated_tree_bytes(root: Path, *, skip: Path | None = None) -> int:
    """Count host filesystem blocks without following links or a skipped view."""
    return _tree_usage_bytes(root, skip=skip)[0]


def _logical_tree_bytes(root: Path) -> int:
    """Count inode-deduplicated logical bytes without following symlinks."""
    return _tree_usage_bytes(root)[1]


def _release_logical_bytes(root: Path) -> int:
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise RuntimeError(f"WDC_RELEASE_ROOT_UNSAFE root={root}")
    total = 0
    pending = [root]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                entry_stat = entry.stat(follow_symlinks=False)
                path = Path(entry.path)
                if stat.S_ISLNK(entry_stat.st_mode):
                    raise RuntimeError(f"WDC_RELEASE_SYMLINK_REJECTED path={path}")
                if stat.S_ISDIR(entry_stat.st_mode):
                    pending.append(path)
                elif stat.S_ISREG(entry_stat.st_mode):
                    total += entry_stat.st_size
                else:
                    raise RuntimeError(f"WDC_RELEASE_NON_REGULAR_REJECTED path={path}")
    if total <= 0:
        raise RuntimeError("WDC_RELEASE_EMPTY")
    if total >= RELEASE_MAX_BYTES:
        raise RuntimeError(
            f"WDC_RELEASE_LIMIT_EXCEEDED bytes={total} max={RELEASE_MAX_BYTES}"
        )
    return total


def _validate_paths(
    project_root: Path,
    control_root: Path,
    mount_root: Path,
    image: Path,
    phase: str,
) -> tuple[str, str]:
    if project_root != PROJECT_ROOT or project_root.resolve() != PROJECT_ROOT:
        raise RuntimeError(f"WDC_PROJECT_ROOT_UNSAFE root={project_root}")
    if control_root.parent != project_root / ".build":
        raise RuntimeError(f"WDC_CONTROL_ROOT_UNSAFE root={control_root}")
    match = CONTROL_RE.fullmatch(control_root.name)
    if match is None:
        raise RuntimeError(f"WDC_CONTROL_IDENTITY_INVALID root={control_root}")
    if control_root.resolve() != control_root or control_root.is_symlink():
        raise RuntimeError(f"WDC_CONTROL_REALPATH_UNSAFE root={control_root}")
    volume_control_root = mount_root.parent
    volume_match = VOLUME_RE.fullmatch(volume_control_root.name)
    if volume_match is None or volume_control_root.parent != VOLUME_PARENT:
        raise RuntimeError(
            f"WDC_VOLUME_CONTROL_IDENTITY_INVALID root={volume_control_root}"
        )
    if (
        volume_match.group("run") != match.group("run")
        or volume_match.group("attempt") != match.group("attempt")
    ):
        raise RuntimeError("WDC_VOLUME_CONTROL_OWNER_MISMATCH")
    if mount_root != volume_control_root / "volume" or mount_root.is_symlink():
        raise RuntimeError(f"WDC_VOLUME_ROOT_UNSAFE root={mount_root}")
    if image != volume_control_root / "build-volume.ext4" or image.is_symlink():
        raise RuntimeError(f"WDC_VOLUME_IMAGE_UNSAFE image={image}")
    marker = control_root / ".codex-owned-run"
    expected = f"{match.group('run')}:{match.group('attempt')}"
    if marker.read_text(encoding="ascii").strip() != expected:
        raise RuntimeError("WDC_CONTROL_OWNER_MISMATCH")
    if (
        not VOLUME_PARENT.is_dir()
        or VOLUME_PARENT.is_symlink()
        or VOLUME_PARENT.resolve() != VOLUME_PARENT
    ):
        raise RuntimeError(f"WDC_VOLUME_PARENT_UNSAFE root={VOLUME_PARENT}")
    if project_root.stat().st_dev != VOLUME_PARENT.stat().st_dev:
        raise RuntimeError("WDC_VOLUME_PARENT_FILESYSTEM_MISMATCH")
    if phase == "preflight":
        if volume_control_root.exists() or volume_control_root.is_symlink():
            raise RuntimeError("WDC_PREFLIGHT_VOLUME_CONTROL_ALREADY_EXISTS")
    else:
        if (
            not volume_control_root.is_dir()
            or volume_control_root.is_symlink()
            or volume_control_root.resolve() != volume_control_root
        ):
            raise RuntimeError(
                f"WDC_VOLUME_CONTROL_REALPATH_UNSAFE root={volume_control_root}"
            )
        volume_marker = volume_control_root / ".codex-owned-run"
        if volume_marker.read_text(encoding="ascii").strip() != expected:
            raise RuntimeError("WDC_VOLUME_OWNER_MISMATCH")
    return match.group("run"), match.group("attempt")


def check_once(args: argparse.Namespace) -> dict[str, int | str]:
    project_root = args.project_root
    control_root = args.control_root
    mount_root = args.mount_root
    image = args.image
    _validate_paths(project_root, control_root, mount_root, image, args.phase)
    if (
        args.project_max != PROJECT_MAX_BYTES
        or args.host_reserve != HOST_RESERVE_BYTES
        or args.temp_volume_bytes != TEMP_VOLUME_BYTES
        or args.release_max != RELEASE_MAX_BYTES
        or args.control_backup != CONTROL_BACKUP_BYTES
    ):
        raise RuntimeError("WDC_STORAGE_LIMIT_CONFIGURATION_INVALID")

    project_allocated, project_logical = _tree_usage_bytes(project_root)
    host_free = shutil.disk_usage(project_root).free
    result: dict[str, int | str] = {
        "phase": args.phase,
        "projectAllocatedBytes": project_allocated,
        "projectLogicalBytes": project_logical,
        "projectMaxBytes": PROJECT_MAX_BYTES,
        "hostFreeBytes": host_free,
        "hostReserveBytes": HOST_RESERVE_BYTES,
    }

    if args.phase == "preflight":
        if image.exists() or os.path.ismount(mount_root):
            raise RuntimeError("WDC_PREFLIGHT_VOLUME_ALREADY_EXISTS")
        if (
            project_allocated >= PROJECT_MAX_BYTES
            or project_logical >= PROJECT_MAX_BYTES
        ):
            raise RuntimeError(
                "WDC_PROJECT_LIMIT_EXCEEDED "
                f"allocated={project_allocated} logical={project_logical} "
                f"max={PROJECT_MAX_BYTES}"
            )
        peak_build = project_logical + CONTROL_BACKUP_BYTES
        peak_copy = project_logical + RELEASE_MAX_BYTES + CONTROL_BACKUP_BYTES
        if peak_build >= PROJECT_MAX_BYTES or peak_copy >= PROJECT_MAX_BYTES:
            raise RuntimeError(
                "WDC_PROJECT_LOGICAL_PEAK_LIMIT_EXCEEDED "
                f"build={peak_build} copy={peak_copy} max={PROJECT_MAX_BYTES}"
            )
        if host_free - TEMP_VOLUME_BYTES < HOST_RESERVE_BYTES:
            raise RuntimeError(
                "WDC_HOST_RESERVE_PREFLIGHT_VIOLATION "
                f"free={host_free} temp={TEMP_VOLUME_BYTES} reserve={HOST_RESERVE_BYTES}"
            )
        result.update(projectedBuildBytes=peak_build, projectedCopyBytes=peak_copy)
        return result

    if not image.is_file() or image.stat().st_size != TEMP_VOLUME_BYTES:
        raise RuntimeError("WDC_VOLUME_SIZE_INVALID")
    if not os.path.ismount(mount_root):
        raise RuntimeError("WDC_VOLUME_NOT_MOUNTED")
    volume_usage = shutil.disk_usage(mount_root)
    if volume_usage.total > TEMP_VOLUME_BYTES or volume_usage.total < 31_000_000_000:
        raise RuntimeError(
            f"WDC_VOLUME_CAPACITY_INVALID total={volume_usage.total} max={TEMP_VOLUME_BYTES}"
        )
    if project_allocated >= PROJECT_MAX_BYTES or project_logical >= PROJECT_MAX_BYTES:
        raise RuntimeError(
            "WDC_PROJECT_LIMIT_EXCEEDED "
            f"allocated={project_allocated} logical={project_logical} "
            f"max={PROJECT_MAX_BYTES}"
        )
    if host_free < HOST_RESERVE_BYTES:
        raise RuntimeError(
            f"WDC_HOST_RESERVE_VIOLATION free={host_free} reserve={HOST_RESERVE_BYTES}"
        )
    result.update(
        volumeTotalBytes=volume_usage.total,
        volumeUsedBytes=volume_usage.used,
    )

    if args.release_root is not None:
        release_bytes = _release_logical_bytes(args.release_root)
        result["releaseLogicalBytes"] = release_bytes
        if args.phase == "pre-copy":
            projected = project_logical + release_bytes + CONTROL_BACKUP_BYTES
            if projected >= PROJECT_MAX_BYTES:
                raise RuntimeError(
                    "WDC_COPY_LOGICAL_PEAK_LIMIT_EXCEEDED "
                    f"project={project_logical} release={release_bytes} "
                    f"projected={projected} max={PROJECT_MAX_BYTES}"
                )
            if host_free - release_bytes - CONTROL_BACKUP_BYTES < HOST_RESERVE_BYTES:
                raise RuntimeError(
                    "WDC_HOST_RESERVE_COPY_VIOLATION "
                    f"free={host_free} release={release_bytes} reserve={HOST_RESERVE_BYTES}"
                )
            result["projectedCopyBytes"] = projected
    return result


def _write_failure(path: Path, error: BaseException) -> None:
    payload = json.dumps(
        {"error": f"{type(error).__name__}: {error}", "time": int(time.time())},
        sort_keys=True,
    ) + "\n"
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(descriptor, payload.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def watch(args: argparse.Namespace) -> int:
    if args.phase != "runtime" or not UNIT_RE.fullmatch(args.watch_unit):
        raise RuntimeError("WDC_STORAGE_WATCH_CONFIGURATION_INVALID")
    failure_path = args.control_root / "storage-guard.failed.json"
    while True:
        active = subprocess.run(
            ["systemctl", "is-active", "--quiet", args.watch_unit],
            check=False,
        ).returncode == 0
        if not active:
            return 0
        try:
            result = check_once(args)
            print("WDC_STORAGE_RUNTIME_OK", json.dumps(result, sort_keys=True), flush=True)
        except BaseException as error:
            _write_failure(failure_path, error)
            print(f"WDC_STORAGE_RUNTIME_FAILED {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            subprocess.run(["systemctl", "stop", args.watch_unit], check=False)
            return 75
        time.sleep(args.interval)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--control-root", type=Path, required=True)
    parser.add_argument("--mount-root", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument(
        "--phase",
        choices=("preflight", "runtime", "pre-copy", "post-copy"),
        required=True,
    )
    parser.add_argument("--release-root", type=Path)
    parser.add_argument("--project-max", type=int, required=True)
    parser.add_argument("--host-reserve", type=int, required=True)
    parser.add_argument("--temp-volume-bytes", type=int, required=True)
    parser.add_argument("--release-max", type=int, required=True)
    parser.add_argument("--control-backup", type=int, required=True)
    parser.add_argument("--watch-unit", default="")
    parser.add_argument("--interval", type=int, default=30)
    args = parser.parse_args(argv)
    if not 10 <= args.interval <= 60:
        parser.error("interval must be in [10, 60]")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.watch_unit:
        return watch(args)
    result = check_once(args)
    print(f"WDC_STORAGE_{args.phase.upper().replace('-', '_')}_OK", json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
