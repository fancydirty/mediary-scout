import os
import sys
import unittest
from unittest.mock import patch


def load_pan115_module(test_case: unittest.TestCase):
    try:
        scripts_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "scripts")
        )
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        import pan115_client  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised in red phase
        test_case.fail(f"pan115_client module is not implemented yet: {exc}")
    return pan115_client


class FakeP115Client:
    def __init__(self, cookies, check_for_relogin):
        self.cookies = cookies
        self.check_for_relogin = check_for_relogin
        self.headers = {}


class FakeP115ClientWithFiles(FakeP115Client):
    def __init__(self, cookies, check_for_relogin):
        super().__init__(cookies, check_for_relogin)
        self.mkdir_calls = []
        self.share_calls = []
        self.offline_calls = []
        self.move_calls = []
        self.delete_calls = []
        self.responses = {
            "root": {
                "state": True,
                "count": 3,
                "path": [{"name": "root"}],
                "data": [
                    {"cid": "season-1", "fc": "0", "n": "Season 1"},
                    {"fid": "video-1", "fc": "1", "n": "episode01.mkv", "s": "1000"},
                    {"fid": "text-1", "fc": "1", "n": "notes.txt", "s": "50"},
                ],
            },
            "season-1": {
                "state": True,
                "count": 1,
                "path": [{"name": "root"}, {"name": "Season 1"}],
                "data": [
                    {"fid": "video-2", "fc": "1", "n": "episode02.mp4", "s": "2000"},
                ],
            },
            "show-safe": {
                "state": True,
                "count": 1,
                "path": [
                    {"name": "root", "cid": "0"},
                    {"name": "Test", "cid": "test-parent"},
                    {"name": "Demo Show (2026)", "cid": "show-safe"},
                ],
                "data": [
                    {"cid": "season-safe", "fc": "0", "n": "Season 1"},
                ],
            },
            "season-safe": {
                "state": True,
                "count": 3,
                "path": [
                    {"name": "root", "cid": "0"},
                    {"name": "Test", "cid": "test-parent"},
                    {"name": "Demo Show (2026)", "cid": "show-safe"},
                    {"name": "Season 1", "cid": "season-safe"},
                ],
                "data": [
                    {"cid": "nested-pack", "fc": "0", "n": "nested-pack"},
                    {"fid": "video-safe-1", "fc": "1", "n": "episode01.mkv", "s": "1000"},
                    {"fid": "note-safe-1", "fc": "1", "n": "notes.txt", "s": "50"},
                ],
            },
            "nested-pack": {
                "state": True,
                "count": 1,
                "path": [
                    {"name": "root", "cid": "0"},
                    {"name": "Test", "cid": "test-parent"},
                    {"name": "Demo Show (2026)", "cid": "show-safe"},
                    {"name": "Season 1", "cid": "season-safe"},
                    {"name": "nested-pack", "cid": "nested-pack"},
                ],
                "data": [
                    {"fid": "video-safe-2", "fc": "1", "n": "episode02.mp4", "s": "2000"},
                ],
            },
            "movie-safe": {
                "state": True,
                "count": 3,
                "path": [
                    {"name": "root", "cid": "0"},
                    {"name": "clawd_media", "cid": "media-root"},
                    {"name": "Movies", "cid": "movies-parent"},
                    {"name": "Demo Movie (2026)", "cid": "movie-safe"},
                ],
                "data": [
                    {"cid": "movie-pack", "fc": "0", "n": "movie-pack"},
                    {"fid": "movie-safe-1", "fc": "1", "n": "Demo.Movie.2026.1080p.mkv", "s": "3000"},
                    {"fid": "movie-note-1", "fc": "1", "n": "readme.txt", "s": "20"},
                ],
            },
            "movie-pack": {
                "state": True,
                "count": 1,
                "path": [
                    {"name": "root", "cid": "0"},
                    {"name": "clawd_media", "cid": "media-root"},
                    {"name": "Movies", "cid": "movies-parent"},
                    {"name": "Demo Movie (2026)", "cid": "movie-safe"},
                    {"name": "movie-pack", "cid": "movie-pack"},
                ],
                "data": [
                    {"fid": "movie-safe-2", "fc": "1", "n": "Demo.Movie.2026.2160p.mkv", "s": "5000"},
                ],
            },
        }

    def fs_files(self, payload):
        if isinstance(payload, str):
            return self.responses.get(
                payload,
                {
                    "state": True,
                    "count": 0,
                    "data": [],
                },
            )
        return self.responses.get(
            payload["cid"],
            {
                "state": True,
                "count": 0,
                "data": [],
            },
        )

    def fs_mkdir(self, name, parent_id):
        self.mkdir_calls.append((name, parent_id))
        return {"cid": "new-folder-cid"}

    def share_receive_app(self, payload):
        self.share_calls.append(payload)
        return {"state": True}

    def offline_add_urls(self, payload, **kwargs):
        self.offline_calls.append((payload, kwargs))
        return {"state": True}

    def fs_move(self, payload, pid, **kwargs):
        self.move_calls.append((payload, pid, kwargs))
        normalized_ids = [str(item_id) for item_id in payload]
        moved_items = []
        for response in self.responses.values():
            data = response.get("data", [])
            keep = []
            for item in data:
                item_id = str(item.get("fid") or item.get("cid") or "")
                if item_id in normalized_ids:
                    moved_items.append(item)
                else:
                    keep.append(item)
            response["data"] = keep
            response["count"] = len(keep)

        target = self.responses.setdefault(pid, {"state": True, "count": 0, "data": []})
        target.setdefault("state", True)
        target.setdefault("data", [])
        target["data"].extend(moved_items)
        target["count"] = len(target["data"])
        return {"state": True}

    def fs_delete(self, payload, **kwargs):
        self.delete_calls.append((payload, kwargs))
        normalized_ids = {str(item_id) for item_id in payload}
        for cid, response in list(self.responses.items()):
            data = response.get("data", [])
            keep = []
            for item in data:
                item_id = str(item.get("fid") or item.get("cid") or "")
                if item_id not in normalized_ids:
                    keep.append(item)
            response["data"] = keep
            response["count"] = len(keep)
            if cid in normalized_ids:
                self.responses.pop(cid, None)
        return {"state": True}


