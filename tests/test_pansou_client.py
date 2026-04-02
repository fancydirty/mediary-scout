import os
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import requests


def load_pansou_module(test_case: unittest.TestCase):
    try:
        scripts_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "scripts")
        )
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        import pansou_client  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised in red phase
        test_case.fail(f"pansou_client module is not implemented yet: {exc}")
    return pansou_client


class FakeJSONResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class PansouClientConfigTests(unittest.TestCase):
    def test_explicit_base_url_takes_priority(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient(base_url="http://explicit.example")

        self.assertEqual(client.base_url, "http://explicit.example")

    def test_env_base_url_is_used_when_constructor_value_missing(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient()

        self.assertEqual(client.base_url, "http://env.example")

    def test_missing_base_url_raises_clear_error(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError) as ctx:
                pansou_client.PansouClient()

        self.assertIn("PANSOU_BASE_URL", str(ctx.exception))


class PansouClientFailureModeTests(unittest.TestCase):
    def test_search_propagates_request_errors(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient()

        client.session.post = Mock(side_effect=requests.exceptions.ConnectionError("boom"))

        with self.assertRaises(requests.exceptions.ConnectionError):
            client.search("太平年")


class PansouTransferBindingTests(unittest.TestCase):
    def setUp(self):
        pansou_client = load_pansou_module(self)
        pansou_client._SEARCH_CACHE.clear()
        cache_path = os.path.join(tempfile.gettempdir(), "pansou-cache-test.json")
        if os.path.exists(cache_path):
            os.remove(cache_path)

    def test_search_reuses_cached_results_for_same_keyword_within_ttl(self):
        pansou_client = load_pansou_module(self)

        first_payload = {
            "code": 0,
            "data": {
                "results": [
                    {
                        "title": "Result A",
                        "channel": "demo",
                        "links": [{"type": "115", "url": "https://115cdn.com/s/a"}],
                    },
                    {
                        "title": "Result B",
                        "channel": "demo",
                        "links": [{"type": "115", "url": "https://115cdn.com/s/b"}],
                    },
                ]
            },
        }
        reordered_payload = {
            "code": 0,
            "data": {
                "results": [
                    {
                        "title": "Result B",
                        "channel": "demo",
                        "links": [{"type": "115", "url": "https://115cdn.com/s/b"}],
                    },
                    {
                        "title": "Result A",
                        "channel": "demo",
                        "links": [{"type": "115", "url": "https://115cdn.com/s/a"}],
                    },
                ]
            },
        }

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient(
                cache_path=os.path.join(tempfile.gettempdir(), "pansou-cache-test.json")
            )
        client.session.post = Mock(
            side_effect=[FakeJSONResponse(first_payload), FakeJSONResponse(reordered_payload)]
        )

        first_result = client.search("白日提灯")
        second_result = client.search("白日提灯")
        first_snapshot = client.extract_link_snapshot(first_result["115"], link_type="115")
        second_snapshot = client.extract_link_snapshot(second_result["115"], link_type="115")

        self.assertEqual(client.session.post.call_count, 1)
        self.assertEqual(first_snapshot.snapshot_id, second_snapshot.snapshot_id)
        self.assertEqual(first_snapshot[0]["title"], "Result A")
        self.assertEqual(second_snapshot[0]["title"], "Result A")

    def test_snapshot_can_create_transfer_plan(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient()

        results = [
            {
                "title": "Demo Resource A",
                "channel": "demo",
                "links": [
                    {
                        "type": "115",
                        "url": "https://115cdn.com/s/resource-a?password=aaa",
                        "password": "aaa",
                    }
                ],
            },
            {
                "title": "Demo Resource B",
                "channel": "demo",
                "links": [
                    {
                        "type": "115",
                        "url": "https://115cdn.com/s/resource-b?password=bbb",
                        "password": "bbb",
                    }
                ],
            },
        ]

        snapshot = client.extract_link_snapshot(results, link_type="115")
        plan = snapshot.create_transfer_plan([1, 0], keyword="白日提灯")

        self.assertEqual(plan.snapshot_id, snapshot.snapshot_id)
        self.assertEqual(plan.keyword, "白日提灯")
        self.assertEqual(len(plan), 2)
        self.assertEqual(str(plan[0]), "https://115cdn.com/s/resource-b?password=bbb")
        self.assertEqual(str(plan[1]), "https://115cdn.com/s/resource-a?password=aaa")

    def test_search_cache_survives_new_client_via_cache_file(self):
        pansou_client = load_pansou_module(self)

        first_payload = {
            "code": 0,
            "data": {
                "results": [
                    {
                        "title": "Result A",
                        "channel": "demo",
                        "links": [{"type": "115", "url": "https://115cdn.com/s/a"}],
                    }
                ]
            },
        }
        reordered_payload = {
            "code": 0,
            "data": {
                "results": [
                    {
                        "title": "Result B",
                        "channel": "demo",
                        "links": [{"type": "115", "url": "https://115cdn.com/s/b"}],
                    }
                ]
            },
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            cache_path = os.path.join(temp_dir, "pansou-cache.json")

            with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
                first_client = pansou_client.PansouClient(cache_path=cache_path)
            first_client.session.post = Mock(side_effect=[FakeJSONResponse(first_payload)])
            first_result = first_client.search("白日提灯")

            pansou_client._SEARCH_CACHE.clear()

            with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
                second_client = pansou_client.PansouClient(cache_path=cache_path)
            second_client.session.post = Mock(side_effect=[FakeJSONResponse(reordered_payload)])
            second_result = second_client.search("白日提灯")

            first_snapshot = first_client.extract_link_snapshot(first_result["115"], link_type="115")
            second_snapshot = second_client.extract_link_snapshot(second_result["115"], link_type="115")

        self.assertEqual(first_client.session.post.call_count, 1)
        self.assertEqual(second_client.session.post.call_count, 0)
        self.assertEqual(first_snapshot.snapshot_id, second_snapshot.snapshot_id)
        self.assertEqual(second_snapshot[0]["title"], "Result A")

    def test_extract_link_snapshot_binds_stable_urls(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient()

        results = [
            {
                "title": "Demo Resource A",
                "channel": "demo",
                "links": [
                    {
                        "type": "115",
                        "url": "https://115cdn.com/s/resource-a?password=aaa",
                        "password": "aaa",
                    }
                ],
            },
            {
                "title": "Demo Resource B",
                "channel": "demo",
                "links": [
                    {
                        "type": "115",
                        "url": "https://115cdn.com/s/resource-b?password=bbb",
                        "password": "bbb",
                    }
                ],
            },
        ]

        snapshot = client.extract_link_snapshot(results, link_type="115")
        chosen_urls = snapshot.bind_indices([1])

        self.assertEqual(len(snapshot), 2)
        self.assertEqual(len(chosen_urls), 1)
        self.assertEqual(str(chosen_urls[0]), "https://115cdn.com/s/resource-b?password=bbb")
        self.assertEqual(chosen_urls[0].snapshot_id, snapshot.snapshot_id)
        self.assertEqual(chosen_urls[0].link_index, 1)

    def test_bound_urls_survive_reordered_follow_up_snapshot(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient()

        results = [
            {
                "title": "Demo Resource A",
                "channel": "demo",
                "links": [
                    {
                        "type": "115",
                        "url": "https://115cdn.com/s/resource-a?password=aaa",
                        "password": "aaa",
                    }
                ],
            },
            {
                "title": "Demo Resource B",
                "channel": "demo",
                "links": [
                    {
                        "type": "115",
                        "url": "https://115cdn.com/s/resource-b?password=bbb",
                        "password": "bbb",
                    }
                ],
            },
        ]

        first_snapshot = client.extract_link_snapshot(results, link_type="115")
        chosen_urls = first_snapshot.bind_indices([0])
        reordered_snapshot = client.extract_link_snapshot(
            list(reversed(results)), link_type="115"
        )

        self.assertEqual(str(chosen_urls[0]), "https://115cdn.com/s/resource-a?password=aaa")
        self.assertEqual(str(reordered_snapshot[0]["url"]), "https://115cdn.com/s/resource-b?password=bbb")
        self.assertNotEqual(str(chosen_urls[0]), str(reordered_snapshot[0]["url"]))

    def test_bind_indices_rejects_out_of_range_index(self):
        pansou_client = load_pansou_module(self)

        with patch.dict(os.environ, {"PANSOU_BASE_URL": "http://env.example"}, clear=True):
            client = pansou_client.PansouClient()

        results = [
            {
                "title": "Demo Resource A",
                "channel": "demo",
                "links": [{"type": "115", "url": "https://115cdn.com/s/resource-a"}],
            }
        ]

        snapshot = client.extract_link_snapshot(results, link_type="115")

        with self.assertRaises(IndexError):
            snapshot.bind_indices([3])

    def test_live_search_binding_uses_real_pansou_results(self):
        pansou_client = load_pansou_module(self)

        base_url = os.environ.get("PANSOU_BASE_URL")
        if not base_url:
            env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".env"))
            if os.path.exists(env_path):
                with open(env_path, "r", encoding="utf-8") as handle:
                    for line in handle:
                        if line.startswith("PANSOU_BASE_URL="):
                            base_url = line.split("=", 1)[1].strip()
                            break

        if not base_url:
            self.skipTest("PANSOU_BASE_URL is not available for live integration test")

        client = pansou_client.PansouClient(base_url=base_url)
        result = client.search("庆余年")
        result_bucket = result["115"] or result["magnet"]
        if not result_bucket:
            self.skipTest("Live Pansou search returned no transferable results for test keyword")

        link_type = "115" if result["115"] else "magnet"
        snapshot = client.extract_link_snapshot(result_bucket, link_type=link_type)
        chosen_urls = snapshot.bind_indices([0])
        mirrored_snapshot = client.extract_link_snapshot(
            list(reversed(result_bucket)), link_type=link_type
        )

        self.assertGreater(len(snapshot), 0)
        self.assertEqual(len(chosen_urls), 1)
        self.assertTrue(str(chosen_urls[0]))
        self.assertNotEqual(snapshot.snapshot_id, mirrored_snapshot.snapshot_id)


if __name__ == "__main__":
    unittest.main()
