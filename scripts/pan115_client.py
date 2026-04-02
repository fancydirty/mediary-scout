import hashlib
import os
import re
import time
from types import MappingProxyType
from typing import Any, Callable, Dict, List, Optional

from p115client import P115Client
from pansou_client import BoundTransferUrl, TransferPlan


class FileCollection:
    def __init__(self, items: List[Dict[str, Any]], collection_name: str = "files"):
        self._items = items
        self._name = collection_name

    def __iter__(self):
        raise ValueError(
            f"FORBIDDEN: Direct iteration is not allowed. Use {self._name}.each(callback) instead."
        )

    def __len__(self):
        return len(self._items)

    def __getitem__(self, key):
        if isinstance(key, slice):
            raise ValueError("FORBIDDEN: Slicing is not allowed. Process all items.")
        return self._items[key]

    def each(self, callback: Callable[[int, Dict[str, Any]], None]):
        processed = 0
        for index, item in enumerate(self._items):
            callback(index, item)
            processed += 1

        if processed != len(self._items):
            raise RuntimeError(
                f"Failed to process all items: {processed}/{len(self._items)}"
            )


class FileSnapshot:
    def __init__(self, items: List[Dict[str, Any]], snapshot_name: str = "snapshot"):
        self._items = tuple(MappingProxyType(dict(item)) for item in items)
        self._name = snapshot_name
        self._consumed = False
        self.snapshot_id = self._compute_snapshot_id(items)

    @property
    def items(self):
        return self._items

    @staticmethod
    def _compute_snapshot_id(items: List[Dict[str, Any]]) -> str:
        fids = []
        for item in items:
            fid = item.get("fid")
            if fid:
                fids.append(str(fid))
        fids.sort()
        return hashlib.sha1("|".join(fids).encode("utf-8")).hexdigest()[:12]

    def __iter__(self):
        raise ValueError(
            f"FORBIDDEN: Direct iteration is not allowed. Use {self._name}.each(callback) instead."
        )

    def __len__(self):
        return len(self._items)

    def __getitem__(self, key):
        if isinstance(key, slice):
            raise ValueError("FORBIDDEN: Slicing is not allowed. Process all items.")
        return dict(self._items[key])

    def each(self, callback: Callable[[int, Dict[str, Any]], None]):
        processed = 0
        for index, item in enumerate(self._items):
            callback(index, dict(item))
            processed += 1

        if processed != len(self._items):
            raise RuntimeError(
                f"Failed to process all items: {processed}/{len(self._items)}"
            )

    def is_consumed(self) -> bool:
        return self._consumed

    def mark_consumed(self) -> None:
        self._consumed = True


