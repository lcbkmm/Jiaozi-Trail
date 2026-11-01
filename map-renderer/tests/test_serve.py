"""Ensure the browser config cannot fall back to a server-only credential."""

from http.client import HTTPConnection
import json
import os
from pathlib import Path
import sys
from threading import Thread
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from serve import create_server


class BrowserConfigTests(unittest.TestCase):
    def read_config(self, environment):
        with patch.dict(os.environ, environment, clear=True):
            server = create_server(port=0)
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            connection = HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            try:
                connection.request('GET', '/config.json')
                response = connection.getresponse()
                payload = response.read().decode('utf-8')
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                self.assertNotIn('server-only-fixture-key', payload)
                return json.loads(payload)
            finally:
                connection.close()
                server.shutdown()
                server.server_close()
                worker.join(timeout=5)

    def test_server_key_alone_does_not_authorize_browser_sdk(self):
        config = self.read_config({'BAIDU_MAP_AK': 'server-only-fixture-key'})
        self.assertEqual(config['jsAk'], '')
        self.assertEqual(config['keySource'], 'missing')

    def test_only_browser_key_and_style_are_served(self):
        config = self.read_config({
            'BAIDU_MAP_AK': 'server-only-fixture-key',
            'BAIDU_MAP_JS_AK': 'browser-fixture-key',
            'BAIDU_MAP_STYLE_ID': 'test-style',
        })
        self.assertEqual(config['jsAk'], 'browser-fixture-key')
        self.assertEqual(config['keySource'], 'BAIDU_MAP_JS_AK')
        self.assertEqual(config['styleId'], 'test-style')


if __name__ == '__main__':
    unittest.main()