class Pan115ClientFieldNormalizationTests(unittest.TestCase):
    """TDD tests for normalizing 115 raw API fields to friendly names.

    Raw 115 API returns: n=name, s=size, fid=file_id
    We want the client to expose normalized keys so callers can use
    file["name"], file["size"], file["file_id"] consistently.
    """

    def test_list_files_exposes_normalized_name(self):
        pan115_client = load_pan115_module(self)
        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()
        client._min_interval = 0
        files = client.list_files(cid="root", depth=1)
        self.assertEqual(files[0]["name"], "Season 1")

    def test_list_video_files_exposes_normalized_name_and_size(self):
        pan115_client = load_pan115_module(self)
        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()
        client._min_interval = 0
        files = client.list_video_files(cid="root", depth=1)
        self.assertEqual(files[0]["name"], "episode01.mkv")
        self.assertEqual(files[0]["size"], "1000")

    def test_list_files_preserves_raw_keys_for_backward_compatibility(self):
        pan115_client = load_pan115_module(self)
        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()
        client._min_interval = 0
        files = client.list_files(cid="root", depth=1)
        self.assertEqual(files[0]["n"], "Season 1")
        self.assertEqual(files[0]["cid"], "season-1")


class Pan115ClientConfigTests(unittest.TestCase):
    def test_explicit_cookie_takes_priority(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115Client):
                client = pan115_client.Pan115Client(cookie="explicit-cookie")

        self.assertEqual(client.cookie_str, "explicit-cookie")
        self.assertEqual(client.client.cookies, "explicit-cookie")

    def test_env_cookie_is_used_when_constructor_cookie_missing(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115Client):
                client = pan115_client.Pan115Client()

        self.assertEqual(client.cookie_str, "env-cookie")
        self.assertEqual(client.client.cookies, "env-cookie")

    def test_missing_cookie_raises_clear_error(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115Client):
                with self.assertRaises(ValueError) as ctx:
                    pan115_client.Pan115Client()

        self.assertIn("PAN115_COOKIE", str(ctx.exception))

    def test_constructor_sets_expected_headers_on_underlying_client(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115Client):
                client = pan115_client.Pan115Client()

        self.assertEqual(client.client.headers["referer"], "https://115.com/")
        self.assertEqual(client.client.headers["origin"], "https://115.com")
        self.assertTrue(client.client.check_for_relogin)


