#!/usr/bin/env python3
"""Serve the local Baidu vector-map preview without exposing local secrets.

Standard library only. Browser AKs are intentionally supplied to the same-origin
preview. Dotfiles, source/tests, directory listings, and cross-origin requests
are inaccessible. Only the same-origin planning API accepts bounded JSON writes.
"""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

from fetch_scene import load_dotenv
from planning_backend import PlanningBackend, allowed_endpoint


ROOT = Path(__file__).resolve().parents[1]


def _private_part(part):
    # Windows normalizes trailing dots/spaces in ordinary file paths.
    normalized = part.rstrip(' .').lower()
    return (part.startswith('.') or not normalized or normalized in ('scripts', 'tests')
            or normalized.endswith(('.py', '.pyc', '.pyo')) or ':' in part or '\x00' in part)


class PreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, root=ROOT, **kwargs):
        self.root = Path(root).resolve()
        super().__init__(*args, directory=str(self.root), **kwargs)

    def log_message(self, format, *args):
        # Never log request query strings, API keys, or upstream URLs.
        return

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, status, payload, *, head=False):
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def _local_url(self, value, *, origin=False):
        try:
            parsed = urlsplit(value)
            return (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1')
                    and parsed.port == self.server.server_port and not parsed.username and not parsed.password
                    and (not origin or parsed.path in ('', '/')) and not parsed.fragment
                    and (not origin or not parsed.query))
        except (ValueError, AttributeError):
            return False

    def _same_origin(self):
        # Host validation also rejects DNS-rebinding hosts that resolve to loopback.
        if not self._local_url('http://' + self.headers.get('Host', ''), origin=True):
            return False
        origin, referer = self.headers.get('Origin'), self.headers.get('Referer')
        if origin is not None and not self._local_url(origin, origin=True):
            return False
        if referer is not None and not self._local_url(referer):
            return False
        return self.headers.get('Sec-Fetch-Site') not in ('cross-site', 'same-site')

    def _safe_path(self):
        try:
            path = unquote(urlsplit(self.path).path, errors='strict').replace('\\', '/')
        except (ValueError, UnicodeDecodeError):
            return None
        parts = [part for part in path.split('/') if part]
        if any(_private_part(part) for part in parts):
            return None
        try:
            target = self.root.joinpath(*parts).resolve()
            relative = target.relative_to(self.root)
        except (ValueError, OSError):
            return None
        # A symlink with an innocuous public name must not expose a private target.
        if any(_private_part(part) for part in relative.parts):
            return None
        return path

    def _planning(self, *, head=False):
        """Forward only known planning endpoints to our private child service."""
        parsed = urlsplit(self.path)
        path = parsed.path[len('/planning'):]
        method = 'GET' if head else self.command
        if not allowed_endpoint(method, path):
            return self._json(404, {'error': {'code': 'RESOURCE_NOT_FOUND', 'message': '路线接口不存在。'}}, head=head)
        body = None
        if method in ('POST', 'PUT'):
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                size = -1
            if self.headers.get('Transfer-Encoding') or not 0 <= size <= 1024 * 1024:
                self.close_connection = True
                return self._json(413, {'error': {'code': 'INVALID_INPUT', 'message': '请求体过大或格式不支持。'}})
            if self.headers.get_content_type() != 'application/json':
                self.close_connection = True
                return self._json(415, {'error': {'code': 'INVALID_INPUT', 'message': '路线接口只接受 JSON。'}})
            body = self.rfile.read(size)
        headers = {key: self.headers[key] for key in ('Content-Type', 'X-Demo-Session', 'Idempotency-Key') if key in self.headers}
        try:
            status, content_type, content = self.server.planning_backend.request(method,
                path + ('?' + parsed.query if parsed.query else ''), headers=headers, body=body)
        except RuntimeError as error:
            return self._json(503, {'error': {'code': 'PLANNING_UNAVAILABLE', 'message': str(error)}}, head=head)
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        if not head:
            self.wfile.write(content)

    def _get(self, *, head=False):
        if not self._same_origin():
            return self._json(403, {'error': 'Only this local preview origin is allowed'}, head=head)
        if urlsplit(self.path).path.startswith('/planning/'):
            return self._planning(head=head)
        path = self._safe_path()
        if path is None:
            return self._json(403, {'error': 'This path is not served'}, head=head)
        if path == '/config.json':
            js_key = os.environ.get('BAIDU_MAP_JS_AK', '').strip()
            key_type = 'BAIDU_MAP_JS_AK' if js_key else 'missing'
            return self._json(200, {
                'jsAk': js_key,
                'type': key_type,
                'keySource': key_type,
                'styleId': os.environ.get('BAIDU_MAP_STYLE_ID', '').strip(),
                'note': 'A browser-type AK is required. Server AKs are not sent to the browser.',
            }, head=head)
        if path == '/':
            self.send_response(302)
            self.send_header('Location', '/baidu-map.html')
            self.send_header('Content-Length', '0')
            return self.end_headers()
        if head:
            return super().do_HEAD()
        return super().do_GET()

    def do_GET(self):
        self._get()

    def do_HEAD(self):
        self._get(head=True)

    def list_directory(self, path):
        self.send_error(404, 'Directory listing is disabled')
        return None

    def do_OPTIONS(self):
        self._json(403, {'error': 'Cross-origin requests are not enabled'})

    def do_POST(self):
        self._write()

    def do_PUT(self):
        self._write()

    def _write(self):
        if not self._same_origin():
            self.close_connection = True
            return self._json(403, {'error': 'Only this local preview origin is allowed'})
        if urlsplit(self.path).path.startswith('/planning/'):
            return self._planning()
        self.close_connection = True
        self._json(405, {'error': 'Only the planning API accepts JSON writes'})


def create_server(port=8765, root=ROOT, planning_backend=None):
    server = ThreadingHTTPServer(('127.0.0.1', port), partial(PreviewHandler, root=Path(root)))
    server.daemon_threads = True
    server.planning_backend = planning_backend if planning_backend is not None else PlanningBackend()
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')
    try:
        load_dotenv(ROOT / '.env')
        server = create_server(args.port)
    except (OSError, ValueError):
        parser.exit(1, 'Could not start the local preview. Check .env syntax and whether the port is available.\n')
    print(f'Local map preview: http://127.0.0.1:{args.port}/baidu-map.html')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.planning_backend.stop()
        server.server_close()


if __name__ == '__main__':
    main()