class Pan115Client:
    def __init__(self, cookie: Optional[str] = None):
        cookie = (
            cookie or os.environ.get("PAN115_COOKIE") or os.environ.get("P115_COOKIE")
        )
        if not cookie:
            raise ValueError(
                "PAN115_COOKIE must be set in environment variables or passed to the constructor."
            )

        self.cookie_str = cookie
        self.client: Any = P115Client(cookies=cookie, check_for_relogin=True)

        headers = getattr(self.client, "headers", None)
        if isinstance(headers, dict):
            headers["referer"] = "https://115.com/"
            headers["origin"] = "https://115.com"

        self._last_api_call = 0
        self._min_interval = 1.0

    @staticmethod
    def _normalize_item(item: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize raw p115client API shorthand fields to friendly names.

        Mapping:
            n   → name
            s   → size
            cid → dir_id
        The raw keys are preserved for backward compatibility.
        """
        result = dict(item)
        if "n" in result:
            result["name"] = result["n"]
        if "s" in result:
            result["size"] = result["s"]
        if "cid" in result:
            result["dir_id"] = result["cid"]
        return result

    @staticmethod
    def _normalize_children(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Recursively normalize a tree of raw API items."""
        out: List[Dict[str, Any]] = []
        for item in items:
            n = Pan115Client._normalize_item(item)
            children = n.pop("children", [])
            if children:
                n["children"] = Pan115Client._normalize_children(children)
            out.append(n)
        return out

    @staticmethod
    def _normalize_cid(cid: Any) -> str:
        if not isinstance(cid, (str, int)):
            raise ValueError(f"dir_id must be a cid-like string or int, got {cid}")
        normalized = str(cid).strip()
        if not normalized:
            raise ValueError("dir_id must not be empty")
        return normalized

    def _get_protected_cids(self) -> set[str]:
        protected = {"0"}
        for key in (
            "CLAWD_MEDIA_ROOT_CID",
            "MOVIES_CID",
            "TV_SHOWS_CID",
            "ANIME_CID",
        ):
            value = os.environ.get(key, "").strip()
            if value:
                protected.add(value)
        return protected

    def _assert_safe_flatten_target(self, dir_id: str) -> str:
        normalized = self._normalize_cid(dir_id)
        if normalized in self._get_protected_cids():
            raise ValueError(
                f"SAFETY_VIOLATION: refusing to flatten protected directory cid={normalized}"
            )

        info = self.get_file_info(normalized)
        if not info or not info.get("state"):
            raise ValueError(
                f"SAFETY_VIOLATION: unable to verify flatten target cid={normalized}"
            )

        path = info.get("path", []) if isinstance(info, dict) else []
        path_names = [str(part.get("name", "")).strip() for part in path if part.get("name")]
        path_ids = [
            str(part.get("cid", "")).strip()
            for part in path
            if isinstance(part, dict) and str(part.get("cid", "")).strip()
        ]
        joined_path = "/".join(path_names) if path_names else "(unknown)"

        if len(path_names) < 3:
            raise ValueError(
                "SAFETY_VIOLATION: flatten target must be a movie leaf or season leaf directory; "
                f"path={joined_path}"
            )

        leaf_name = path_names[-1]
        if not re.fullmatch(r"Season\s+\d+", leaf_name, re.IGNORECASE):
            movies_cid = os.environ.get("MOVIES_CID", "").strip()
            parent_id = path_ids[-2] if len(path_ids) >= 2 else ""
            parent_name = path_names[-2] if len(path_names) >= 2 else ""
            is_movie_leaf = bool(movies_cid and parent_id == movies_cid)
            is_movie_name_fallback = parent_name == "Movies" and len(path_names) >= 4
            if not (is_movie_leaf or is_movie_name_fallback):
                raise ValueError(
                    "SAFETY_VIOLATION: flatten target must be a movie leaf under MOVIES_CID "
                    "or end with 'Season <number>'; "
                    f"path={joined_path}"
                )

        return normalized

    def _api_call(self, func, *args, **kwargs):
        elapsed = time.time() - self._last_api_call
        if elapsed < self._min_interval:
            time.sleep(self._min_interval - elapsed)
        self._last_api_call = time.time()
        return func(*args, **kwargs)

    def _get_all_items(self, cid: str) -> List[Dict[str, Any]]:
        result = self._api_call(self.client.fs_files, {"cid": cid, "offset": 0, "limit": 32})
        data = result if isinstance(result, dict) else {}
        if not data or not data.get("state"):
            return []
        return data.get("data", [])

    def list_files(
        self, cid: str = "0", limit: int = 1000, depth: int = 1
    ) -> FileCollection:
        cid = self._normalize_cid(cid)
        if depth < 1:
            raise ValueError("depth must be >= 1")
        if cid in self._get_protected_cids() and depth > 1:
            raise ValueError(
                "SAFETY_VIOLATION: refusing recursive list_files scan on protected directory "
                f"cid={cid}; use depth=1"
            )

        def collect(current_id: str, current_depth: int) -> List[Dict[str, Any]]:
            if current_depth > depth:
                return []

            result = self._api_call(
                self.client.fs_files,
                {"cid": current_id, "offset": 0, "limit": min(limit, 32)},
            )
            data = result if isinstance(result, dict) else {}
            if not data or not data.get("state"):
                return []

            result_items: List[Dict[str, Any]] = []
            for item in data.get("data", []):
                fc = item.get("fc", "")
                is_dir = fc == "0" or fc == 0
                normalized = self._normalize_item(item)
                if is_dir:
                    normalized["children"] = collect(normalized.get("dir_id", ""), current_depth + 1)
                result_items.append(normalized)
            return result_items

        files = collect(cid, 1)
        return FileCollection(files, "files")

    def list_video_files(
        self, cid: str = "0", limit: int = 1000, depth: int = 3, min_size_gb: float = 0
    ) -> FileCollection:
        video_exts = (
            ".mp4",
            ".mkv",
            ".avi",
            ".mov",
            ".wmv",
            ".flv",
            ".webm",
            ".m4v",
            ".mpg",
            ".mpeg",
            ".ts",
            ".m2ts",
        )
        min_bytes = min_size_gb * 1024 * 1024 * 1024 if min_size_gb > 0 else 0

        def collect_videos(current_id: str, current_depth: int) -> List[Dict[str, Any]]:
            if current_depth > depth:
                return []

            result = self._api_call(
                self.client.fs_files,
                {"cid": current_id, "offset": 0, "limit": min(limit, 32)},
            )
            data = result if isinstance(result, dict) else {}
            if not data or not data.get("state"):
                return []

            videos: List[Dict[str, Any]] = []
            for item in data.get("data", []):
                fc = item.get("fc", "")
                is_dir = fc == "0" or fc == 0
                if is_dir:
                    normalized_dir = self._normalize_item(item)
                    videos.extend(collect_videos(normalized_dir.get("dir_id", ""), current_depth + 1))
                    continue

                name = item.get("n", "").lower()
                if not any(name.endswith(ext) for ext in video_exts):
                    continue

                try:
                    size_bytes = int(item.get("s", 0))
                except (TypeError, ValueError):
                    size_bytes = 0
                if size_bytes < min_bytes:
                    continue

                videos.append(self._normalize_item(item))
            return videos

        videos = collect_videos(cid, 1)
        return FileCollection(videos, "video_files")

    def list_video_files_snapshot(
        self, cid: str = "0", limit: int = 1000, depth: int = 3, min_size_gb: float = 0
    ) -> FileSnapshot:
        files = self.list_video_files(
            cid=cid, limit=limit, depth=depth, min_size_gb=min_size_gb
        )
        items = [files[index] for index in range(len(files))]
        return FileSnapshot(items, "video_snapshot")

    def get_file_info(self, cid: str) -> Dict[str, Any]:
        result = self.client.fs_files(cid)
        return result if result and result.get("state") else {}

    def get_path(self, cid: str = "0") -> str:
        result = self.client.fs_files(cid)
        path = result.get("path", []) if isinstance(result, dict) else []
        if path:
            return "/".join(part.get("name", "?") for part in path)
        return "root"

    def preview_snapshot_deletions(
        self, *, indices: List[int], snapshot: FileSnapshot
    ) -> Dict[str, Any]:
        if not isinstance(snapshot, FileSnapshot):
            return {
                "ok": False,
                "code": "INVALID_INPUT",
                "error": "snapshot must be a FileSnapshot",
                "to_delete": [],
                "to_keep": [],
            }

        if not isinstance(indices, list) or any(not isinstance(i, int) for i in indices):
            return {
                "ok": False,
                "code": "INVALID_INPUT",
                "error": "indices must be a list[int]",
                "to_delete": [],
                "to_keep": [],
            }

        unique_indices = set(indices)
        to_delete: List[Dict[str, Any]] = []
        to_keep: List[Dict[str, Any]] = []

        for index, file_info in enumerate(snapshot.items):
            name = file_info.get("name", "unknown")
            fid = file_info.get("file_id") or file_info.get("fid")
            try:
                size_bytes = int(file_info.get("size", 0))
            except (TypeError, ValueError):
                size_bytes = 0

            file_data = {
                "index": index,
                "fid": fid,
                "name": name,
                "size_gb": round(size_bytes / (1024**3), 2),
            }
            if index in unique_indices:
                to_delete.append(file_data)
            else:
                to_keep.append(file_data)

        return {"ok": True, "code": "OK", "to_delete": to_delete, "to_keep": to_keep}

    def create_folder(self, *, name: str, parent_id: str = "0") -> str:
        if not isinstance(name, str):
            raise TypeError(f"name must be a string, got {type(name).__name__}")
        if not isinstance(parent_id, (str, int)):
            raise TypeError(
                f"parent_id must be a string or int, got {type(parent_id).__name__}"
            )

        if name.isdigit() and len(name) >= 16:
            raise ValueError(
                f"create_folder arguments may be swapped: name='{name}' looks like a cid."
            )

        parent_id_str = str(parent_id)
        if not parent_id_str.isdigit():
            raise ValueError(f"parent_id must be a numeric cid, got {parent_id}")

        result = self.client.fs_mkdir(name, parent_id_str)
        return result.get("cid", "")

    def transfer_115(self, *, url: str, save_dir_id: str) -> tuple[bool, str]:
        if not isinstance(url, str) or not url.startswith(
            ("https://115cdn.com/s/", "https://115.com/s/")
        ):
            raise ValueError(f"url must be a 115 share link, got {url}")
        if not isinstance(save_dir_id, (str, int)) or not str(save_dir_id).isdigit():
            raise ValueError(f"save_dir_id must be a numeric cid, got {save_dir_id}")

        match = re.search(r"/s/([\w]+)(?:\?password=([\w]+))?", url)
        if not match:
            return (False, "invalid share link")

        payload = {
            "share_code": match.group(1),
            "receive_code": match.group(2) or "",
            "cid": str(save_dir_id),
        }
        result = self.client.share_receive_app(payload)
        if result and not result.get("state", True):
            error = result.get("error", "") or result.get("error_msg", "")
            errno = result.get("errno", 0)
            if errno == 4100001 or "password" in error.lower() or "密码" in error:
                return (False, "密码错误")
            if errno == 4100024 or "已经" in error:
                return (False, "资源已转存过(可能在其他目录)，目标目录未新增文件")
            if "expire" in error.lower() or "失效" in error:
                return (False, "资源失效")
            return (False, error or "转存失败")
        return (True, "")

    def transfer_magnet(self, *, url: str, save_dir_id: str) -> tuple[bool, str]:
        if not isinstance(url, str) or not url.startswith("magnet:?xt=urn:btih:"):
            raise ValueError(f"url must be a magnet link, got {url}")
        if not isinstance(save_dir_id, (str, int)) or not str(save_dir_id).isdigit():
            raise ValueError(f"save_dir_id must be a numeric cid, got {save_dir_id}")

        result = self._api_call(
            self.client.offline_add_urls,
            {"url": url, "wp_path_id": str(save_dir_id)},
            method="POST",
            type="ssp",
            base_url="https://lixian.115.com",
        )
        if not result:
            return (False, "添加任务失败: 无返回")
        if not result.get("state", False):
            error = result.get("error", "") or result.get("error_msg", "") or "未知错误"
            errno = result.get("errno", 0)
            return (False, f"添加任务失败: {error} (errno={errno})")
        return (True, "")

    def transfer(
        self,
        *,
        url: Any,
        save_dir_id: str,
        allow_duplicate: bool = False,
    ) -> tuple[bool, str]:
        if isinstance(url, BoundTransferUrl):
            normalized_url = str(url)
        elif isinstance(url, str):
            raise ValueError(
                "TRANSFER_BINDING_REQUIRED: bind URLs from a LinkSnapshot before transfer."
            )
        else:
            raise ValueError(f"url must be a bound transfer URL or string, got {url}")
        if not isinstance(save_dir_id, (str, int)) or not str(save_dir_id).isdigit():
            raise ValueError(f"save_dir_id must be a numeric cid, got {save_dir_id}")

        save_dir_id_str = str(save_dir_id)
        if normalized_url.startswith(("https://115cdn.com/s/", "https://115.com/s/")):
            return self.transfer_115(url=normalized_url, save_dir_id=save_dir_id_str)
        if normalized_url.startswith("magnet:?xt=urn:btih:"):
            return self.transfer_magnet(url=normalized_url, save_dir_id=save_dir_id_str)
        raise ValueError(f"unrecognized url type: {normalized_url[:50]}...")

    def execute_transfer_plan(
        self, *, plan: TransferPlan, save_dir_id: str
    ) -> List[Dict[str, Any]]:
        if not isinstance(plan, TransferPlan):
            raise ValueError("plan must be a TransferPlan")

        results: List[Dict[str, Any]] = []
        for url in plan.to_urls():
            success, message = self.transfer(url=url, save_dir_id=save_dir_id)
            results.append(
                {
                    "success": success,
                    "message": message,
                    "url": str(url),
                    "title": getattr(url, "title", ""),
                    "snapshot_id": getattr(url, "snapshot_id", ""),
                    "link_index": getattr(url, "link_index", None),
                }
            )
        return results

    def move_items(self, *, item_ids: List[str], target_dir_id: str) -> Dict[str, List[str]]:
        if not item_ids:
            return {"moved": [], "failed": []}
        if not isinstance(target_dir_id, (str, int)) or not str(target_dir_id).isdigit():
            raise ValueError(f"target_dir_id must be a numeric cid, got {target_dir_id}")

        normalized_ids = [str(item_id) for item_id in item_ids]
        self._api_call(self.client.fs_move, normalized_ids, str(target_dir_id))
        return {"moved": normalized_ids, "failed": []}

    def delete_files_by_fids(self, *, fids: List[str]) -> Dict[str, List[str]]:
        if not fids:
            return {"deleted": [], "failed": []}

        normalized_fids = [str(fid) for fid in fids]
        self.client.fs_delete(normalized_fids)
        return {"deleted": normalized_fids, "failed": []}

    def delete_snapshot_files(
        self, *, indices: List[int], snapshot: FileSnapshot, dry_run: bool = False
    ) -> Dict[str, Any]:
        if not isinstance(snapshot, FileSnapshot):
            return {
                "ok": False,
                "code": "INVALID_INPUT",
                "deleted": [],
                "failed": ["snapshot must be a FileSnapshot"],
                "skipped": [],
            }
        if not isinstance(indices, list) or any(not isinstance(i, int) for i in indices):
            return {
                "ok": False,
                "code": "INVALID_INPUT",
                "deleted": [],
                "failed": ["indices must be a list[int]"],
                "skipped": [],
            }
        if snapshot.is_consumed():
            return {
                "ok": False,
                "code": "SNAPSHOT_ALREADY_USED",
                "deleted": [],
                "failed": [],
                "skipped": [],
            }
        if not indices:
            return {
                "ok": True,
                "code": "NOOP",
                "deleted": [],
                "failed": [],
                "skipped": [],
            }

        unique_indices = sorted(set(indices), reverse=True)
        fids_to_delete: List[str] = []
        deleted_names: List[str] = []
        skipped: List[Dict[str, object]] = []

        for index in unique_indices:
            if 0 <= index < len(snapshot.items):
                file_info = snapshot.items[index]
                fid = file_info.get("file_id") or file_info.get("fid")
                name = file_info.get("name", "unknown")
                if fid:
                    fids_to_delete.append(str(fid))
                    deleted_names.append(name)
                else:
                    skipped.append(
                        {"index": index, "name": name, "reason": "missing fid"}
                    )
            else:
                skipped.append({"index": index, "reason": "index out of range"})

        if dry_run:
            return {
                "ok": True,
                "code": "DRY_RUN",
                "deleted": [],
                "failed": [],
                "skipped": skipped,
            }

        if not fids_to_delete:
            return {
                "ok": True,
                "code": "NOOP",
                "deleted": [],
                "failed": [],
                "skipped": skipped,
            }

        self.client.fs_delete(fids_to_delete)
        snapshot.mark_consumed()
        return {
            "ok": True,
            "code": "OK",
            "deleted": deleted_names,
            "failed": [],
            "skipped": skipped,
        }

    def flatten_directory(
        self,
        *,
        dir_id: str,
        min_video_size_mb: int = 10,
        video_exts: tuple = (
            ".mp4",
            ".mkv",
            ".avi",
            ".mov",
            ".wmv",
            ".flv",
            ".webm",
            ".m4v",
            ".mpg",
            ".mpeg",
            ".ts",
            ".m2ts",
        ),
    ) -> Dict[str, List[str]]:
        dir_id = self._assert_safe_flatten_target(dir_id)

        min_bytes = min_video_size_mb * 1024 * 1024
        video_exts_set = {ext.lower() for ext in video_exts}

        def find_all_videos(current_id: str) -> List[Dict[str, Any]]:
            items = self._get_all_items(current_id)
            videos: List[Dict[str, Any]] = []
            for item in items:
                fc = item.get("fc", "")
                is_dir = fc == "0" or fc == 0
                if is_dir:
                    videos.extend(find_all_videos(item.get("cid", "")))
                    continue

                name = item.get("n", "").lower()
                if any(name.endswith(ext) for ext in video_exts_set):
                    try:
                        size_bytes = int(item.get("s", 0))
                    except (TypeError, ValueError):
                        size_bytes = 0
                    videos.append(
                        {
                            "fid": item.get("fid"),
                            "name": item.get("n"),
                            "size": size_bytes,
                            "source_cid": current_id,
                        }
                    )
            return videos

        all_videos = find_all_videos(str(dir_id))
        move_candidates = [
            item
            for item in all_videos
            if item.get("fid")
            and item.get("source_cid") != str(dir_id)
            and int(item.get("size", 0)) >= min_bytes
        ]

        moved_files: List[str] = []
        move_failed: List[str] = []
        if move_candidates:
            candidate_fids = [str(item["fid"]) for item in move_candidates]
            candidate_name_by_fid = {
                str(item["fid"]): item.get("name", "?") for item in move_candidates
            }
            try:
                self._api_call(self.client.fs_move, candidate_fids, str(dir_id))
                for fid in candidate_fids:
                    moved_files.append(candidate_name_by_fid.get(fid, "?"))
            except Exception as exc:
                for fid in candidate_fids:
                    move_failed.append(f"{candidate_name_by_fid.get(fid, '?')} (error: {exc})")

        def folder_contains_large_video(current_id: str) -> bool:
            items = self._get_all_items(current_id)
            for item in items:
                fc = item.get("fc", "")
                is_dir = fc == "0" or fc == 0
                if is_dir:
                    if folder_contains_large_video(item.get("cid", "")):
                        return True
                    continue

                name = item.get("n", "").lower()
                if any(name.endswith(ext) for ext in video_exts_set):
                    try:
                        size_bytes = int(item.get("s", 0))
                    except (TypeError, ValueError):
                        size_bytes = 0
                    if size_bytes >= min_bytes:
                        return True
            return False

        root_items = self._get_all_items(str(dir_id))
        folders_to_delete: List[Dict[str, str]] = []
        for item in root_items:
            fc = item.get("fc", "")
            is_dir = fc == "0" or fc == 0
            if not is_dir:
                continue
            child_cid = item.get("cid", "")
            if not folder_contains_large_video(child_cid):
                folders_to_delete.append({"cid": child_cid, "name": item.get("n", "?")})

        removed_dirs = [item["name"] for item in folders_to_delete]
        remove_failed: List[str] = []
        if folders_to_delete:
            try:
                self._api_call(
                    self.client.fs_delete,
                    [item["cid"] for item in folders_to_delete],
                )
            except Exception as exc:
                remove_failed.append(f"batch error: {exc}")
                removed_dirs = []

        result: Dict[str, List[str]] = {"moved": moved_files, "removed": removed_dirs}
        if move_failed:
            result["move_failed"] = move_failed
        if remove_failed:
            result["remove_failed"] = remove_failed
        return result