class Pan115ClientListingTests(unittest.TestCase):
    def test_list_files_depth_1_returns_current_level_items_only(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        files = client.list_files(cid="root", depth=1)

        self.assertEqual(len(files), 3)
        self.assertEqual(files[0]["name"], "Season 1")
        self.assertEqual(files[0]["children"], [])

    def test_list_files_defaults_to_depth_1(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        files = client.list_files(cid="root")

        self.assertEqual(len(files), 3)
        self.assertEqual(files[0]["children"], [])

    def test_list_files_depth_2_includes_nested_children(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        files = client.list_files(cid="root", depth=2)

        self.assertEqual(len(files), 3)
        self.assertEqual(files[0]["name"], "Season 1")
        self.assertEqual(len(files[0]["children"]), 1)
        self.assertEqual(files[0]["children"][0]["name"], "episode02.mp4")

    def test_list_files_rejects_recursive_scan_on_protected_directory(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(
            os.environ,
            {"PAN115_COOKIE": "env-cookie", "TV_SHOWS_CID": "root"},
            clear=True,
        ):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()
                client._min_interval = 0
                with self.assertRaises(ValueError) as ctx:
                    client.list_files(cid="root", depth=2)

        self.assertIn("SAFETY_VIOLATION", str(ctx.exception))

    def test_list_video_files_depth_1_stays_shallow(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        files = client.list_video_files(cid="root", depth=1)

        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["name"], "episode01.mkv")

    def test_list_video_files_depth_2_includes_one_nested_level(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        files = client.list_video_files(cid="root", depth=2)

        self.assertEqual(len(files), 2)
        self.assertEqual(files[0]["name"], "episode02.mp4")
        self.assertEqual(files[1]["name"], "episode01.mkv")

    def test_list_video_files_snapshot_freezes_current_results(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        snapshot = client.list_video_files_snapshot(cid="root", depth=2)

        self.assertEqual(len(snapshot), 2)
        self.assertFalse(snapshot.is_consumed())
        self.assertEqual(snapshot[0]["name"], "episode02.mp4")
        snapshot.mark_consumed()
        self.assertTrue(snapshot.is_consumed())

    def test_get_file_info_returns_raw_directory_payload(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        info = client.get_file_info("season-1")

        self.assertTrue(info["state"])
        self.assertEqual(info["path"][-1]["name"], "Season 1")

    def test_get_path_joins_path_segments(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        path = client.get_path("season-1")

        self.assertEqual(path, "root/Season 1")

    def test_preview_snapshot_deletions_splits_delete_and_keep_lists(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        snapshot = client.list_video_files_snapshot(cid="root", depth=2)
        result = client.preview_snapshot_deletions(indices=[1], snapshot=snapshot)

        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], "OK")
        self.assertEqual(len(result["to_delete"]), 1)
        self.assertEqual(result["to_delete"][0]["name"], "episode01.mkv")
        self.assertEqual(len(result["to_keep"]), 1)
        self.assertEqual(result["to_keep"][0]["name"], "episode02.mp4")

    def test_preview_snapshot_deletions_rejects_invalid_input(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        result = client.preview_snapshot_deletions(indices=["1"], snapshot="bad")

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "INVALID_INPUT")


class Pan115ClientWriteMethodTests(unittest.TestCase):
    def test_create_folder_returns_new_cid(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        cid = client.create_folder(name="Transfer Test", parent_id="123")

        self.assertEqual(cid, "new-folder-cid")
        self.assertEqual(client.client.mkdir_calls[0], ("Transfer Test", "123"))

    def test_transfer_rejects_unbound_raw_url_by_default(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        with self.assertRaises(ValueError) as ctx:
            client.transfer(
                url="https://115cdn.com/s/abc123?password=pass",
                save_dir_id="123",
            )

        self.assertIn("TRANSFER_BINDING_REQUIRED", str(ctx.exception))
        self.assertEqual(client.client.share_calls, [])

    def test_transfer_accepts_bound_115_url(self):
        pan115_client = load_pan115_module(self)
        scripts_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "scripts")
        )
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        import pansou_client  # type: ignore

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        snapshot = pansou_client.LinkSnapshot(
            [
                {
                    "title": "Bound Resource",
                    "type": "115",
                    "url": "https://115cdn.com/s/abc123?password=pass",
                    "password": "pass",
                    "datetime": "",
                    "source": "demo",
                }
            ]
        )
        chosen_url = snapshot.bind_indices([0])[0]

        success, message = client.transfer(url=chosen_url, save_dir_id="123")

        self.assertTrue(success)
        self.assertEqual(message, "")
        self.assertEqual(client.client.share_calls[0]["share_code"], "abc123")
        self.assertEqual(client.client.share_calls[0]["receive_code"], "pass")
        self.assertEqual(client.client.share_calls[0]["cid"], "123")

    def test_transfer_accepts_bound_magnet_url(self):
        pan115_client = load_pan115_module(self)
        scripts_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "scripts")
        )
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        import pansou_client  # type: ignore

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        snapshot = pansou_client.LinkSnapshot(
            [
                {
                    "title": "Bound Magnet",
                    "type": "magnet",
                    "url": "magnet:?xt=urn:btih:abcdef123456",
                    "password": "",
                    "datetime": "",
                    "source": "demo",
                }
            ]
        )
        chosen_url = snapshot.bind_indices([0])[0]

        success, message = client.transfer(url=chosen_url, save_dir_id="123")

        self.assertTrue(success)
        self.assertEqual(message, "")
        self.assertEqual(
            client.client.offline_calls[0][0],
            {"url": "magnet:?xt=urn:btih:abcdef123456", "wp_path_id": "123"},
        )

    def test_execute_transfer_plan_runs_bound_urls_without_rebinding(self):
        pan115_client = load_pan115_module(self)
        scripts_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "scripts")
        )
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        import pansou_client  # type: ignore

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        snapshot = pansou_client.LinkSnapshot(
            [
                {
                    "title": "Plan Item A",
                    "type": "115",
                    "url": "https://115cdn.com/s/abc123?password=pass",
                    "password": "pass",
                    "datetime": "",
                    "source": "demo",
                },
                {
                    "title": "Plan Item B",
                    "type": "magnet",
                    "url": "magnet:?xt=urn:btih:abcdef123456",
                    "password": "",
                    "datetime": "",
                    "source": "demo",
                },
            ]
        )
        plan = snapshot.create_transfer_plan([0, 1], keyword="白日提灯")

        results = client.execute_transfer_plan(plan=plan, save_dir_id="123")

        self.assertEqual(len(results), 2)
        self.assertTrue(results[0]["success"])
        self.assertTrue(results[1]["success"])
        self.assertEqual(client.client.share_calls[0]["share_code"], "abc123")
        self.assertEqual(
            client.client.offline_calls[0][0],
            {"url": "magnet:?xt=urn:btih:abcdef123456", "wp_path_id": "123"},
        )

    def test_move_items_calls_fs_move(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        result = client.move_items(item_ids=["100", "200"], target_dir_id="999")

        self.assertEqual(result["moved"], ["100", "200"])
        self.assertEqual(result["failed"], [])
        self.assertEqual(client.client.move_calls[0][0], ["100", "200"])
        self.assertEqual(client.client.move_calls[0][1], "999")

    def test_delete_snapshot_files_dry_run_does_not_delete(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        snapshot = client.list_video_files_snapshot(cid="root", depth=2)
        result = client.delete_snapshot_files(indices=[1], snapshot=snapshot, dry_run=True)

        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], "DRY_RUN")
        self.assertEqual(client.client.delete_calls, [])
        self.assertFalse(snapshot.is_consumed())

    def test_delete_snapshot_files_executes_by_fid_and_consumes_snapshot(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        snapshot = client.list_video_files_snapshot(cid="root", depth=2)
        result = client.delete_snapshot_files(indices=[1], snapshot=snapshot)

        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], "OK")
        self.assertEqual(result["deleted"], ["episode01.mkv"])
        self.assertEqual(client.client.delete_calls[0][0], ["video-1"])
        self.assertTrue(snapshot.is_consumed())

    def test_flatten_directory_moves_nested_videos_and_removes_empty_dirs(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        result = client.flatten_directory(dir_id="season-safe", min_video_size_mb=0)
        season_after = client.list_files(cid="season-safe", depth=1)

        self.assertIn("episode02.mp4", result["moved"])
        self.assertIn("nested-pack", result["removed"])
        self.assertEqual(len(season_after), 3)
        self.assertEqual(season_after[0]["name"], "episode01.mkv")
        self.assertEqual(season_after[1]["name"], "notes.txt")
        self.assertEqual(season_after[2]["name"], "episode02.mp4")

    def test_flatten_directory_rejects_root_directory(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        with self.assertRaises(ValueError) as ctx:
            client.flatten_directory(dir_id="0", min_video_size_mb=0)

        self.assertIn("SAFETY_VIOLATION", str(ctx.exception))
        self.assertEqual(client.client.move_calls, [])
        self.assertEqual(client.client.delete_calls, [])

    def test_flatten_directory_rejects_configured_protected_directory(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(
            os.environ,
            {"PAN115_COOKIE": "env-cookie", "TV_SHOWS_CID": "season-safe"},
            clear=True,
        ):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()
                client._min_interval = 0
                with self.assertRaises(ValueError) as ctx:
                    client.flatten_directory(dir_id="season-safe", min_video_size_mb=0)

        self.assertIn("protected directory", str(ctx.exception))
        self.assertEqual(client.client.move_calls, [])
        self.assertEqual(client.client.delete_calls, [])

    def test_flatten_directory_rejects_non_season_directory(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(os.environ, {"PAN115_COOKIE": "env-cookie"}, clear=True):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

        client._min_interval = 0
        with self.assertRaises(ValueError) as ctx:
            client.flatten_directory(dir_id="show-safe", min_video_size_mb=0)

        self.assertIn("movie leaf under MOVIES_CID", str(ctx.exception))
        self.assertEqual(client.client.move_calls, [])
        self.assertEqual(client.client.delete_calls, [])

    def test_flatten_directory_allows_movie_leaf_directory(self):
        pan115_client = load_pan115_module(self)

        with patch.dict(
            os.environ,
            {"PAN115_COOKIE": "env-cookie", "MOVIES_CID": "movies-parent"},
            clear=True,
        ):
            with patch.object(pan115_client, "P115Client", FakeP115ClientWithFiles):
                client = pan115_client.Pan115Client()

                client._min_interval = 0
                result = client.flatten_directory(dir_id="movie-safe", min_video_size_mb=0)
                movie_after = client.list_files(cid="movie-safe", depth=1)

        self.assertIn("Demo.Movie.2026.2160p.mkv", result["moved"])
        self.assertIn("movie-pack", result["removed"])
        self.assertEqual(len(movie_after), 3)
        self.assertEqual(movie_after[0]["name"], "Demo.Movie.2026.1080p.mkv")
        self.assertEqual(movie_after[1]["name"], "readme.txt")
        self.assertEqual(movie_after[2]["name"], "Demo.Movie.2026.2160p.mkv")


if __name__ == "__main__":
    unittest.main()
